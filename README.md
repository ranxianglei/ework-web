# ework

Standalone multi-project issue tracker. Local SQLite-backed, no external API dependency. Bun + TypeScript + SSR HTML + vanilla JS.

Born as a fork of [`awork-web`](../awork-web) — same SSR/vanilla-JS shell, same OpenCode session viewer / file viewer / translate / TTS modules, but **Gitea stripped out**: issues / comments / labels / reactions / attachments live in a local SQLite DB, served under the same `/<owner>/<repo>/issues/<n>` URL shape for muscle-memory parity.

## Features

- **Multi-project issues** — `/<owner>/<repo>/issues/<n>` URLs, one DB holds all projects
- **Comments** with markdown (marked + highlight.js + DOMPurify), code highlighting, linkify
- **Attachments** — image/pdf/etc upload, stored on local filesystem, streamed via `Bun.file`
- **Labels & reactions** — per-project labels, 9-emoji reactions on comments
- **OpenCode session viewer** — read-only `/sessions`, hot bars, translate, TTS (parity with awork-web)
- **File viewer** — `/file?path=…` with security gate (path validation + denylist + realpath)
- **Inline translation + TTS** — OpenAI-compatible `/v1/chat/completions` + `/v1/audio/speech`
- **Token-cookie auth** — single shared token + HMAC-signed cookie (30d)
- **Rate limiting** — token bucket on `/api/*`, `/login`, translate, TTS, settings

## Quick start

```bash
cp .env.example .env       # fill WORK_TOKEN + WORK_COOKIE_SECRET
bun install
bun run check              # tsc --noEmit
bun run dev                # :1196 watch (or bun start for one-shot)
```

Open `http://127.0.0.1:1196/login`, enter your token, land on `/projects`.

## Configuration

All env vars prefixed `WORK_*` (vs awork-web's `AWORK_WEB_*`). Zod-validated in `src/config.ts`.

| Var | Default | Purpose |
|---|---|---|
| `WORK_PORT` | `1196` | Listen port |
| `WORK_HOST` | `127.0.0.1` | Bind host (use `::` for IPv6 remote) |
| `WORK_TOKEN` | — | Required access token (≥8 chars) |
| `WORK_COOKIE_SECRET` | — | HMAC secret for auth cookie (≥8 chars) |
| `WORK_OPERATOR_LOGIN` | `dog` | Author attribution for writes |
| `WORK_WRITES_ENABLED` | `true` | Gate all write ops |
| `WORK_DB_PATH` | `$XDG_DATA_HOME/ework/ework.db` | SQLite DB location |
| `WORK_ATTACHMENT_ROOT` | `$XDG_DATA_HOME/ework/attachments` | Attachment files root |

Plus OpenCode / translate / TTS / file-viewer vars — see `.env.example` and `src/config.ts`.

## Project layout

```
src/
├── index.ts             # Bun.serve :1196 + route dispatch + security headers
├── config.ts            # Zod env validation (no gitea block)
├── auth.ts              # token + HMAC cookie
├── store.ts             # SQLite data layer (projects/issues/comments/labels/reactions/attachments)
├── schema.sql           # DDL applied on boot
├── db.ts                # rawDB handle + config table CRUD
├── attachments.ts       # filesystem blob storage + Bun.file streaming
├── ratelimit.ts         # token bucket
├── opencode.ts          # OpenCode CLI client (read-only)
├── translate.ts         # OpenAI-compatible translation
├── fileview.ts          # file/dir viewer + security gate
├── reactions.ts         # hydrate reactions onto CommentView[]
├── render/
│   ├── layout.ts        # SSR layout + THEME_CSS + utils
│   ├── markdown.ts      # marked + DOMPurify + linkify (no Gitea rewrite)
│   └── components.ts    # CommentView + renderCommentCard
├── views/
│   ├── issueThread.ts   # SSR issue thread (SQLite-backed)
│   ├── issueList.ts     # per-project list (with search + state tabs)
│   ├── issueNew.ts      # create-issue form
│   ├── issues.ts        # global feed (cross-project)
│   ├── home.ts          # projects list + new-project form
│   ├── sessionLog.ts    # OpenCode session viewer
│   └── settings.ts      # /settings form
└── static/
    ├── app.js           # issue-thread client (virtual scroll, poll, composer, reactions UI)
    ├── session.js       # session-viewer client
    ├── file.js          # file tail -f
    ├── tts.js           # TTS playback
    └── favicon.svg

scripts/deploy.sh        # tsc → rsync → bun install → systemctl restart ework
```

## URL / API surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | redirect → `/projects` |
| `GET/POST` | `/projects` | projects list / create new |
| `GET` | `/issues` | global feed (cross-project), `?state=&q=` |
| `GET` | `/<o>/<r>/issues` | per-project list, `?state=&q=` |
| `GET` | `/<o>/<r>/issues/new` | create form |
| `POST` | `/<o>/<r>/issues` | create (auto-creates project if missing) |
| `GET` | `/<o>/<r>/issues/<n>` | issue thread SSR |
| `GET` | `/api/<o>/<r>/issues/<n>/page?page=K` | fetch older comments page |
| `GET` | `/api/<o>/<r>/issues/<n>/since?since=ISO` | poll for new comments |
| `POST` | `/api/<o>/<r>/issues/<n>/comment` | `{body, close?, reopen?}` |
| `POST` | `/api/<o>/<r>/issues/<n>/upload` | multipart attachment upload |
| `GET` | `/attachments/<uuid>` | stream attachment (image inline, else download) |
| `GET` | `/sessions` `/sessions/:id` | OpenCode session browser |
| `GET` | `/file` `/file/raw` `/file/dl` | file viewer (path-gated) |
| `GET` | `/api/file/since` | tail -f polling |
| `POST` | `/api/translate` `/api/translate/stream` | inline translation |
| `POST` | `/api/tts` `GET /api/tts/stream/:id` | TTS staging + streaming |
| `GET/POST` | `/settings` | runtime overrides |
| `POST` | `/login` | token → cookie |

## Deploy

```bash
git add -A && git commit -m "..."    # commit first (deploy.sh rsyncs working tree)
./scripts/deploy.sh
```

First deploy prints a systemd unit template — install it once:

```bash
sudo tee /etc/systemd/system/ework.service >/dev/null <<'UNIT'
[Unit]
Description=ework
After=network.target
[Service]
Type=simple
User=dog
WorkingDirectory=/home/user/.local/share/ework
EnvironmentFile=/home/user/.local/share/ework/.env
ExecStart=/home/user/.bun/bin/bun /home/user/.local/share/ework/src/index.ts
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now ework
```

## Differences from awork-web

- **No Gitea dependency.** All issue data in local SQLite (`ework.db`).
- **Auth scope**: single-operator (`WORK_OPERATOR_LOGIN`) writing as one user. Schema reserves multi-user via `users` table; future work.
- **Auto-create project**: POSTing to `/<new_owner>/<new_repo>/issues` creates the project in one step. (No separate "create project" needed to start tracking, but the form exists on `/projects`.)
- **Default port `1196`** (awork-web is `1195`).
- **Writes default `true`** (humans use ework directly; awork-web defaults `false` as read-only mirror).
- **Native reactions** stored in SQLite (`reactions(comment_id, user_login, content)`). UI is read-only count aggregation in v1; add/remove endpoint wired but no UI yet.

## Scope

- ❌ No issue edit/delete (mirrors awork-web's contract).
- ❌ No milestones / assignees / PR / multi-user login (schema-compatible; not implemented).
- ❌ No migration tool from Gitea (fresh start; can be added later).
- ✅ **Never writes** to `opencode.db` (read-only SELECT, same invariant as awork-web).

## License

Private.
