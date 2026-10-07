use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;

use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const API_BASE: &str = "https://discord.com/api/v9";

/// Standard base64 alphabet with padding — matches what the browser's
/// `FileReader.readAsDataURL` produces once we strip the data-URL prefix.
const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

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
    /// Our own user ID (needed for permission resolution).
    user_id: String,
    /// Write half of the live gateway socket, so commands (component
    /// interactions) can push op-3 frames onto the existing connection.
    gateway_tx: SharedGatewayTx,
}

type SharedGatewayTx = Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<WsMessage>>>>;

type SharedSession = Arc<Mutex<Option<DiscordSession>>>;
type SharedDms = Arc<Mutex<Vec<serde_json::Value>>>;
type SharedUsers = Arc<Mutex<HashMap<String, serde_json::Value>>>;
/// Gateway session id from READY — required in component interaction
/// payloads (the `session_id` field) so Discord knows which connection
/// initiated the click.
type SharedSessionId = Arc<Mutex<Option<String>>>;

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
        // Without a timeout a hung Discord connection holds a task forever.
        .timeout(std::time::Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .build()
        .map_err(|e| e.to_string())
}

/// Discord gates account-mutating endpoints (PATCH /users/@me, avatar
/// and banner uploads) behind hCaptcha for clients it doesn't recognise.
/// We surface a clear message instead of leaking their JSON payload;
/// solving the challenge is intentionally out of scope.
fn account_mutation_error(status: reqwest::StatusCode, body: &str) -> String {
    let needs_captcha = body.contains("captcha_key") || body.contains("captcha_sitekey");
    if needs_captcha || status == reqwest::StatusCode::BAD_REQUEST {
        return "Discord requires captcha verification to change account details \
                from a third-party client. Make this change in the official \
                Discord client."
            .to_string();
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return "Discord refused this change for your account.".to_string();
    }
    format!("request failed ({status}): {body}")
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
async fn run_gateway(
    app: AppHandle,
    token: String,
    dms: SharedDms,
    users: SharedUsers,
    session_id: SharedSessionId,
    gateway_tx: SharedGatewayTx,
) {
    const MAX_ATTEMPTS: u32 = 5;

    for attempt in 1..=MAX_ATTEMPTS {
        let _ = app.emit("gateway-status", "connecting");
        eprintln!("[disfast] gateway: connecting (attempt {attempt}/{MAX_ATTEMPTS})");

        match connect_and_pump(&app, &token, &dms, &users, &session_id, &gateway_tx).await {
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
    session_id: &SharedSessionId,
    gateway_tx: &SharedGatewayTx,
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

    // Publish the writer so Tauri commands (component interactions) can
    // push frames onto this connection. Dropped when the socket dies.
    let tx_clone = tx.clone();
    let publish = Arc::clone(&gateway_tx);
    tokio::spawn(async move {
        *publish.lock().await = Some(tx_clone);
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
                        // GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS
                        // | GUILD_MESSAGE_TYPING | DIRECT_MESSAGES
                        // | DIRECT_MESSAGE_REACTIONS | DIRECT_MESSAGE_TYPING
                        // | MESSAGE_CONTENT
                        "intents": 1 | 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768,
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
                        // Capture the session id for component interactions.
                        *session_id.lock().await = data
                            .get("session_id")
                            .and_then(|s| s.as_str())
                            .map(String::from);
                        if let Some(list) = data.get("users").and_then(|u| u.as_array()) {
                            let mut cache = users.lock().await;
                            // Replace, don't merge: users cached from a
                            // previous session are a pure leak.
                            cache.clear();
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
                    "MESSAGE_DELETE_BULK" => {
                        let _ = app.emit("message-delete-bulk", &data);
                    }
                    "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE" => {
                        let _ = app.emit("message-reaction", &data);
                    }
                    "TYPING_START" => {
                        let _ = app.emit("typing-start", &data);
                    }
                    "CHANNEL_UPDATE" => {
                        let _ = app.emit("channel-update", &data);
                    }
                    "CHANNEL_PINS_UPDATE" => {
                        let _ = app.emit("channel-pins-update", &data);
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
    session_id: State<'_, SharedSessionId>,
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
    // Created here so the gateway task and the session share one writer.
    let gateway_tx: SharedGatewayTx = Arc::new(Mutex::new(None));
    *guard = Some(DiscordSession {
        http: client,
        dms: Arc::clone(&dms),
        users: Arc::clone(&users),
        user_id: user
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        gateway_tx: Arc::clone(&gateway_tx),
    });
    drop(guard);

    if !already_connected {
        let app2 = app.clone();
        let sid = Arc::clone(&session_id.inner());
        tokio::spawn(async move {
            run_gateway(app2, token, dms, users, sid, gateway_tx).await;
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

/// ADMINISTRATOR (1<<3) and VIEW_CHANNEL (1<<10) — the two permission
/// bits the hidden-channel filter cares about.
const ADMINISTRATOR: u64 = 1 << 3;
const VIEW_CHANNEL: u64 = 1 << 10;
const SEND_MESSAGES: u64 = 1 << 11;

/// Discord sends permission bitfields as strings (they exceed f64
/// precision). Accept strings and numbers alike.
fn parse_bits(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

fn apply_overwrite(perms: u64, allow: u64, deny: u64) -> u64 {
    (perms & !deny) | allow
}

/// Effective permission bits for the current user on `channel`, following
/// Discord's overwrite model: base role permissions, then category
/// overwrites (root first), each applying @everyone → role (OR'd) →
/// member, in that order. `base` must already OR @everyone with the
/// member's roles.
fn effective_perms(
    channel: &serde_json::Value,
    by_id: &HashMap<&str, &serde_json::Value>,
    base: u64,
    member_roles: &[String],
    member_id: &str,
    guild_id: &str,
) -> u64 {
    if base & ADMINISTRATOR != 0 {
        return u64::MAX;
    }

    // Overwrite chain: ancestor categories first, then the channel itself.
    let mut chain = vec![channel];
    let mut cur = channel;
    while let Some(pid) = cur.get("parent_id").and_then(|p| p.as_str()) {
        let Some(parent) = by_id.get(pid) else { break; };
        chain.push(parent);
        cur = parent;
    }
    chain.reverse();

    let mut perms = base;
    for node in chain {
        let Some(ows) = node.get("permission_overwrites").and_then(|o| o.as_array()) else {
            continue;
        };
        // @everyone applies first, then the member's role overwrites
        // combined, then the member-specific overwrite.
        let mut role_allow = 0u64;
        let mut role_deny = 0u64;
        let mut member_allow = 0u64;
        let mut member_deny = 0u64;
        for ow in ows {
            let id = ow.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let allow = parse_bits(ow.get("allow"));
            let deny = parse_bits(ow.get("deny"));
            // Discord serializes Overwrite.type as an INTEGER: 0 = role,
            // 1 = member. (Not the string "member" — that never appears.)
            let is_member = match ow.get("type") {
                Some(serde_json::Value::Number(n)) => n.as_u64() == Some(1),
                // Tolerate the string form some fixtures/older docs use.
                Some(serde_json::Value::String(s)) => s == "member",
                _ => false,
            };
            if is_member {
                if id == member_id {
                    member_allow = allow;
                    member_deny = deny;
                }
            } else if id == guild_id {
                // @everyone overwrite — id equals the guild id.
                perms = apply_overwrite(perms, allow, deny);
            } else if member_roles.iter().any(|r| r == id) {
                role_allow |= allow;
                role_deny |= deny;
            }
        }
        perms = apply_overwrite(perms, role_allow, role_deny);
        perms = apply_overwrite(perms, member_allow, member_deny);
    }

    perms
}

#[tauri::command]
async fn get_channels(
    state: State<'_, SharedSession>,
    guild_id: String,
) -> Result<serde_json::Value, String> {
    let (http, member_id) = {
        let guard = state.inner().lock().await;
        let session = guard.as_ref().ok_or("not logged in")?;
        (session.http.clone(), session.user_id.clone())
    };

    let channels = get_json(&http, &format!("/guilds/{guild_id}/channels")).await?;
    // User accounts receive *every* channel over REST, including ones
    // without VIEW_CHANNEL — the official client hides those, so we
    // compute the permission here and filter.
    let list = match channels {
        serde_json::Value::Array(list) => list,
        other => return Ok(other),
    };

    // These two are independent of each other and of `channels` — fetch
    // them concurrently instead of paying 3× the latency.
    // Fail closed: without permission data we cannot know what is hidden,
    // so show nothing rather than leaking private channels.
    // Bind the URLs first: `join!` awaits both futures, so a temporary
    // `format!()` would be dropped while still borrowed.
    let member_url = format!("/guilds/{guild_id}/members/{member_id}");
    let guild_url = format!("/guilds/{guild_id}");
    let (member, guild) = tokio::join!(
        get_json(&http, &member_url),
        get_json(&http, &guild_url),
    );
    let (member, guild) = match (member, guild) {
        (Ok(m), Ok(g)) => (m, g),
        _ => {
            eprintln!("[disfast] get_channels {guild_id}: permission lookups failed, hiding all channels");
            return Ok(serde_json::Value::Array(vec![]));
        }
    };

    if guild.get("owner_id").and_then(|v| v.as_str()) == Some(member_id.as_str()) {
        return Ok(serde_json::Value::Array(list));
    }
    let member_roles: Vec<String> = member
        .get("roles")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Base permissions: @everyone role (id == guild id) OR'd with the
    // member's roles, straight from the guild object's role list.
    let mut base = 0u64;
    if let Some(roles) = guild.get("roles").and_then(|r| r.as_array()) {
        for role in roles {
            let id = role.get("id").and_then(|i| i.as_str()).unwrap_or("");
            if id == guild_id || member_roles.iter().any(|r| r == id) {
                base |= parse_bits(role.get("permissions"));
            }
        }
    }

    let by_id: HashMap<&str, &serde_json::Value> = list
        .iter()
        .filter_map(|c| c.get("id").and_then(|i| i.as_str()).map(|id| (id, c)))
        .collect();

    let mut visible: Vec<serde_json::Value> = Vec::with_capacity(list.len());
    let mut hidden = 0usize;
    for channel in &list {
        let perms = effective_perms(channel, &by_id, base, &member_roles, &member_id, &guild_id);
        if perms & VIEW_CHANNEL == 0 {
            hidden += 1;
            continue;
        }
        // Annotate send rights so the client can show the lock icon without
        // re-deriving the whole overwrite chain.
        let mut channel = channel.clone();
        if let Some(obj) = channel.as_object_mut() {
            obj.insert(
                "can_send".to_string(),
                serde_json::Value::Bool(perms & SEND_MESSAGES != 0),
            );
        }
        visible.push(channel);
    }
    if hidden > 0 {
        eprintln!(
            "[disfast] get_channels {guild_id}: hiding {hidden} of {} channels without VIEW_CHANNEL",
            list.len()
        );
    }
    Ok(serde_json::Value::Array(visible))
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

/// Client for unauthenticated auth endpoints (no Authorization header).
fn build_bare_http() -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Discord/1.0 (https://discord.com)"));
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

/// POST to an /auth/* endpoint and classify the outcome.
async fn auth_request(path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = build_bare_http()?;
    let res = client
        .post(format!("{API_BASE}{path}"))
        .header("Origin", "https://discord.com")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);

    if !status.is_success() {
        // Discord signals "solve this captcha" via a captcha key on 400s.
        if json.get("captcha").is_some() || json.get("captcha_sitekey").is_some() {
            return Ok(classify_auth(json));
        }
        let message = json
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("login failed")
            .to_string();
        return Err(message);
    }
    Ok(classify_auth(json))
}

/// Tag an auth response with a status the UI can branch on:
/// success | mfa_required | captcha_required | failed
fn classify_auth(mut json: serde_json::Value) -> serde_json::Value {
    let status = if json.get("token").and_then(|t| t.as_str()).is_some() {
        "success"
    } else if json.get("captcha_sitekey").is_some() || json.get("captcha").is_some() {
        "captcha_required"
    } else if json.get("ticket").is_some() {
        "mfa_required"
    } else {
        "failed"
    };
    if let Some(obj) = json.as_object_mut() {
        obj.insert("status".to_string(), serde_json::Value::String(status.into()));
    }
    json
}

#[tauri::command]
async fn auth_login(login: String, password: String) -> Result<serde_json::Value, String> {
    auth_request(
        "/auth/login",
        serde_json::json!({
            "login": login,
            "password": password,
            "captcha_key": serde_json::Value::Null,
            "gift_code_sku_id": serde_json::Value::Null,
        }),
    )
    .await
}

#[tauri::command]
async fn auth_mfa_totp(ticket: String, code: String) -> Result<serde_json::Value, String> {
    auth_request(
        "/auth/login/mfa/totp",
        serde_json::json!({ "ticket": ticket, "code": code }),
    )
    .await
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
    reply_to: Option<String>,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("empty message".to_string());
    }
    // A reply is a normal message plus `message_reference`; `replied_user`
    // controls whether the original author gets a notification ping.
    let mut payload = serde_json::json!({
        "content": content,
        "allowed_mentions": { "replied_user": true },
    });
    if let Some(reply_to) = reply_to {
        payload["message_reference"] = serde_json::json!({ "message_id": reply_to });
    }
    let url = format!("{API_BASE}/channels/{channel_id}/messages");
    for attempt in 0..3 {
        let res = http
            .post(&url)
            .json(&payload)
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

/// Upload a file to a channel and post a message with it.
///
/// Discord's message endpoint accepts `multipart/form-data`: a
/// `payload_json` field carrying the message, plus file parts named
/// `files[0]`, `files[1]`, ... Limits are 20 MiB per file (higher with
/// Nitro), 25 MiB per request, 10 files per message.
#[tauri::command]
async fn upload_attachment(
    state: State<'_, SharedSession>,
    channel_id: String,
    filename: String,
    // Base64 file bytes, as read by the frontend FileReader.
    data_base64: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    if filename.is_empty() {
        return Err("no filename".to_string());
    }
    let bytes = BASE64
        .decode(data_base64.trim())
        .map_err(|e| format!("bad file data: {e}"))?;
    // Discord rejects oversized bodies with 413; catch it before the round trip.
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("file exceeds Discord's 20 MiB limit".to_string());
    }

    let payload = serde_json::json!({ "attachments": [{ "id": 0, "filename": filename }] });
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("payload_json", payload.to_string())
        .part("files[0]", part);

    let url = format!("{API_BASE}/channels/{channel_id}/messages");
    let res = http
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("upload failed ({status}): {body}"));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Send a message with an already-uploaded attachment (the two-step
/// pre-signed flow Discord's own client uses). `attachment_id` is the
/// `id` returned by a single-file upload.
#[tauri::command]
async fn send_with_attachment(
    state: State<'_, SharedSession>,
    channel_id: String,
    content: String,
    attachment_id: String,
    filename: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/messages");
    let payload = serde_json::json!({
        "content": content,
        "attachments": [{ "id": attachment_id, "filename": filename }],
    });
    let res = http
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("send failed ({status}): {body}"));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Folders aren't available over the REST API any more (the
/// /users/@me/guild-folders endpoint 404s), so the frontend groups
/// servers locally. This command exists only so the frontend can confirm
/// which guilds exist before building groups.
#[tauri::command]
async fn get_guild_ids(state: State<'_, SharedSession>) -> Result<serde_json::Value, String> {
    let guilds = get_guilds(state).await?;
    Ok(guilds)
}

/// Submit a message component interaction (button click, select change).
///
/// These go over the gateway as op 3, not REST. Requires the READY
/// session id and the application id, which lives on the message
/// (`application.id` or the authorizing integration's application).
#[tauri::command]
async fn interact_component(
    state: State<'_, SharedSession>,
    session_id: State<'_, SharedSessionId>,
    application_id: String,
    channel_id: String,
    message_id: String,
    guild_id: Option<String>,
    component_type: u8,
    custom_id: String,
    values: Vec<String>,
) -> Result<(), String> {
    let (tx, sid) = {
        let guard = state.inner().lock().await;
        let session = guard.as_ref().ok_or("not logged in")?;
        (session.gateway_tx.clone(), session_id.inner().clone())
    };
    let sid = sid.lock().await.clone().ok_or("gateway not ready")?;
    let writer = tx.lock().await.clone().ok_or("gateway not connected")?;

    let mut data = serde_json::json!({
        "component_type": component_type,
        "custom_id": custom_id,
    });
    if !values.is_empty() {
        data["values"] = serde_json::Value::Array(
            values.into_iter().map(serde_json::Value::String).collect(),
        );
    }

    let mut payload = serde_json::json!({
        "application_id": application_id,
        "session_id": sid,
        "channel_id": channel_id,
        "message_id": message_id,
        "data": data,
    });
    if let Some(guild_id) = guild_id {
        payload["guild_id"] = serde_json::Value::String(guild_id);
    }

    let frame = serde_json::json!({ "op": 3, "d": payload });
    writer
        .send(WsMessage::Text(frame.to_string().into()))
        .map_err(|_| "gateway send failed".to_string())
}

/// Update our own presence and/or custom status.
///
/// `PATCH /users/@me` accepts `status` ("online" | "idle" | "dnd" |
/// "invisible") and `custom_status: { text, emoji_name? }`.
#[tauri::command]
async fn set_status(
    state: State<'_, SharedSession>,
    status: Option<String>,
    custom_text: Option<String>,
    emoji_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let mut payload = serde_json::Map::new();
    if let Some(status) = status {
        let allowed = ["online", "idle", "dnd", "invisible"];
        if !allowed.contains(&status.as_str()) {
            return Err(format!("invalid status: {status}"));
        }
        payload.insert("status".to_string(), serde_json::Value::String(status));
    }
    // Discord rejects an empty object, and clearing needs an explicit null.
    let text = custom_text.unwrap_or_default();
    if !text.is_empty() || emoji_name.is_some() {
        let mut custom = serde_json::Map::new();
        if text.is_empty() {
            custom.insert("text".to_string(), serde_json::Value::String(String::new()));
        } else {
            custom.insert("text".to_string(), serde_json::Value::String(text));
        }
        if let Some(emoji) = emoji_name {
            if !emoji.is_empty() {
                custom.insert("emoji_name".to_string(), serde_json::Value::String(emoji));
            }
        }
        payload.insert("custom_status".to_string(), serde_json::Value::Object(custom));
    }
    if payload.is_empty() {
        return Err("nothing to update".to_string());
    }

    let res = http
        .patch(format!("{API_BASE}/users/@me"))
        .json(&serde_json::Value::Object(payload))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(account_mutation_error(status, &body));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Edit our own profile: display name, bio, pronouns, accent colour.
/// Avatar and banner go through their own upload commands (they're
/// multipart image uploads, not JSON fields).
#[tauri::command]
async fn set_profile(
    state: State<'_, SharedSession>,
    display_name: Option<String>,
    bio: Option<String>,
    pronouns: Option<String>,
    accent_color: Option<String>,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let mut payload = serde_json::Map::new();

    if let Some(name) = display_name {
        // Discord accepts an empty string to clear the display name.
        payload.insert(
            "global_name".to_string(),
            serde_json::Value::String(name.trim().to_string()),
        );
    }
    if let Some(bio) = bio {
        if bio.chars().count() > 190 {
            return Err("Bio must be 190 characters or fewer.".to_string());
        }
        payload.insert(
            "bio".to_string(),
            serde_json::Value::String(bio.replace("```", "'''")),
        );
    }
    if let Some(pronouns) = pronouns {
        payload.insert(
            "pronouns".to_string(),
            serde_json::Value::String(pronouns.trim().to_string()),
        );
    }
    if let Some(accent) = accent_color {
        // "" clears the accent; otherwise it must be a hex triplet.
        let trimmed = accent.trim().trim_start_matches('#').to_string();
        if trimmed.is_empty() {
            payload.insert("accent_color".to_string(), serde_json::Value::Null);
        } else if trimmed.len() == 6 && u32::from_str_radix(&trimmed, 16).is_ok() {
            let value = u32::from_str_radix(&trimmed, 16).unwrap();
            payload.insert("accent_color".to_string(), serde_json::Value::from(value));
        } else {
            return Err("Accent colour must be a hex value like #1a2b3c.".to_string());
        }
    }

    if payload.is_empty() {
        return Err("nothing to update".to_string());
    }

    let res = http
        .patch(format!("{API_BASE}/users/@me"))
        .json(&serde_json::Value::Object(payload))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(account_mutation_error(status, &body));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Upload a new avatar or banner. `kind` is "avatars" or "banners".
#[tauri::command]
async fn upload_profile_image(
    state: State<'_, SharedSession>,
    kind: String,
    data_base64: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let (path, max) = match kind.as_str() {
        "avatars" => ("/users/@me/avatars", 8 * 1024 * 1024),
        "banners" => ("/users/@me/banners", 3 * 1024 * 1024),
        _ => return Err("kind must be 'avatars' or 'banners'".to_string()),
    };

    let bytes = BASE64
        .decode(data_base64.trim())
        .map_err(|e| format!("bad image data: {e}"))?;
    if bytes.len() > max {
        return Err(format!("image exceeds the {}-byte limit", max));
    }

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let res = http
        .post(format!("{API_BASE}{path}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(account_mutation_error(status, &body));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Edit an existing message. Discord allows editing your own messages
/// within 15 minutes; beyond that (or for others' messages) you need
/// MANAGE_MESSAGES, and the API rejects it with 403.
#[tauri::command]
async fn edit_message(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("empty message".to_string());
    }
    let url = format!("{API_BASE}/channels/{channel_id}/messages/{message_id}");
    let res = http
        .patch(&url)
        .json(&serde_json::json!({ "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(match status.as_u16() {
            403 => "You can only edit your own messages, and only within 15 minutes."
                .to_string(),
            _ => format!("edit failed ({status}): {body}"),
        });
    }
    res.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_message(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/messages/{message_id}");
    let res = http
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(match status.as_u16() {
            403 => {
                "You can only delete your own messages, or others' with Manage Messages."
                    .to_string()
            }
            _ => format!("delete failed ({status}): {body}"),
        });
    }
    Ok(())
}

/// Signal that the user is typing. Discord's indicator expires after 10
/// seconds, so the frontend throttles calls to roughly every 8.
#[tauri::command]
async fn send_typing(
    state: State<'_, SharedSession>,
    channel_id: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/typing");
    let res = http
        .post(&url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("typing failed ({status}): {body}"));
    }
    Ok(())
}

/// Pinned messages for a channel. `GET /channels/{id}/messages/pins`
/// (the older `/channels/{id}/pins` route is deprecated).
#[tauri::command]
async fn get_pins(
    state: State<'_, SharedSession>,
    channel_id: String,
) -> Result<serde_json::Value, String> {
    let http = http(&state).await?;
    get_json(&http, &format!("/channels/{channel_id}/messages/pins")).await
}

#[tauri::command]
async fn add_pin(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/messages/pins/{message_id}");
    let res = http.put(&url).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("pin failed ({status}): {body}"));
    }
    Ok(())
}

#[tauri::command]
async fn remove_pin(
    state: State<'_, SharedSession>,
    channel_id: String,
    message_id: String,
) -> Result<(), String> {
    let http = http(&state).await?;
    let url = format!("{API_BASE}/channels/{channel_id}/messages/pins/{message_id}");
    let res = http.delete(&url).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("unpin failed ({status}): {body}"));
    }
    Ok(())
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
        .manage(Arc::new(Mutex::new(None)) as SharedSessionId)
        .manage(Arc::new(Mutex::new(None)) as SharedGatewayTx)
        .invoke_handler(tauri::generate_handler![
            auth_login,
            auth_mfa_totp,
            login,
            get_guilds,
            get_dms,
            get_channels,
            get_messages,
            send_message,
            upload_attachment,
            send_with_attachment,
            get_guild_ids,
            edit_message,
            delete_message,
            send_typing,
            get_pins,
            add_pin,
            remove_pin,
            add_reaction,
            remove_reaction,
            get_members,
            get_roles,
            get_user_profile,
            set_status,
            set_profile,
            upload_profile_image,
            interact_component,
            create_invite,
            get_dev_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DisFast");
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUILD: &str = "guild1";
    const USER: &str = "user1";
    const ROLE_A: &str = "roleA";

    fn channel(id: &str, parent: Option<&str>, ows: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "type": 0,
            "name": id,
            "parent_id": parent,
            "permission_overwrites": ows,
        })
    }

    fn perms_for(
        ch: &serde_json::Value,
        by_id: &HashMap<&str, &serde_json::Value>,
        base: u64,
        member_roles: &[&str],
    ) -> u64 {
        let roles: Vec<String> = member_roles.iter().map(|s| s.to_string()).collect();
        effective_perms(ch, by_id, base, &roles, USER, GUILD)
    }

    fn viewable(
        ch: &serde_json::Value,
        by_id: &HashMap<&str, &serde_json::Value>,
        base: u64,
        member_roles: &[&str],
    ) -> bool {
        perms_for(ch, by_id, base, member_roles) & VIEW_CHANNEL != 0
    }

    #[test]
    fn everyone_view_channel_shows_channel() {
        let ch = channel("c1", None, serde_json::json!([]));
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(viewable(&ch, &by_id, VIEW_CHANNEL, &[]));
    }

    #[test]
    fn missing_view_channel_hides_channel() {
        let ch = channel("c1", None, serde_json::json!([]));
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(!viewable(&ch, &by_id, 0, &[]));
    }

    #[test]
    fn everyone_deny_overwrite_hides_channel() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([{
                "id": GUILD,
                "type": "role",
                "allow": "0",
                "deny": VIEW_CHANNEL.to_string(),
            }]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(!viewable(&ch, &by_id, VIEW_CHANNEL, &[]));
    }

    #[test]
    fn role_allow_overwrite_overrides_everyone_deny() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([
                {
                    "id": GUILD,
                    "type": "role",
                    "allow": "0",
                    "deny": VIEW_CHANNEL.to_string(),
                },
                {
                    "id": ROLE_A,
                    "type": "role",
                    "allow": VIEW_CHANNEL.to_string(),
                    "deny": "0",
                },
            ]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(viewable(&ch, &by_id, VIEW_CHANNEL, &[ROLE_A]));
        // Without the role, the @everyone deny still applies.
        assert!(!viewable(&ch, &by_id, VIEW_CHANNEL, &[]));
    }

    /// Real payloads use an INTEGER type (0 = role, 1 = member). This is
    /// the regression test for that: the old string comparison silently
    /// ignored every member-specific overwrite.
    #[test]
    fn integer_member_deny_overwrite_hides_channel_despite_role_allow() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([
                {
                    "id": ROLE_A,
                    "type": 0,
                    "allow": VIEW_CHANNEL.to_string(),
                    "deny": "0",
                },
                {
                    "id": USER,
                    "type": 1,
                    "allow": "0",
                    "deny": VIEW_CHANNEL.to_string(),
                },
            ]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(!viewable(&ch, &by_id, VIEW_CHANNEL, &[ROLE_A]));
    }

    #[test]
    fn integer_member_allow_overrides_everyone_deny() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([
                {
                    "id": GUILD,
                    "type": 0,
                    "allow": "0",
                    "deny": VIEW_CHANNEL.to_string(),
                },
                {
                    "id": USER,
                    "type": 1,
                    "allow": VIEW_CHANNEL.to_string(),
                    "deny": "0",
                },
            ]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(viewable(&ch, &by_id, VIEW_CHANNEL, &[]));
    }

    /// The string form is tolerated for older fixtures.
    #[test]
    fn member_deny_overwrite_hides_channel_despite_role_allow() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([
                {
                    "id": ROLE_A,
                    "type": "role",
                    "allow": VIEW_CHANNEL.to_string(),
                    "deny": "0",
                },
                {
                    "id": USER,
                    "type": "member",
                    "allow": "0",
                    "deny": VIEW_CHANNEL.to_string(),
                },
            ]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(!viewable(&ch, &by_id, VIEW_CHANNEL, &[ROLE_A]));
    }

    #[test]
    fn category_deny_applies_to_child_channel() {
        let cat = channel(
            "cat1",
            None,
            serde_json::json!([{
                "id": GUILD,
                "type": "role",
                "allow": "0",
                "deny": VIEW_CHANNEL.to_string(),
            }]),
        );
        let child = channel("c1", Some("cat1"), serde_json::json!([]));
        let by_id = HashMap::from([("cat1", &cat), ("c1", &child)]);
        assert!(!viewable(&child, &by_id, VIEW_CHANNEL, &[]));
    }

    #[test]
    fn child_overwrite_overrides_category_deny() {
        let cat = channel(
            "cat1",
            None,
            serde_json::json!([{
                "id": GUILD,
                "type": "role",
                "allow": "0",
                "deny": VIEW_CHANNEL.to_string(),
            }]),
        );
        // Child re-grants VIEW_CHANNEL via its own @everyone overwrite —
        // channel overwrites apply after category overwrites.
        let child = channel(
            "c1",
            Some("cat1"),
            serde_json::json!([{
                "id": GUILD,
                "type": "role",
                "allow": VIEW_CHANNEL.to_string(),
                "deny": "0",
            }]),
        );
        let by_id = HashMap::from([("cat1", &cat), ("c1", &child)]);
        assert!(viewable(&child, &by_id, VIEW_CHANNEL, &[]));
    }

    #[test]
    fn administrator_sees_everything() {
        let ch = channel(
            "c1",
            None,
            serde_json::json!([{
                "id": GUILD,
                "type": "role",
                "allow": "0",
                "deny": VIEW_CHANNEL.to_string(),
            }]),
        );
        let by_id = HashMap::from([("c1", &ch)]);
        assert!(viewable(
            &ch,
            &by_id,
            ADMINISTRATOR | VIEW_CHANNEL,
            &[],
        ));
    }

    #[test]
    fn parse_bits_handles_strings_and_numbers() {
        assert_eq!(parse_bits(Some(&serde_json::json!("1024"))), 1024);
        assert_eq!(parse_bits(Some(&serde_json::json!(2048))), 2048);
        assert_eq!(parse_bits(Some(&serde_json::json!("bogus"))), 0);
        assert_eq!(parse_bits(None), 0);
    }
}
