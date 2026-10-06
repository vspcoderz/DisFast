import type { User } from "../types";
import { avatarUrl } from "../utils";

/**
 * Module-level decoration cache: userId → decoration image URL.
 * Populated from profile fetches, message authors, and DM recipients.
 */
const decorationCache = new Map<string, string>();

export function cacheDecoration(userId: string, asset: string | null | undefined) {
  if (asset) {
    decorationCache.set(
      userId,
      `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png`,
    );
  }
}

function decorationUrl(user: User): string | null {
  // Prefer inline data (message authors, DM recipients carry it)
  const inline = user.avatar_decoration_data?.asset;
  if (inline) {
    const url = `https://cdn.discordapp.com/avatar-decoration-presets/${inline}.png`;
    decorationCache.set(user.id, url);
    return url;
  }
  return decorationCache.get(user.id) ?? null;
}

interface Props {
  user: User;
  size?: number;
  className?: string;
}

/** Avatar with optional decoration overlay — use everywhere a user avatar appears. */
export function Avatar({ user, size = 38, className = "" }: Props) {
  const deco = decorationUrl(user);
  return (
    <span
      className={`avatar-wrap${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
    >
      <img
        className="avatar-img"
        src={avatarUrl(user)}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
      />
      {deco && <img className="avatar-deco" src={deco} alt="" loading="lazy" />}
    </span>
  );
}
