import type { Message } from "./types";

/**
 * Desktop notifications via the Web Notification API — no Tauri plugin
 * dependency. We only notify for mentions/@everyone in channels you
 * aren't currently viewing, which is what Discord does.
 */
let permission: NotificationPermission = "default";

export function initNotifications(onPermission: (p: string) => void) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    void Notification.requestPermission().then((p) => {
      permission = p;
      onPermission(p);
    });
  } else {
    permission = Notification.permission;
  }
}

export function notificationPermission(): string {
  return permission;
}

interface NotifyContext {
  enabled: boolean;
  activeChannelId: string | null;
  currentUserId: string;
  /** Channel id -> guild id, for the notification link. */
  guildOf: (channelId: string) => string | null;
}

export function maybeNotify(msg: Message, ctx: NotifyContext) {
  if (!ctx.enabled) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // Never notify for the channel you're reading, or your own messages.
  if (msg.channel_id === ctx.activeChannelId) return;
  if (msg.author.id === ctx.currentUserId) return;

  const mentionsMe =
    ctx.currentUserId && (msg.mentions ?? []).some((m) => m.id === ctx.currentUserId);
  const mentionsEveryone = msg.mention_everyone === true;
  if (!mentionsMe && !mentionsEveryone) return;

  const body = msg.content.length > 140 ? msg.content.slice(0, 140) + "…" : msg.content;
  const n = new Notification(
    mentionsEveryone && !mentionsMe ? `@everyone ${msg.author.global_name || msg.author.username}` : (msg.author.global_name || msg.author.username),
    { body, tag: `${msg.channel_id}:${msg.id}`, silent: false },
  );
  const guild = ctx.guildOf(msg.channel_id);
  n.onclick = () => {
    window.focus();
    window.location.hash = `#/channels/${guild ?? "@me"}/${msg.channel_id}`;
    n.close();
  };
}