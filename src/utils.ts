import type { Channel, Guild, User } from "./types";

export function displayName(user: User): string {
  return user.global_name || user.username;
}

export function avatarUrl(user: User): string {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`;
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
