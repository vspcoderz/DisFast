import { useEffect, useState } from "react";
import { api } from "../api";
import { renderMarkdown } from "../markdown";
import type { User, UserProfileResponse } from "../types";
import { displayName } from "../utils";
import { Avatar } from "./Avatar";
import { cleanError } from "./Settings";

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

function badgeUrl(icon: string): string {
  return `https://cdn.discordapp.com/badge-icons/${icon}.png`;
}

function widgetImageUrl(fileId: string): string {
  return `https://cdn.discordapp.com/widget-images/${fileId}.png`;
}

/** Editor for your own profile: display name, bio, pronouns, avatar, banner. */
function ProfileEditor({
  user,
  bio,
  pronouns,
  onCancel,
  onSaved,
}: {
  user: User;
  bio: string;
  pronouns: string;
  onCancel: () => void;
  onSaved: (u: User) => void;
}) {
  const [displayName, setDisplayName] = useState(user.global_name ?? "");
  const [newBio, setNewBio] = useState(bio);
  const [newPronouns, setNewPronouns] = useState(pronouns);
  const [accent, setAccent] = useState(
    user.accent_color != null
      ? `#${user.accent_color.toString(16).padStart(6, "0")}`
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function readImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function uploadImage(kind: "avatars" | "banners", file: File) {
    setBusy(true);
    setError("");
    try {
      const data = await readImage(file);
      const updated = await api.uploadProfileImage(kind, data);
      // The response carries the new hash, so re-render from it.
      onSaved(updated);
      onCancel();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const updated = await api.setProfile({
        displayName,
        bio: newBio,
        pronouns: newPronouns,
        accentColor: accent,
      });
      onSaved(updated);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-editor">
      <div className="profile-editor-row">
        <label className="settings-field">
          <span>Display name</span>
          <input
            type="text"
            maxLength={32}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>Avatar</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadImage("avatars", f);
              e.target.value = "";
            }}
          />
        </label>
        <label className="settings-field">
          <span>Banner</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadImage("banners", f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <label className="settings-field">
        <span>Pronouns</span>
        <input
          type="text"
          maxLength={32}
          value={newPronouns}
          onChange={(e) => setNewPronouns(e.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>About me ({newBio.length}/190)</span>
        <textarea
          rows={4}
          maxLength={190}
          value={newBio}
          onChange={(e) => setNewBio(e.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>Accent colour</span>
        <input
          type="color"
          value={accent || "#5865f2"}
          onChange={(e) => setAccent(e.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="profile-editor-actions">
        <button className="settings-save" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
        <button className="settings-danger" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Props {
  userId: string;
  /** Your own id enables the edit affordances. */
  currentUserId?: string;
  onProfileChanged?: (u: User) => void;
}

export function ProfilePanel({ userId, currentUserId, onProfileChanged }: Props) {
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [error, setError] = useState("");
  const [bioExpanded, setBioExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const isMe = userId === currentUserId;

  useEffect(() => {
    let alive = true;
    setProfile(null);
    setError("");
    setBioExpanded(false);
    setEditing(false);
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
  const clan = user.clan;
  const clanBadgeUrl =
    clan && clan.identity_enabled
      ? `https://cdn.discordapp.com/clan-badges/${clan.identity_guild_id}/${clan.badge}.png`
      : null;
  const nitroName = profile.premium_type ? NITRO_NAMES[profile.premium_type] : null;
  const pronouns = profile.user_profile?.pronouns;
  const mutualCount = profile.mutual_guilds?.length ?? 0;
  const isLongBio = bio != null && bio.length > 120;
  const shownBio = isLongBio && !bioExpanded ? (bio?.slice(0, 120) ?? "") + "…" : (bio ?? "");
  // Friend nickname takes priority over global_name
  const name = profile.nickname ?? displayName(user);
  const badges = profile.badges ?? [];
  const widgets = profile.widgets ?? [];

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
        <Avatar user={user} size={84} />
      </div>
      <div className="profile-card">
        {isMe && editing ? (
          <ProfileEditor
            user={user}
            bio={bio ?? ""}
            pronouns={pronouns ?? ""}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              setProfile((p) =>
                p
                  ? {
                      ...p,
                      user: { ...p.user, ...updated },
                      user_profile: {
                        ...p.user_profile,
                        bio: updated.bio,
                        pronouns: updated.pronouns,
                      },
                    }
                  : p,
              );
              onProfileChanged?.(updated);
              setEditing(false);
            }}
          />
        ) : (
          <>
        <div className="profile-name-row">
          <div className="profile-name">{name}</div>
          {nitroName && <span className="nitro-badge">{nitroName}</span>}
        </div>
        <div className="profile-subline">
          <span className="profile-username">@{user.username}</span>
          {pronouns && <span className="profile-pronouns-inline">• {pronouns}</span>}
          {clanBadgeUrl && clan && (
            <span className="clan-badge">
              <img src={clanBadgeUrl} alt="" loading="lazy" />
              {clan.tag}
            </span>
          )}
          {mutualCount > 0 && (
            <span className="profile-mutual-inline">• {mutualCount} Mutual Servers</span>
          )}
        </div>
        {badges.length > 0 && (
          <div className="profile-badges">
            {badges.map((b) => (
              <img
                key={b.id}
                className="profile-badge"
                src={badgeUrl(b.icon)}
                alt={b.description}
                title={b.description}
                loading="lazy"
              />
            ))}
          </div>
        )}
        {bio && (
          <>
            <div className="profile-section-title">About Me</div>
            <div
              className="profile-bio"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(shownBio ?? "") }}
            />
            {isLongBio && (
              <button className="view-full-bio" onClick={() => setBioExpanded((v) => !v)}>
                {bioExpanded ? "Show Less" : "View Full Bio"}
              </button>
            )}
          </>
        )}
        {widgets.map((w) => (
          <div key={w.id} className="profile-widget">
            {w.data.header && (
              <div className="profile-section-title">{w.data.header}</div>
            )}
            {w.data.sections?.map((s, i) => (
              <div key={i} className="widget-section">
                {s.title && <div className="widget-title">{s.title}</div>}
                {s.subtitle && <div className="widget-subtitle">{s.subtitle}</div>}
                {s.description && <div className="widget-desc">{s.description}</div>}
                {s.image && (
                  <img
                    className="widget-image"
                    src={widgetImageUrl(s.image.file_id)}
                    alt={s.title ?? ""}
                    loading="lazy"
                  />
                )}
              </div>
            ))}
          </div>
        ))}
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
        {isMe && (
          <button
            className="profile-edit-btn"
            onClick={() => setEditing(true)}
          >
            Edit profile
          </button>
        )}
          </>
        )}
      </div>
    </aside>
  );
}
