import { useState } from "react";
import { api } from "../api";
import type { User } from "../types";

interface Props {
  initialError: string | null;
  onLogin: (user: User) => void;
}

export function Login({ initialError, onLogin }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token.trim() || busy) return;
    setError("");
    setBusy(true);
    try {
      const user = await api.login(token.trim());
      localStorage.setItem("disfast.token", token.trim());
      onLogin(user);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-view">
      <div className="login-card">
        <h1>DisFast</h1>
        <p className="subtitle">Discord, minus the weight.</p>
        <input
          type="password"
          placeholder="Your Discord token"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit} disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        {error && <p className="error">{error}</p>}
        <details className="token-help">
          <summary>How do I get my token?</summary>
          <ol>
            <li>Open discord.com in a browser and log in.</li>
            <li>Open DevTools (F12) → Network tab.</li>
            <li>Refresh, click any request to <code>discord.com/api</code>.</li>
            <li>Copy the <code>Authorization</code> header value.</li>
          </ol>
          <p className="warn">
            Note: third-party clients violate Discord's ToS. Rare, but bans
            happen. Use at your own risk — never share your token.
          </p>
        </details>
      </div>
    </div>
  );
}
