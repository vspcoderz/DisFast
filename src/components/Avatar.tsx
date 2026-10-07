import type { User } from "../types";
import { avatarUrl } from "../utils";

/**
 * Module-level decoration cache: userId → decoration image URL.
 * Populated from profile fetches, message authors, and DM recipients.
 */
const decorationCache = new Map<string, string>();

/**
 * Decorations are tiny overlays (~40px on screen) but the CDN's .png is
 * ~1 MB. WebP is the same static frame at ~9 KB (110x smaller); ?size
 * trims it further. This URL serves a static frame even for `a_`-prefixed
 * (animated) presets — the animation lives in the official client's
 * sprite sheets, not here.
 */
function decorationCdnUrl(asset: string, size: number): string {
  return `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.webp?size=${size}`;
}

export function cacheDecoration(userId: string, asset: string | null | undefined) {
  if (asset) {
    decorationCache.set(userId, decorationCdnUrl(asset, 96));
  }
}

function decorationUrl(user: User, size: number): string | null {
  // Prefer inline data (message authors, DM recipients carry it)
  const inline = user.avatar_decoration_data?.asset;
  if (inline) {
    const url = decorationCdnUrl(inline, Math.max(64, Math.round(size * 2)));
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
  const deco = decorationUrl(user, size);
  return (
    <span
      className={`avatar-wrap${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
    >
      <img
        className="avatar-img"
        src={avatarUrl(user, size)}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
      />
      {deco && <img className="avatar-deco" src={deco} alt="" loading="lazy" />}
    </span>
  );
}
