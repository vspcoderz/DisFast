import type { Channel, Guild, User } from "./types";

export function displayName(user: User): string {
  return user.global_name || user.username;
}

export function avatarUrl(user: User, size = 40): string {
  if (user.avatar) {
    // Ask for a size close to what's rendered (×2 for HiDPI) instead of a
// fixed 64 — the profile avatar was being upscaled, and the small DM-list
// avatars were downloading far more pixels than they display.
  const dpr = typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 2) : 1;
  const px = Math.min(256, Math.max(32, Math.round(size * dpr)));
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=${px}`;
  }
  // New-style default avatar index (snowflake bits)
  const idx = Number(BigInt(user.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export function guildIconUrl(guild: Guild): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=96`
    : null;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 3)
    .join("")
    .toUpperCase();
}

export function dmChannelName(ch: Channel): string {
  if (ch.name) return ch.name;
  if (ch.recipients?.length) {
    return ch.recipients.map(displayName).join(", ");
  }
  return "Unknown DM";
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? time
    : `${d.toLocaleDateString()} ${time}`;
}
