use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use twilight_gateway::{Config, Event, Intents, Shard, ShardId};
use twilight_http::Client as HttpClient;
use twilight_model::id::Id;

/// Everything we hold after a successful login.
struct DiscordSession {
    http: Arc<HttpClient>,
}

type SharedSession = Arc<Mutex<Option<DiscordSession>>>;

fn to_json<T: Serialize>(value: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn session(state: &State<'_, SharedSession>) -> Result<Arc<HttpClient>, String> {
    let guard = state.inner().lock().await;
    guard
        .as_ref()
        .map(|s| Arc::clone(&s.http))
        .ok_or_else(|| "not logged in".to_string())
}

/// Gateway loop: receives real-time events from Discord and forwards
/// them to the frontend as Tauri events.
async fn run_gateway(app: AppHandle, token: String) {
    let intents = Intents::GUILDS
        | Intents::GUILD_MESSAGES
        | Intents::DIRECT_MESSAGES
        | Intents::MESSAGE_CONTENT;

    let config = Config::new(token, intents);
    let mut shard = Shard::new(ShardId::ONE, config);

    loop {
        match shard.next_event().await {
            Ok(Event::MessageCreate(msg)) => {
                let _ = app.emit("message-create", &*msg);
            }
            Ok(Event::MessageUpdate(msg)) => {
                let _ = app.emit("message-update", &*msg);
            }
            Ok(Event::MessageDelete(msg)) => {
                let _ = app.emit("message-delete", &*msg);
            }
            Ok(Event::Ready(ready)) => {
                let _ = app.emit("gateway-ready", &*ready);
            }
            Ok(_) => {
                // Other events ignored for now (typing, presence, etc.)
            }
            Err(err) => {
                if err.is_fatal() {
                    let _ = app.emit("gateway-closed", err.to_string());
                    break;
                }
                // Resumable error: twilight keeps the session; continue.
            }
        }
    }
}

#[tauri::command]
async fn login(
    app: AppHandle,
    state: State<'_, SharedSession>,
    token: String,
) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    let http = Arc::new(HttpClient::new(token.clone()));

    // Validate the token by fetching the current user.
    let user = http
        .current_user()
        .await
        .map_err(|e| format!("invalid token or network error: {e}"))?
        .model()
        .await
        .map_err(|e| e.to_string())?;

    // Start the gateway only once per session.
    let mut guard = state.inner().lock().await;
    let already_connected = guard.is_some();
    *guard = Some(DiscordSession { http });
    drop(guard);

    if !already_connected {
        let app2 = app.clone();
        tokio::spawn(async move {
            run_gateway(app2, token).await;
        });
    }

    to_json(&user)
}

#[tauri::command]
async fn get_guilds(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let http = session(&state).await?;
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
    let http = session(&state).await?;
    let channels = http
        .current_user_private_channels()
        .await
        .map_err(|e| e.to_string())?
        .models()
        .await
        .map_err(|e| e.to_string())?;
    to_json(&channels)
}

#[tauri::command]
async fn get_channels(
    state: State<'_, SharedSession>,
    guild_id: u64,
) -> Result<serde_json::Value, String> {
    let http = session(&state).await?;
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
    let http = session(&state).await?;
    let mut req = http.channel_messages(Id::new(channel_id));
    if let Some(before) = before {
        req = req.before(Id::new(before));
    }
    let messages = req
        .limit(50)
        .map_err(|e| e.to_string())?
        .await
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
    let http = session(&state).await?;
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
