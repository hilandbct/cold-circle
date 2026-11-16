# Cold Circle

A lightweight, single-host chat/file/bulletin system inspired by Hotline. One
machine runs the server; multiple browser clients connect over the network.

This repository currently implements **Phase 0–7** of the technical spec: the
server skeleton, public chat, persistent DMs, file browser, bulletin board,
and the full admin panel with auto-reconnect.

## What's in this slice

- **Server** (`src/`): a single Node/TypeScript process that serves HTTP +
  WebSocket on one port.
  - Shared-passphrase auth → HMAC-style random session token (10-min sliding
    expiry), with a separate admin passphrase (role gating).
  - **Public chat**: an in-memory ring buffer per channel with a retention sweep.
    Messages broadcast to all connected clients; on join a client pulls the
    current window.
  - **Direct messages**: persisted on the server, relayed to the recipient if
    online, retrievable via `dm_history` (spec §3.4.2).
  - **Presence**: `user_join` / `user_leave` so clients can see who's online.
  - **Admin panel**: server info, channel create/delete/retention, file audit,
    DM audit, bulletin delete, user ban/unban, channel list.
  - **Auto-reconnect**: transient disconnects trigger automatic reconnection.
  - `GET /health` JSON endpoint; the browser client is served at `/`.
- **Client** (`public/index.html`): a single-file, dark terminal-styled chat UI.
  Connect screen, chat pane (chronological, auto-scrolls to the newest
  message), channel selector, "retention window" indicator, presence list,
  DM panel (click any online handle to start a conversation), local DM
  persistence via localStorage, file browser (upload / download / delete),
  bulletin board (post / delete), admin panel with tabbed sections, ping
  keepalive, and auto-reconnect. All server text is rendered via
  `textContent` (XSS-safe).  The passphrase is kept in memory only — never
  written to localStorage.

## Requirements

- Node.js **20+** (developed against Node 22).

## Setup & run

```sh
npm install
cp coldcircle.config.example.yaml coldcircle.config.yaml   # then edit passphrases
npm run build        # tsc -> dist/
npm start            # serves http + ws on the configured port
```

Then open `http://127.0.0.1:8443/` in two browser tabs, enter the shared
passphrase in each, and chat.

> The default config runs **plain http + ws**. For any network exposure, set
> `server.tls.cert` / `server.tls.key` in the config so it serves **https + wss**.
> The passphrase must only ever travel over the encrypted channel.

## Verify

With the server running, the smoke test drives two simulated clients through
auth, broadcast, history, and the auth checks:

```sh
npm start            # in one terminal
npm run smoke        # in another
```

Override the target with `COLD_CIRCLE_TEST_URL=ws://host:port npm run smoke`.

## Configuration

All settings live in `coldcircle.config.yaml` (see
`coldcircle.config.example.yaml`). Omitted fields fall back to sensible defaults.
This file holds secrets, so it is git-ignored — only the `.example` version is
tracked.

## Wire protocol (this slice)

All WebSocket frames are one JSON object per frame.

| Dir | op | payload |
|-----|-----|---------|
| C→S | `auth` | `passphrase`, `handle` |
| S→C | `auth_ok` | `session`, `role`, `handle`, `retention_sec` |
| S→C | `auth_fail` | `reason` |
| C→S | `chat_send` | `channel`, `body`, `session` |
| S→C | `chat_msg` | `channel`, `handle`, `ts`, `body`, `id` |
| C→S | `chat_history` | `channel`, `limit`, `session` |
| S→C | `chat_history` | `channel`, `messages[]` (newest-first) |
| S→C | `user_join` / `user_leave` | `handle`, `ts` |
| C→S | `ping` | — |
| S→C | `pong` | `ts` |
| C→S | `dm_send` | `to`, `body`, `conv_id`, `session` |
| S→C | `dm_recv` | `from`, `to`, `body`, `conv_id`, `ts` |
| S→C | `dm_norecipient` | `to` |
| C→S | `dm_history` | `conv_id`, `limit`, `session` |
| S→C | `dm_history` | `conv_id`, `messages[]` (oldest-first) |
| S→C | `error` | `code`, `message` |
| C→S | `file_upload` | `name`, `size`, `upload_id`, `action`, `data`, `session` |
| S→C | `file_start_ok` | `upload_id`, `size` |
| C→S | `file_list` | `session` |
| S→C | `file_list` | `entries[]`, `disk_usage` |
| C→S | `file_download` | `name`, `session` |
| S→C | `file_download` | `name`, `data` (base64) |
| C→S | `file_delete` | `name`, `session` |
| C→S | `bulletin_post` | `body`, `session` |
| S→C | `bulletin_entry` | `id`, `handle`, `ts`, `body` |
| C→S | `bulletin_list` | `limit`, `session` |
| S→C | `bulletin_list` | `entries[]` |

See `src/protocol.ts` for the canonical type definitions and the spec §5 for the
full protocol across all phases.

## About

Cold Circle is a lightweight, single-host chat and file-sharing system inspired
by [Hotline Miami](https://en.wikipedia.org/wiki/Hotline_Miami)'s direct,
no-frills aesthetic. One machine runs the server; multiple browser clients
connect over the network — no databases, no build pipelines, no external
dependencies.

**What it does:**

| Feature | Status |
|---------|--------|
| Shared-passphrase auth (user + admin) | ✅ Phase 1 |
| Public chat with ring-buffer channels | ✅ Phase 0 |
| Channel creation / deletion / retention | ✅ Phase 5 |
| Direct messages (server-persisted, auto-deliver) | ✅ Phase 3 |
| Presence (who's online) | ✅ Phase 1 |
| File browser (upload / download / delete) | ✅ Phase 4 |
| Bulletin board (post / delete) | ✅ Phase 4 |
| Admin panel (server info, bans, DM audit) | ✅ Phase 5–6 |
| Auto-reconnect on disconnect | ✅ Phase 6 |
| Channel retention window | ✅ Phase 5–6 |
| Retention sweep (expired messages pruned) | ✅ Phase 0 |

**What it doesn't do (by design):**

- No databases — all state lives in memory, dropped on server restart.
- No email, no social graph, no accounts.
- No push notifications, no mobile apps.
- No message encryption beyond TLS/WSS.

Cold Circle is meant for small, trusted groups: LAN parties, dev teams, or
anyone who wants a chat room that fits on one machine and disappears cleanly
when the process exits.

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 0 | Server skeleton, public chat, ring buffer | ✅ Done |
| 1 | Auth, presence, ping keepalive, reconnect | ✅ Done |
| 2 | Rate limiting, error handling | ✅ Done |
| 3 | Direct messages (server-persisted) | ✅ Done |
| 4 | File browser (upload / download / delete) | ✅ Done |
| 5 | Bulletin board, admin protocol, channel mgmt | ✅ Done |
| 6 | Admin UI, auto-reconnect, disconnect button | ✅ Done |
| 7 | P2 polish (isAdmin, ban handlers, CSS) | ✅ Done |
| 8 | Registry discovery (mDNS / broadcast) | 📋 Planned |
| 9 | Draggable desktop frame UI | 📋 Planned |

Full spec details are in the technical specification document (spec.md).
