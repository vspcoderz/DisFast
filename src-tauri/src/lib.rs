use std::sync::Arc;

use futures_util::StreamExt as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use twilight_gateway::error::ReceiveMessageErrorType;
use twilight_gateway::{Intents, Message, Shard, ShardId};
use twilight_http::Client as HttpClient;
use twilight_model::id::Id;

/// Everything we hold after a successful login.
struct DiscordSession {
    http: Arc<HttpClient>,
    /// DM channels as raw gateway JSON, populated from the READY payload
    /// and kept up to date via CHANNEL_CREATE/CHANNEL_DELETE events.
    /// (twilight's typed `Ready` drops the user-account-only
    /// `private_channels` field, so we keep the raw JSON.)
    dms: SharedDms,
}

type SharedSession = Arc<Mutex<Option<DiscordSession>>>;
type SharedDms = Arc<Mutex<Vec<serde_json::Value>>>;

fn to_json<T: Serialize>(value: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn http(state: &State<'_, SharedSession>) -> Result<Arc<HttpClient>, String> {
    let guard = state.inner().lock().await;
    guard
        .as_ref()
        .map(|s| Arc::clone(&s.http))
        .ok_or_else(|| "not logged in".to_string())
}

/// Gateway loop: receives real-time events from Discord and forwards
/// them to the frontend as Tauri events.
///
/// We consume the shard as a raw JSON stream rather than twilight's
/// typed events: the frontend consumes JSON anyway, and user accounts
/// receive fields (like `READY.private_channels`) that twilight's
/// bot-oriented types discard.
async fn run_gateway(app: AppHandle, token: String, dms: SharedDms) {
    let intents = Intents::GUILDS
        | Intents::GUILD_MESSAGES
        | Intents::DIRECT_MESSAGES
        | Intents::MESSAGE_CONTENT;

    let mut shard = Shard::new(ShardId::ONE, token, intents);

    while let Some(item) = shard.next().await {
        let message = match item {
            Ok(message) => message,
            Err(err) => {
                if matches!(err.kind(), ReceiveMessageErrorType::Reconnect) {
                    // The shard gave up reconnecting; this is fatal.
                    let _ = app.emit("gateway-closed", err.to_string());
                    break;
                }
                // Recoverable (e.g. decompression): shard keeps going.
                continue;
            }
        };

        let Message::Text(json) = message else {
            continue; // binary (shouldn't happen with zlib transport) or close frames
        };

        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&json) else {
            continue;
        };
        let Some(event_type) = payload.get("t").and_then(|t| t.as_str()) else {
            continue; // opcodes without an event name (hello, acks, ...)
        };
        let data = payload.get("d").cloned().unwrap_or(serde_json::Value::Null);

        match event_type {
            "READY" => {
                if let Some(channels) = data.get("private_channels").and_then(|c| c.as_array()) {
                    *dms.lock().await = channels.clone();
                }
                let _ = app.emit("gateway-ready", &data);
            }
            "MESSAGE_CREATE" => {
                let _ = app.emit("message-create", &data);
            }
            "MESSAGE_UPDATE" => {
                let _ = app.emit("message-update", &data);
            }
            "MESSAGE_DELETE" => {
                let _ = app.emit("message-delete", &data);
            }
            "CHANNEL_CREATE" => {
                // type 1 = DM, 3 = group DM
                let kind = data.get("type").and_then(|t| t.as_u64()).unwrap_or(0);
                if kind == 1 || kind == 3 {
                    let id = data.get("id").cloned();
                    let mut guard = dms.lock().await;
                    if !guard.iter().any(|c| c.get("id") == id.as_ref()) {
                        guard.push(data.clone());
                    }
                }
                let _ = app.emit("dm-create", &data);
            }
            "CHANNEL_DELETE" => {
                if let Some(id) = data.get("id") {
                    dms.lock().await.retain(|c| c.get("id") != Some(id));
                }
                let _ = app.emit("dm-delete", &data);
            }
            _ => {}
        }
    }

    let _ = app.emit("gateway-closed", "gateway stream ended");
}

#[tauri::command]
async fn login(
    app: AppHandle,
    state: State<'_, SharedSession>,
    token: String,
) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    let client = Arc::new(HttpClient::new(token.clone()));

    // Validate the token by fetching the current user.
    let user = client
        .current_user()
        .await
        .map_err(|e| format!("invalid token or network error: {e}"))?
        .model()
        .await
        .map_err(|e| e.to_string())?;

    // Start the gateway only once per session.
    let mut guard = state.inner().lock().await;
    let already_connected = guard.is_some();
    let dms: SharedDms = Arc::new(Mutex::new(Vec::new()));
    *guard = Some(DiscordSession {
        http: client,
        dms: Arc::clone(&dms),
    });
    drop(guard);

    if !already_connected {
        let app2 = app.clone();
        tokio::spawn(async move {
            run_gateway(app2, token, dms).await;
        });
    }

    to_json(&user)
}

#[tauri::command]
async fn get_guilds(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let guilds = http
        .current_user_guilds()
        .await
        .map_err(|e| e.to_string())?
        .models()
        .await
        .map_err(|e| e.to_string())?;
    to_json(&guilds)
}

#[tauri::command]
async fn get_dms(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let guard = state.inner().lock().await;
    let session = guard.as_ref().ok_or("not logged in")?;
    let dms = session.dms.lock().await;
    to_json(&*dms)
}

#[tauri::command]
async fn get_channels(
    state: State<'_, SharedSession>,
    guild_id: u64,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let channels = http
        .guild_channels(Id::new(guild_id))
        .await
        .map_err(|e| e.to_string())?
        .models()
        .await
        .map_err(|e| e.to_string())?;
    to_json(&channels)
}

#[tauri::command]
async fn get_messages(
    state: State<'_, SharedSession>,
    channel_id: u64,
    before: Option<u64>,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let base = http.channel_messages(Id::new(channel_id)).limit(50);
    let response = match before {
        Some(before) => base.before(Id::new(before)).await,
        None => base.await,
    };
    let messages = response
        .map_err(|e| e.to_string())?
        .models()
        .await
        .map_err(|e| e.to_string())?;
    to_json(&messages)
}

#[tauri::command]
async fn send_message(
    state: State<'_, SharedSession>,
    channel_id: u64,
    content: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("empty message".to_string());
    }
    let message = http
        .create_message(Id::new(channel_id))
        .content(&content)
        .await
        .map_err(|e| e.to_string())?
        .model()
        .await
        .map_err(|e| e.to_string())?;
    to_json(&message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(None)) as SharedSession)
        .invoke_handler(tauri::generate_handler![
            login,
            get_guilds,
            get_dms,
            get_channels,
            get_messages,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DisFast");
}
