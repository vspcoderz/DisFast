import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api";
import type { PresenceStatus, User } from "../types";

/** Local-only preferences — no Discord account storage involved. */
interface Prefs {
  notifications: boolean;
  notificationSounds: boolean;
  sendTyping: boolean;
  messageFont: number;
  compactMode: boolean;
  theme: "dark" | "light" | "system";
  accent: string;
  reduceMotion: boolean;
  showMemberList: boolean;
  muteAll: boolean;
}

const PREFS_KEY = "disfast.prefs";

const DEFAULT_PREFS: Prefs = {
  notifications: true,
  notificationSounds: true,
  sendTyping: true,
  messageFont: 15,
  compactMode: false,
  theme: "dark",
  accent: "#5865f2",
  reduceMotion: false,
  showMemberList: true,
  muteAll: false,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const STATUS_OPTIONS: { value: PresenceStatus; label: string }[] = [
  { value: "online", label: "Online" },
  { value: "idle", label: "Idle" },
  { value: "dnd", label: "Do Not Disturb" },
  { value: "invisible", label: "Invisible" },
];

interface Props {
  user: User;
  open: boolean;
  onClose: () => void;
  onPrefsChange: (p: Prefs) => void;
  onLoggedOut: () => void;
}

export function Settings({ user, open, onClose, onPrefsChange, onLoggedOut }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [tab, setTab] = useState<"user" | "main">("user");
  const [status, setStatus] = useState<PresenceStatus>(user.status ?? "online");
  const [customText, setCustomText] = useState(user.custom_status?.text ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Load persisted preferences once and reflect them to the app.
  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);
  useEffect(() => {
    onPrefsChange(prefs);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // private mode — preferences just won't persist
    }
  }, [prefs, onPrefsChange]);

  // Appearance preferences are applied as CSS variables / attributes.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", prefs.accent);
    root.dataset.theme = prefs.theme;
    if (prefs.reduceMotion) {
      root.dataset.reduceMotion = "true";
    } else {
      delete root.dataset.reduceMotion;
    }
  }, [prefs.accent, prefs.theme, prefs.reduceMotion]);

  // Esc to close + focus the dialog so keyboard users land inside it.
  // Uses a ref for the handler so re-renders can't leave a stale listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const updated = await api.setStatus(status, customText.trim());
      // Reflect what Discord accepted rather than what we asked for.
      setStatus(updated.status ?? status);
      setCustomText(updated.custom_status?.text ?? "");
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <nav className="settings-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "user"}
            className={`settings-tab${tab === "user" ? " active" : ""}`}
            onClick={() => setTab("user")}
          >
            User
          </button>
          <button
            role="tab"
            aria-selected={tab === "main"}
            className={`settings-tab${tab === "main" ? " active" : ""}`}
            onClick={() => setTab("main")}
          >
            Main
          </button>
        </nav>

        {tab === "main" ? (
          <>
            <section className="settings-section">
              <h3>Appearance</h3>
              <label className="settings-field">
                <span>Theme</span>
                <select
                  value={prefs.theme}
                  onChange={(e) =>
                    setPrefs((p) => ({
                      ...p,
                      theme: e.target.value as Prefs["theme"],
                    }))
                  }
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Follow system</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Accent colour</span>
                <input
                  type="color"
                  value={prefs.accent}
                  onChange={(e) => setPrefs((p) => ({ ...p, accent: e.target.value }))}
                />
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.reduceMotion}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, reduceMotion: e.target.checked }))
                  }
                />
                <span>Reduce motion</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.compactMode}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, compactMode: e.target.checked }))
                  }
                />
                <span>Compact message spacing</span>
              </label>
              <label className="settings-field">
                <span>Message font size</span>
                <input
                  type="range"
                  min={13}
                  max={20}
                  step={1}
                  value={prefs.messageFont}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, messageFont: Number(e.target.value) }))
                  }
                />
                <output>{prefs.messageFont}px</output>
              </label>
            </section>

            <section className="settings-section">
              <h3>Notifications</h3>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.notifications}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, notifications: e.target.checked }))
                  }
                />
                <span>Desktop notifications for mentions</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.notificationSounds}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, notificationSounds: e.target.checked }))
                  }
                />
                <span>Notification sounds</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.muteAll}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, muteAll: e.target.checked }))
                  }
                />
                <span>Mute all notifications</span>
              </label>
              <p className="settings-note">
                Muted channels on discord.com aren't synced — DisFast tracks its
                own notification preferences.
              </p>
            </section>

            <section className="settings-section">
              <h3>Interface</h3>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.sendTyping}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, sendTyping: e.target.checked }))
                  }
                />
                <span>Send typing indicators</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={prefs.showMemberList}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, showMemberList: e.target.checked }))
                  }
                />
                <span>Show member list in servers</span>
              </label>
            </section>

            <section className="settings-section">
              <h3>Data</h3>
              <p className="settings-note">
                Preferences, server folders and your token are stored locally in
                this app.
              </p>
              <button
                className="settings-secondary"
                onClick={() => {
                  localStorage.removeItem(PREFS_KEY);
                  localStorage.removeItem("disfast.guildFolders");
                  localStorage.removeItem("disfast.collapsedFolders");
                  setPrefs({ ...DEFAULT_PREFS });
                }}
              >
                Reset all local settings
              </button>
              <button
                className="settings-secondary"
                onClick={() => {
                  // Drop cached images by reloading; nothing is persisted
                  // server-side, so there is no other cache to clear.
                  window.location.reload();
                }}
              >
                Reload app
              </button>
            </section>

            <section className="settings-section">
              <h3>About</h3>
              <p className="settings-note">
                <strong>DisFast</strong> alpha
                <br />
                A lightweight Discord client — Tauri + Rust + React.
                <br />
                Third-party clients are against Discord&apos;s ToS; use at your
                own risk.
              </p>
            </section>
          </>
        ) : (
          <>
        <section className="settings-section">
          <h3>Status</h3>
          <label className="settings-field">
            <span>Presence</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as PresenceStatus)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>Custom status</span>
            <input
              type="text"
              maxLength={128}
              placeholder="What's happening?"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="settings-save" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save status"}
          </button>
        </section>

        <section className="settings-section">
          <h3>Preferences</h3>
          <p className="settings-note">
            Appearance, notifications and data options live in the{" "}
            <strong>Main</strong> tab.
          </p>
        </section>

        <section className="settings-section">
          <h3>Account</h3>
          <p className="settings-note">
            Signed in as <strong>{user.username}</strong> (token stored locally in this
            app only).
          </p>
          <button className="settings-danger" onClick={onLoggedOut}>
            Log out
          </button>
        </section>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Tauri rejections arrive as "Error: <message>". Strip the prefix and
 * collapse anything that still looks like a raw API payload.
 */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/^Error:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type { Prefs };