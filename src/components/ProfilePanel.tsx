import { useEffect, useState } from "react";
import { api } from "../api";
import { renderMarkdown } from "../markdown";
import type { UserProfileResponse } from "../types";
import { avatarUrl, displayName } from "../utils";

/** Discord snowflake IDs embed a Unix timestamp (ms since Discord epoch). */
const DISCORD_EPOCH = 1420070400000n;

function snowflakeDate(id: string): Date {
  try {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
  } catch {
    return new Date(0);
  }
}

const NITRO_NAMES: Record<number, string> = {
  1: "Nitro Classic",
  2: "Nitro",
  3: "Nitro Basic",
};

export function ProfilePanel({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setProfile(null);
    setError("");
    api
      .getUserProfile(userId)
      .then((p) => alive && setProfile(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [userId]);

  if (error) return <aside className="profile-panel error">{error}</aside>;
  if (!profile) return <aside className="profile-panel loading">Loading…</aside>;

  const { user } = profile;
  const bio = profile.user_profile?.bio;
  const accent =
    profile.user_profile?.accent_color ??
    user.accent_color ??
    (profile.user_profile?.theme_colors?.[0] || null);
  const bannerUrl = user.banner
    ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${user.banner.startsWith("a_") ? "gif" : "webp"}?size=480`
    : null;
  const decorationUrl = user.avatar_decoration_data?.asset
    ? `https://cdn.discordapp.com/avatar-decoration-presets/${user.avatar_decoration_data.asset}.png`
    : null;
  const clan = user.clan;
  const clanBadgeUrl =
    clan && clan.identity_enabled
      ? `https://cdn.discordapp.com/clan-badges/${clan.identity_guild_id}/${clan.badge}.png`
      : null;
  const nitroName = profile.premium_type ? NITRO_NAMES[profile.premium_type] : null;

  return (
    <aside className="profile-panel">
      <div
        className="profile-banner"
        style={{
          backgroundColor: accent != null ? `#${accent.toString(16).padStart(6, "0")}` : "var(--bg-3)",
          backgroundImage: bannerUrl ? `url(${bannerUrl})` : undefined,
        }}
      />
      <div className="profile-avatar-wrap">
        <img className="profile-avatar" src={avatarUrl(user)} alt="" />
        {decorationUrl && (
          <img className="profile-decoration" src={decorationUrl} alt="" loading="lazy" />
        )}
      </div>
      <div className="profile-card">
        <div className="profile-name-row">
          <div className="profile-name">{displayName(user)}</div>
          {nitroName && <span className="nitro-badge">{nitroName}</span>}
        </div>
        <div className="profile-username">@{user.username}</div>
        {clanBadgeUrl && clan && (
          <div className="profile-clan">
            <img src={clanBadgeUrl} alt="" loading="lazy" />
            <span>{clan.tag}</span>
          </div>
        )}
        {profile.user_profile?.pronouns && (
          <div className="profile-pronouns">{profile.user_profile.pronouns}</div>
        )}
        {bio && (
          <>
            <div className="profile-section-title">About Me</div>
            <div
              className="profile-bio"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(bio) }}
            />
          </>
        )}
        <div className="profile-section-title">Member Since</div>
        <div className="profile-since">
          {snowflakeDate(user.id).toLocaleDateString([], {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </div>
        {nitroName && profile.premium_since && (
          <>
            <div className="profile-section-title">Nitro Since</div>
            <div className="profile-since">
              {new Date(profile.premium_since).toLocaleDateString([], {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
