import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api";
import type { PresenceStatus, User } from "../types";

/** Local-only preferences — no Discord account storage involved. */
interface Prefs {
  notifications: boolean;
  sendTyping: boolean;
  messageFont: number;
  compactMode: boolean;
}

const PREFS_KEY = "disfast.prefs";

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw
      ? { notifications: true, sendTyping: true, messageFont: 15, compactMode: false, ...JSON.parse(raw) }
      : { notifications: true, sendTyping: true, messageFont: 15, compactMode: false };
  } catch {
    return { notifications: true, sendTyping: true, messageFont: 15, compactMode: false };
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

  // Esc to close + focus the dialog so keyboard users land inside it.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      setError(String(e));
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
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.notifications}
              onChange={(e) => setPrefs((p) => ({ ...p, notifications: e.target.checked }))}
            />
            <span>Desktop notifications for mentions</span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.sendTyping}
              onChange={(e) => setPrefs((p) => ({ ...p, sendTyping: e.target.checked }))}
            />
            <span>Send typing indicators</span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.compactMode}
              onChange={(e) => setPrefs((p) => ({ ...p, compactMode: e.target.checked }))}
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
          <h3>Account</h3>
          <p className="settings-note">
            Signed in as <strong>{user.username}</strong> (token stored locally in this
            app only).
          </p>
          <button className="settings-danger" onClick={onLoggedOut}>
            Log out
          </button>
        </section>
      </div>
    </div>
  );
}

export type { Prefs };