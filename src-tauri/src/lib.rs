use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const API_BASE: &str = "https://discord.com/api/v9";

/// Everything we hold after a successful login.
struct DiscordSession {
    http: reqwest::Client,
    /// DM channels as raw gateway JSON, populated from the READY payload
    /// and kept up to date via CHANNEL_CREATE/CHANNEL_DELETE events.
    dms: SharedDms,
    /// Known users by ID, seeded from READY's `users` array and grown
    /// from message authors. Used to give DM channels displayable names:
    /// modern READY payloads ship `recipient_ids` without user objects.
    users: SharedUsers,
}

type SharedSession = Arc<Mutex<Option<DiscordSession>>>;
type SharedDms = Arc<Mutex<Vec<serde_json::Value>>>;
type SharedUsers = Arc<Mutex<HashMap<String, serde_json::Value>>>;

/// Inject a `recipients` array into a DM channel that only carries
/// `recipient_ids` (the modern READY format), resolving names from the
/// user cache.
async fn enrich_dm(mut channel: serde_json::Value, users: &SharedUsers) -> serde_json::Value {
    let has_recipients = channel
        .get("recipients")
        .and_then(|r| r.as_array())
        .is_some_and(|r| !r.is_empty());
    if has_recipients {
        return channel;
    }
    let Some(ids) = channel.get("recipient_ids").and_then(|i| i.as_array()) else {
        return channel;
    };
    let cache = users.lock().await;
    let recipients: Vec<serde_json::Value> = ids
        .iter()
        .filter_map(|id| id.as_str())
        .filter_map(|id| cache.get(id).cloned())
        .collect();
    if let Some(obj) = channel.as_object_mut() {
        obj.insert("recipients".to_string(), serde_json::Value::Array(recipients));
    }
    channel
}

/// Build an HTTP client that sends the token *raw* in the Authorization
/// header, as user accounts require. (Discord HTTP libraries for bots
/// force-prefix `Bot `, which is why we use reqwest directly.)
fn build_http(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(token).map_err(|e| format!("bad token characters: {e}"))?,
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("DisFast/0.1"));
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

/// Extract Discord's retry_after (seconds) from a 429 body.
fn retry_after(body: &serde_json::Value) -> f64 {
    body.get("retry_after")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
        + 0.1
}

async fn get_json(http: &reqwest::Client, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{API_BASE}{path}");
    for attempt in 0..3 {
        let res = http.get(&url).send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
            // Rate limited: wait it out silently, never surface to the UI.
            let body = res.json().await.unwrap_or_default();
            let wait = retry_after(&body);
            eprintln!("[disfast] rate limited on {path}, retrying in {wait:.1}s");
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait)).await;
            continue;
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("GET {path} failed ({status}): {body}"));
        }
        return res.json().await.map_err(|e| e.to_string());
    }
    unreachable!()
}

async fn http(state: &State<'_, SharedSession>) -> Result<reqwest::Client, String> {
    let guard = state.inner().lock().await;
    guard
        .as_ref()
        .map(|s| s.http.clone())
        .ok_or_else(|| "not logged in".to_string())
}

const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=9&encoding=json";

/// Gateway loop: raw WebSocket client with auto-reconnect.
///
/// We bypass twilight-gateway (whose connection layer fails silently for
/// user accounts) and speak the gateway protocol directly — the frontend
/// consumes JSON anyway, and user accounts receive fields (like
/// `READY.private_channels`) that typed libraries discard.
async fn run_gateway(app: AppHandle, token: String, dms: SharedDms, users: SharedUsers) {
    const MAX_ATTEMPTS: u32 = 5;

    for attempt in 1..=MAX_ATTEMPTS {
        let _ = app.emit("gateway-status", "connecting");
        eprintln!("[disfast] gateway: connecting (attempt {attempt}/{MAX_ATTEMPTS})");

        match connect_and_pump(&app, &token, &dms, &users).await {
            PumpResult::Ready => {
                eprintln!("[disfast] gateway: connection closed after READY");
            }
            PumpResult::Disconnected => {
                eprintln!("[disfast] gateway: disconnected");
            }
        }

        if attempt == MAX_ATTEMPTS {
            break;
        }
        let backoff = std::cmp::min(30, 1u64 << attempt.min(5));
        eprintln!("[disfast] gateway: reconnecting in {backoff}s");
        let _ = app.emit("gateway-status", "reconnecting");
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
    }

    eprintln!("[disfast] gateway: gave up after {MAX_ATTEMPTS} attempts");
    let _ = app.emit("gateway-status", "failed");
    let _ = app.emit("gateway-closed", "gateway gave up reconnecting");
}

enum PumpResult {
    Ready,
    Disconnected,
}

/// One gateway connection: connect, identify, pump events until the
/// stream ends. Returns whether we got READY before disconnecting.
async fn connect_and_pump(
    app: &AppHandle,
    token: &str,
    dms: &SharedDms,
    users: &SharedUsers,
) -> PumpResult {
    use tokio_tungstenite::connect_async;

    let (ws_stream, _) = match connect_async(GATEWAY_URL).await {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("[disfast] gateway: connection failed: {err}");
            return PumpResult::Disconnected;
        }
    };
    eprintln!("[disfast] gateway: WebSocket connected");
    let (write, mut read) = ws_stream.split();

    // Writer task owns the write half; everyone sends through this channel.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();
    let writer_handle = tokio::spawn(async move {
        let mut write = write;
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    let send = |msg: WsMessage| {
        let _ = tx.send(msg);
    };

    let mut identified = false;
    let mut got_ready = false;
    let mut heartbeat_interval: Option<u64> = None;

    loop {
        let msg = match read.next().await {
            Some(Ok(msg)) => msg,
            Some(Err(err)) => {
                eprintln!("[disfast] gateway: receive error: {err}");
                break;
            }
            None => {
                eprintln!("[disfast] gateway: stream ended");
                break;
            }
        };

        let WsMessage::Text(text) = msg else {
            continue;
        };

        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let op = payload.get("op").and_then(|o| o.as_u64()).unwrap_or(0);

        match op {
            10 => {
                // HELLO — start heartbeating, then identify.
                let interval = payload
                    .get("d")
                    .and_then(|d| d.get("heartbeat_interval"))
                    .and_then(|i| i.as_u64())
                    .unwrap_or(41250);
                eprintln!("[disfast] gateway: HELLO, heartbeat {interval}ms");
                heartbeat_interval = Some(interval);

                // Spawn the heartbeat loop for this connection.
                let hb_tx = tx.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                        let payload = serde_json::json!({ "op": 1, "d": null });
                        if hb_tx.send(WsMessage::Text(payload.to_string().into())).is_err() {
                            return;
                        }
                    }
                });

                let identify = serde_json::json!({
                    "op": 2,
                    "d": {
                        "token": token,
                        "properties": {
                            "os": "linux",
                            "browser": "DisFast",
                            "device": "DisFast",
                        },
                        "compress": false,
                        "large_threshold": 250,
                        "intents": 37377,
                    },
                });
                send(WsMessage::Text(identify.to_string().into()));
                identified = true;
            }
            0 => {
                let event_type = payload
                    .get("t")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                let data = payload.get("d").cloned().unwrap_or(serde_json::Value::Null);

                match event_type {
                    "READY" => {
                        got_ready = true;
                        if let Some(list) = data.get("users").and_then(|u| u.as_array()) {
                            let mut cache = users.lock().await;
                            for user in list {
                                if let Some(id) = user.get("id").and_then(|i| i.as_str()) {
                                    cache.insert(id.to_string(), user.clone());
                                }
                            }
                            eprintln!("[disfast] READY: cached {} users", cache.len());
                        }
                        match data.get("private_channels").and_then(|c| c.as_array()) {
                            Some(channels) => {
                                eprintln!("[disfast] READY: {} private channels", channels.len());
                                let mut enriched = Vec::with_capacity(channels.len());
                                for ch in channels {
                                    enriched.push(enrich_dm(ch.clone(), &users).await);
                                }
                                *dms.lock().await = enriched;
                            }
                            None => {
                                eprintln!("[disfast] READY: no private_channels field");
                            }
                        }
                        let _ = app.emit("gateway-ready", &data);
                        let _ = app.emit("gateway-status", "ready");
                    }
                    "MESSAGE_CREATE" => {
                        if let Some(author) = data.get("author") {
                            if let Some(id) = author.get("id").and_then(|i| i.as_str()) {
                                users.lock().await.insert(id.to_string(), author.clone());
                            }
                        }
                        let _ = app.emit("message-create", &data);
                    }
                    "MESSAGE_UPDATE" => {
                        let _ = app.emit("message-update", &data);
                    }
                    "MESSAGE_DELETE" => {
                        let _ = app.emit("message-delete", &data);
                    }
                    "CHANNEL_CREATE" => {
                        let kind = data.get("type").and_then(|t| t.as_u64()).unwrap_or(0);
                        if kind == 1 || kind == 3 {
                            let channel = enrich_dm(data.clone(), &users).await;
                            let id = channel.get("id").cloned();
                            let mut guard = dms.lock().await;
                            if !guard.iter().any(|c| c.get("id") == id.as_ref()) {
                                guard.push(channel.clone());
                            }
                            let _ = app.emit("dm-create", &channel);
                        }
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
            1 => {
                // Heartbeat request — respond immediately.
                send(WsMessage::Text(
                    serde_json::json!({ "op": 1, "d": null }).to_string().into(),
                ));
            }
            7 => {
                eprintln!("[disfast] gateway: RECONNECT requested");
                break;
            }
            9 => {
                eprintln!("[disfast] gateway: INVALID SESSION");
                break;
            }
            11 => {
                // Heartbeat ACK — all good.
            }
            _ => {}
        }
    }

    drop(tx);
    let _ = writer_handle.await;
    let _ = heartbeat_interval;

    if identified && got_ready {
        PumpResult::Ready
    } else {
        PumpResult::Disconnected
    }
}

#[tauri::command]
async fn login(
    app: AppHandle,
    state: State<'_, SharedSession>,
    token: String,
) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    let client = build_http(&token)?;

    // Validate the token by fetching the current user.
    let user = get_json(&client, "/users/@me")
        .await
        .map_err(|e| format!("invalid token or network error: {e}"))?;

    // Start the gateway only once per session.
    let mut guard = state.inner().lock().await;
    let already_connected = guard.is_some();
    let dms: SharedDms = Arc::new(Mutex::new(Vec::new()));
    let users: SharedUsers = Arc::new(Mutex::new(HashMap::new()));
    *guard = Some(DiscordSession {
        http: client,
        dms: Arc::clone(&dms),
        users: Arc::clone(&users),
    });
    drop(guard);

    if !already_connected {
        let app2 = app.clone();
        tokio::spawn(async move {
            run_gateway(app2, token, dms, users).await;
        });
    }

    Ok(user)
}

#[tauri::command]
async fn get_guilds(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, "/users/@me/guilds").await
}

#[tauri::command]
async fn get_dms(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let (http, dms_store, users) = {
        let guard = state.inner().lock().await;
        let session = guard.as_ref().ok_or("not logged in")?;
        (
            session.http.clone(),
            Arc::clone(&session.dms),
            Arc::clone(&session.users),
        )
    };

    // Primary source: the gateway store.
    let cached = dms_store.lock().await.clone();
    if !cached.is_empty() {
        return Ok(serde_json::Value::Array(cached));
    }

    // Fallback: the REST endpoint. Bots can't use it anymore, but user
    // accounts still can — handy if READY hasn't arrived (or arrived
    // without private_channels).
    let Ok(serde_json::Value::Array(channels)) =
        get_json(&http, "/users/@me/channels").await
    else {
        return Ok(serde_json::Value::Array(vec![]));
    };
    eprintln!("[disfast] REST fallback: {} private channels", channels.len());
    let mut enriched = Vec::with_capacity(channels.len());
    for ch in channels {
        // Feed recipients into the cache as we discover them.
        if let Some(recipients) = ch.get("recipients").and_then(|r| r.as_array()) {
            let mut cache = users.lock().await;
            for user in recipients {
                if let Some(id) = user.get("id").and_then(|i| i.as_str()) {
                    cache.insert(id.to_string(), user.clone());
                }
            }
        }
        enriched.push(enrich_dm(ch, &users).await);
    }
    *dms_store.lock().await = enriched.clone();
    Ok(serde_json::Value::Array(enriched))
}

#[tauri::command]
async fn get_channels(
    state: State<'_, SharedSession>,
    guild_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, &format!("/guilds/{guild_id}/channels")).await
}

#[tauri::command]
async fn get_messages(
    state: State<'_, SharedSession>,
    channel_id: String,
    before: Option<String>,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let mut path = format!("/channels/{channel_id}/messages?limit=50");
    if let Some(before) = before {
        path.push_str(&format!("&before={before}"));
    }
    get_json(&http, &path).await
}

#[tauri::command]
async fn create_invite(
    state: State<'_, SharedSession>,
    channel_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/invites");
    for attempt in 0..3 {
        let res = http
            .post(&url)
            .json(&serde_json::json!({ "max_age": 86400, "max_uses": 0 }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
            let body = res.json().await.unwrap_or_default();
            let wait = retry_after(&body);
            eprintln!("[disfast] rate limited creating invite, retrying in {wait:.1}s");
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait)).await;
            continue;
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("invite failed ({status}): {body}"));
        }
        return res.json().await.map_err(|e| e.to_string());
    }
    unreachable!()
}

#[tauri::command]
async fn add_reaction(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
    emoji: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let encoded = urlencoding(&emoji);
    let path = format!("/channels/{channel_id}/messages/{message_id}/reactions/{encoded}/@me");
    let res = http.put(format!("{API_BASE}{path}")).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("reaction failed ({status}): {body}"));
    }
    Ok(())
}

#[tauri::command]
async fn remove_reaction(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
    emoji: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let encoded = urlencoding(&emoji);
    let path = format!("/channels/{channel_id}/messages/{message_id}/reactions/{encoded}/@me");
    let res = http.delete(format!("{API_BASE}{path}")).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("reaction remove failed ({status}): {body}"));
    }
    Ok(())
}

/// URL-encode an emoji (unicode or custom name:id) for the reactions path.
fn urlencoding(emoji: &str) -> String {
    let mut out = String::new();
    for b in emoji.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

#[tauri::command]
async fn get_members(
    state: State<'_, SharedSession>,
    guild_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, &format!("/guilds/{guild_id}/members?limit=1000")).await
}

#[tauri::command]
async fn get_roles(
    state: State<'_, SharedSession>,
    guild_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, &format!("/guilds/{guild_id}/roles")).await
}

#[tauri::command]
async fn get_user_profile(
    state: State<'_, SharedSession>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, &format!("/users/{user_id}/profile")).await
}

#[tauri::command]
async fn send_message(
    state: State<'_, SharedSession>,
    channel_id: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("empty message".to_string());
    }
    let url = format!("{API_BASE}/channels/{channel_id}/messages");
    for attempt in 0..3 {
        let res = http
            .post(&url)
            .json(&serde_json::json!({ "content": content }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
            let body = res.json().await.unwrap_or_default();
            let wait = retry_after(&body);
            eprintln!("[disfast] rate limited sending message, retrying in {wait:.1}s");
            tokio::time::sleep(std::time::Duration::from_secs_f64(wait)).await;
            continue;
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("send failed ({status}): {body}"));
        }
        return res.json().await.map_err(|e| e.to_string());
    }
    unreachable!()
}

/// Dev convenience: read a token from `secret.env` in the project root
/// (format: `key="token"`). Only available in debug builds; the release
/// binary never touches the filesystem for tokens.
#[tauri::command]
fn get_dev_token() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let content = std::fs::read_to_string("../secret.env").ok()?;
        let start = content.find('"')? + 1;
        let end = content.rfind('"')?;
        (end > start).then(|| content[start..end].to_string())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
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
            add_reaction,
            remove_reaction,
            get_members,
            get_roles,
            get_user_profile,
            create_invite,
            get_dev_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DisFast");
}
