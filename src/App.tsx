import { useEffect, useState } from "react";
import { api } from "./api";
import type { User } from "./types";
import { Login } from "./components/Login";
import { Main } from "./components/Main";
import { cacheDecoration } from "./components/Avatar";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Auto-login on startup: saved token first, then the dev token from
  // secret.env (debug builds only; null in release).
  useEffect(() => {
    let cancelled = false;

    async function autoLogin() {
      const saved = localStorage.getItem("disfast.token");
      const token = saved ?? (await api.getDevToken().catch(() => null));
      if (!token || cancelled) return;
      try {
        const user = await api.login(token);
        if (cancelled) return;
        localStorage.setItem("disfast.token", token);
        setUser(user);
        // Cache our own avatar decoration so it shows in the user bar
        api
          .getUserProfile(user.id)
          .then((p) => cacheDecoration(user.id, p.user.avatar_decoration_data?.asset))
          .catch(() => {});
      } catch (err) {
        // Saved token may be expired — fall back to the login screen and
        // show why auto-login failed.
        if (!cancelled) setBootError(String(err));
      }
    }

    autoLogin();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) {
    return <Login initialError={bootError} onLogin={setUser} />;
  }
  return (
    <Main
      user={user}
      onLoggedOut={() => {
        localStorage.removeItem("disfast.token");
        setUser(null);
      }}
    />
  );
}
