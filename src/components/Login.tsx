import { useState } from "react";
import { api } from "../api";
import type { User } from "../types";

interface Props {
  initialError: string | null;
  onLogin: (user: User) => void;
}

type Mode = "password" | "totp";

export function Login({ initialError, onLogin }: Props) {
  const [mode, setMode] = useState<Mode>("password");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);

  async function signIn(token: string) {
    const user = await api.login(token);
    localStorage.setItem("disfast.token", token);
    onLogin(user);
  }

  async function submitCredentials() {
    if (!login.trim() || !password || busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await api.authLogin(login.trim(), password);
      if (res.status === "success" && res.token) {
        await signIn(res.token);
      } else if (res.status === "mfa_required" && res.ticket) {
        // Keep the password in memory for the follow-up step only.
        setTicket(res.ticket);
        setMode("totp");
      } else if (res.status === "captcha_required") {
        setError(
          "Discord is asking for a captcha. Use the token method below instead.",
        );
      } else {
        setError(res.message ?? "Login failed");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp() {
    if (!code.trim() || busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await api.authMfaTotp(ticket, code.trim());
      if (res.status === "success" && res.token) {
        await signIn(res.token);
      } else if (res.status === "captcha_required") {
        setError("Captcha required mid-login. Use the token method instead.");
      } else {
        setError("Invalid 2FA code — check your authenticator and retry.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitToken() {
    if (!token.trim() || busy) return;
    setError("");
    setBusy(true);
    try {
      await signIn(token.trim());
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

        {mode === "password" ? (
          <>
            <input
              type="text"
              placeholder="Email or username"
              autoComplete="username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCredentials()}
            />
            <button onClick={submitCredentials} disabled={busy}>
              {busy ? "Signing in…" : "Log in"}
            </button>
          </>
        ) : (
          <>
            <p className="subtitle">Two-factor authentication</p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="6-digit code from your authenticator"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitTotp()}
            />
            <button onClick={submitTotp} disabled={busy}>
              {busy ? "Verifying…" : "Verify code"}
            </button>
            <button
              className="login-secondary"
              onClick={() => {
                setMode("password");
                setCode("");
                setTicket("");
              }}
            >
              Back
            </button>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <details className="token-help">
          <summary>Use a token instead</summary>
          <p>
            Paste your token if password login is blocked (captcha, unusual
            account flags). Get it from DevTools → Network → any discord.com/api
            request → <code>Authorization</code> header.
          </p>
          <input
            type="password"
            placeholder="Your Discord token"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitToken()}
          />
          <button className="login-secondary" onClick={submitToken} disabled={busy}>
            Log in with token
          </button>
          <p className="warn">
            Note: third-party clients violate Discord's ToS. Rare, but bans
            happen. Use at your own risk — never share your token.
          </p>
        </details>
      </div>
    </div>
  );
}