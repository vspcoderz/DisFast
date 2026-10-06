# DisFast

A fast, lightweight Discord client. Native Rust backend (Tauri +
`twilight-gateway` + `reqwest`), React + TypeScript frontend (Vite).
No Electron, no Chromium bundle.

> **Warning:** Third-party clients using your account token violate Discord's
> Terms of Service. Enforcement is rare but account bans do happen.
> **Use at your own risk. Never share your token with anyone.**

## Why it's fast

| | Official Discord | DisFast |
|---|---|---|
| Runtime | Electron (bundled Chromium + Node) | System WebView + native Rust |
| Idle RAM | ~500 MB – 1.5 GB | ~40–80 MB (target) |
| Discord API | JS in renderer | Rust, direct gateway connection |
| Frontend deps | React + hundreds of packages | None. Vanilla JS, no build step |

## Run it

```sh
npm install         # once — Vite, React, Tauri CLI
npm run tauri:dev   # dev mode: Vite hot-reload + Rust backend
npm run tauri:build # release binary (in src-tauri/target/release/bundle)
```

Requires: Rust toolchain, a system WebView (`webkit2gtk-4.1` on Linux —
already present on most desktops).

In debug builds the app auto-logs-in from `secret.env` in the project root
(format: `key="your-token"`). That file is gitignored — never commit it.
Release builds never read token files.

## Roadmap

- [x] **Phase 1 — Text core:** login, server list, DMs, channels, live
      messages (gateway), send messages, image attachments
- [ ] **Phase 2 — Daily-driver features:** desktop notifications, unread
      badges, markdown rendering, message history paging, embeds
- [ ] **Phase 3 — Perf hardening:** virtualized message list, disk cache for
      messages/avatars, lazy guild loading, measured benchmarks vs. official
      client
- [ ] **Phase 4 — Voice/video:** webview fallback for calls first; a fully
      custom voice stack is blocked on Discord's E2EE (DAVE/MLS) protocol,
      which no third-party library supports yet
