const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---------- State ----------
const state = {
  user: null,
  guilds: [],
  dms: [],
  channels: [],
  activeGuild: null, // "dm" or guild id string
  activeChannel: null, // channel id string
  activeChannelName: "",
};

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`;
  }
  // New-style default avatar index
  const idx = Number(BigInt(user.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function guildIconUrl(guild) {
  if (guild.icon) {
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=96`;
  }
  return null;
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 3)
    .join("")
    .toUpperCase();
}

function formatTime(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

// ---------- Rendering ----------
function renderGuildSidebar() {
  const nav = $("#guild-sidebar");
  nav.innerHTML = "";

  const dmBtn = el("div", "guild-icon" + (state.activeGuild === "dm" ? " active" : ""), "DM");
  dmBtn.title = "Direct Messages";
  dmBtn.onclick = () => selectGuild("dm");
  nav.appendChild(dmBtn);

  for (const g of state.guilds) {
    const icon = el(
      "div",
      "guild-icon" + (String(g.id) === state.activeGuild ? " active" : "")
    );
    const url = guildIconUrl(g);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = g.name;
      img.loading = "lazy";
      icon.appendChild(img);
    } else {
      icon.textContent = initials(g.name);
    }
    icon.title = g.name;
    icon.onclick = () => selectGuild(String(g.id));
    nav.appendChild(icon);
  }
}

function dmChannelName(ch) {
  if (ch.name) return ch.name;
  if (ch.recipients && ch.recipients.length) {
    return ch.recipients.map((r) => r.global_name || r.username).join(", ");
  }
  return "Unknown DM";
}

function renderChannelList() {
  const list = $("#channel-list");
  list.innerHTML = "";

  if (state.activeGuild === "dm") {
    $("#guild-header").textContent = "Direct Messages";
    for (const ch of state.dms) {
      const name = dmChannelName(ch);
      const item = el(
        "div",
        "channel-item" + (String(ch.id) === state.activeChannel ? " active" : ""),
        name
      );
      item.onclick = () => selectChannel(String(ch.id), name);
      list.appendChild(item);
    }
    return;
  }

  const guild = state.guilds.find((g) => String(g.id) === state.activeGuild);
  $("#guild-header").textContent = guild ? guild.name : "DisFast";

  // Text channels only (type 0), sorted by position
  const textChannels = state.channels
    .filter((c) => c.type === 0)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  for (const ch of textChannels) {
    const item = el(
      "div",
      "channel-item" + (String(ch.id) === state.activeChannel ? " active" : ""),
      `# ${ch.name}`
    );
    item.onclick = () => selectChannel(String(ch.id), `# ${ch.name}`);
    list.appendChild(item);
  }
}

function renderUserBar() {
  const bar = $("#user-bar");
  bar.innerHTML = "";
  if (!state.user) return;
  const img = document.createElement("img");
  img.src = avatarUrl(state.user);
  bar.appendChild(img);
  bar.appendChild(el("span", null, state.user.global_name || state.user.username));
}

function renderMessage(msg) {
  const row = el("div", "message");
  row.dataset.id = String(msg.id);

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.loading = "lazy";
  avatar.src = avatarUrl(msg.author);
  row.appendChild(avatar);

  const body = el("div", "body");
  const meta = el("div", "meta");
  meta.appendChild(el("span", "author", msg.author.global_name || msg.author.username));
  meta.appendChild(el("span", "time", formatTime(msg.timestamp)));
  body.appendChild(meta);

  const content = el("div", "content", msg.content || "");
  body.appendChild(content);

  // Render attachments (images inline)
  for (const att of msg.attachments || []) {
    if (att.content_type && att.content_type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = att.url;
      img.loading = "lazy";
      img.style.maxWidth = "400px";
      img.style.borderRadius = "8px";
      img.style.marginTop = "6px";
      body.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.href = att.url;
      link.textContent = att.filename;
      link.target = "_blank";
      body.appendChild(link);
    }
  }

  row.appendChild(body);
  return row;
}

function scrollToBottom() {
  const list = $("#message-list");
  list.scrollTop = list.scrollHeight;
}

// ---------- Actions ----------
async function selectGuild(guildId) {
  state.activeGuild = guildId;
  state.activeChannel = null;
  $("#message-list").innerHTML = "";
  $("#chat-title").textContent = "Select a channel";

  if (guildId === "dm") {
    if (!state.dms.length) {
      state.dms = await invoke("get_dms");
    }
  } else {
    state.channels = await invoke("get_channels", { guildId: Number(guildId) });
  }
  renderGuildSidebar();
  renderChannelList();
}

async function selectChannel(channelId, name) {
  state.activeChannel = channelId;
  state.activeChannelName = name;
  $("#chat-title").textContent = name;
  $("#composer-input").placeholder = `Message ${name}`;
  renderChannelList();

  const list = $("#message-list");
  list.innerHTML = "";
  // API returns newest first; flip for display
  const messages = await invoke("get_messages", { channelId: Number(channelId) });
  for (const msg of messages.reverse()) {
    list.appendChild(renderMessage(msg));
  }
  scrollToBottom();
}

async function doLogin(token) {
  $("#login-error").textContent = "";
  $("#login-btn").disabled = true;
  try {
    state.user = await invoke("login", { token });
    localStorage.setItem("disfast.token", token);
    state.guilds = await invoke("get_guilds");
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    renderUserBar();
    renderGuildSidebar();
    selectGuild("dm");
  } catch (err) {
    $("#login-error").textContent = String(err);
  } finally {
    $("#login-btn").disabled = false;
  }
}

async function sendCurrentMessage() {
  const input = $("#composer-input");
  const content = input.value.trim();
  if (!content || !state.activeChannel) return;
  input.value = "";
  try {
    await invoke("send_message", {
      channelId: Number(state.activeChannel),
      content,
    });
    // The gateway will echo the message back via message-create.
  } catch (err) {
    input.value = content; // restore on failure
    console.error("send failed:", err);
  }
}

// ---------- Gateway events ----------
async function setupEvents() {
  await listen("message-create", (event) => {
    const msg = event.payload;
    if (String(msg.channel_id) === state.activeChannel) {
      $("#message-list").appendChild(renderMessage(msg));
      scrollToBottom();
    }
    // TODO (phase 2): unread badges + desktop notifications for other channels
  });

  await listen("message-delete", (event) => {
    const { id, channel_id } = event.payload;
    if (String(channel_id) !== state.activeChannel) return;
    const row = document.querySelector(`.message[data-id="${id}"]`);
    if (row) row.remove();
  });

  await listen("gateway-closed", (event) => {
    console.error("gateway closed:", event.payload);
  });
}

// ---------- Boot ----------
function boot() {
  $("#login-btn").onclick = () => doLogin($("#token-input").value);
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin($("#token-input").value);
  });
  $("#composer-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendCurrentMessage();
  });

  setupEvents();

  // Auto-login with a saved token
  const saved = localStorage.getItem("disfast.token");
  if (saved) doLogin(saved);
}

boot();
