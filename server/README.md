# Dragonchess multiplayer server

A self-hosted, authoritative multiplayer server for Dragonchess. It replaces the
old Firebase backend entirely. There is **no runtime dependency on Firebase,
`firebaseapp.com`, `firebaseio.com`, or `gstatic.com/firebasejs`**, and passwords
are never hashed with MD5, SHA-1, or a single fast SHA-256 hash.

Stack: Node.js + TypeScript + Socket.IO v4 + SQLite (better-sqlite3) + **bcrypt
with a pepper** password hashing. The server holds the only authoritative copy of
every game; the browser submits moves and the server validates them with the same
rules engine that ships inline in `index.html` (verified by a 27-test parity suite).

## What it provides

- Plain HTTP on `127.0.0.1:3543` (env `HOST`, `PORT`). Never exposed directly
  to remote browsers.
- `GET /health` → `{"status":"ok"}`.
- Socket.IO at path `/socket.io/` (same-origin via Nginx; the browser never
  uses a hard-coded `ws://` URL or connects directly to `127.0.0.1:3543`).
- **Accounts**: username (3–20 chars, `[A-Za-z0-9_-]`, unique
  case-insensitive, display casing preserved) + password (8–128 code points).
  Passwords are hashed with **bcrypt** at cost `BCRYPT_COST` (default 12),
  combined with a server-side **pepper** (`PASSWORD_PEPPER`). The input to bcrypt
  is `base64url(HMAC-SHA256(pepper, password))` (43 chars), with a **unique random
  salt per hash**. The pepper is never stored alongside the hash; losing or
  changing it invalidates every existing password. Passwords, the pepper, the
  HMAC output, and the bcrypt hash are never logged, never sent in API responses,
  never cached in the browser. There is no MD5 / SHA-1 / Argon2 / reversible
  encryption anywhere in the code path.
- **Legacy Argon2id accounts**: accounts created under the previous Argon2
  scheme are flagged `requires_reset=1` (migration `0002`). A legacy login
  returns `403 'reset-required'` and refuses to authenticate; an admin must
  reset the password (see **Admin reset** below). There is no silent Argon2
  fallback at login.
- **Sessions**: persistent opaque server-side sessions. The server generates
  ≥32 random bytes, stores only a SHA-256 hash, and returns the raw token only
  to its owner in an **HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=2592000**
  cookie with no `Domain` attribute. The production cookie is named
  `__Host-dragonchess_session`; in development it is `dragonchess_session`
  (no `__Host-` prefix, no `Secure`). The frontend cannot read the production
  cookie. `GET /api/auth/me` restores the session on load; logout deletes the
  session and expires the cookie. Login-time equalization: a missing or unknown
  username runs a dummy bcrypt verify (constant-ish work) so login latency does
  not reveal whether a username exists.
- **SQLite persistence**: better-sqlite3 with `foreign_keys=ON` and WAL. Tables:
  `users`, `sessions`, `games`, `game_moves` (plus indexes), managed by a
  one-way migration runner (`server/migrations/*.sql`, tracked in the
  `migrations` table). Accounts, sessions, ratings, and **completed** game
  history survive restarts. **Active (unfinished) rooms live only in process
  memory and are lost on restart** — finish a game for it to be persisted.
- **Authentication is required.** There is no guest mode, no local
  pass-and-play fallback, and no lobby or boards visible while logged out.
  The Socket.IO `io.use` middleware reads the same session cookie from the
  handshake and attaches `socket.data.user`; a client-submitted user id or
  username is never trusted. One authenticated account cannot occupy both seats
  in a room. The per-room seat token is separate from the account session cookie.
- **Online lobby / start flows**:
  - **Find Match** (rated) — queues the player in an in-memory matchmaking
    queue. The server picks the **closest-Elo** opponent, breaking ties by
    **longest wait** (earliest `joinedAt`), in a synchronous atomic match. Seat
    colour is assigned by `randomColour()` (crypto-random Gold/Scarlet), so the
    joiner does not always get the same colour. A matched game auto-starts; both
    clients receive `matchmaking:matched` with their token, seat, full state,
    and `rated:true`.
  - **Host** (unranked, private) — creates a room with a 6-character join code.
    The host is Gold. The game **auto-starts** when the second seat joins; there
    is no ready-up and no separate start event.
  - **Join** (unranked) — joins a room by its 6-character code. The joiner is
    Scarlet. Auto-starts on join.
- **Elo ratings**: start 1000, K=32, standard expected-score formula. **Rated
  only for Find Match (matchmaking) games.** Host/Join and rematches are always
  unranked. The update is **idempotent** via a `rating_applied_at` transactional
  guard, applied once a game reaches a valid terminal result. Resignation counts
  as a win/loss. W/D/L and `games_played` update in the same transaction. Ratings
  are rounded and never go negative. A `profile:refresh` Socket.IO event is
  broadcast to the player after a rating change. Displayed as plain "1000 Elo"
  (no tiers).
- **Rematches**: require **both** seats to request it (`game:rematch` returns
  `true` and starts the new game only on the second confirmation; otherwise it
  returns the current seat with `started:false`). On rematch the **entire seat
  records are swapped** (the seat token travels with the seat), so colours
  alternate: the player who was Gold becomes Scarlet and vice-versa. A rematch
  is always unranked and creates a **new game record** linked to the previous one
  via `rematchOf` (migration `0003`). `game:rematch:cancel` cancels a pending
  request. A disconnected queued/matched player is given a short grace window
  before removal.
- **Game history**: `GET /api/profile/history?page&pageSize` (auth required)
  lists completed games as Gold or Scarlet, newest first, with opponent, colour,
  result, reason, rated flag, rating before/after/change, timestamps, and move
  count. `GET /api/games/:gameId` (auth required, participant only) returns both
  participants, result, rating changes, the full move list, and the final board
  state.
- **Sanitized payloads**: every Socket.IO state and API response exposes only
  `{userId, username, rating, wins, losses, connected}` per player. Password
  hashes, the pepper, session tokens, session hashes, seat-token hashes, and
  internal socket ids are never included in any payload.
- **Human-readable last move**: each move is broadcast/stored with a friendly
  string such as `"Warrior – G B2 → B4"` (piece name, colour, FROM → TO), in
  addition to the canonical engine notation.
- In-memory room store with ~24h eviction for **active** games.

### API summary

| Method | Path                        | Auth | Purpose                                  |
|--------|-----------------------------|------|------------------------------------------|
| POST   | `/api/auth/register`        | no   | Create account, sets session cookie.     |
| POST   | `/api/auth/login`           | no   | Log in, sets session cookie.             |
| POST   | `/api/auth/logout`           | no   | Delete session, expire cookie.           |
| GET    | `/api/auth/me`              | yes  | Current profile (auto-login).            |
| GET    | `/api/profile/history`      | yes  | Completed games (paginated).              |
| GET    | `/api/games/:gameId`        | yes  | Full game detail (participant only).      |

All responses use `{ok:true,data}` / `{ok:false,error:{code,message}}`. Password
hashes and session token hashes are never exposed via APIs, logs, Socket.IO
state, or frontend HTML.

### Socket.IO events (client → server)

| Event                   | Purpose                                                       |
|-------------------------|---------------------------------------------------------------|
| `game:create`           | Host an unranked private room; ack returns code + Gold seat + state. |
| `game:join`             | Join a room by 6-char code; auto-starts; ack returns Scarlet seat + state. |
| `game:resume`           | Rejoin via stored code+token; ack returns seat + state.        |
| `game:move`             | Submit a move (server-authoritative validation); ack returns new state. |
| `game:resign`           | Resign; ack returns terminal state.                           |
| `draw:offer` / `draw:answer` | Offer / accept-or-decline a draw; ack returns state.      |
| `game:rematch`          | Request rematch (two-player confirmation, swaps colours); ack returns new state on the second confirmation. |
| `game:rematch:cancel`   | Cancel a pending rematch request.                              |
| `game:leave`            | Leave the room.                                               |
| `matchmaking:join`      | Enter the Find Match queue (rated); ack `{queued:true}` while waiting, `{queued:false}` when matched. |
| `matchmaking:cancel`    | Leave the queue.                                              |

### Socket.IO events (server → client)

The server pushes only these. All other results come back via the client→server
ack callbacks above.

| Event                | Payload                              | When                                        |
|----------------------|--------------------------------------|---------------------------------------------|
| `game:state`         | `PublicGameState`                    | Any state change (move/resign/draw/rematch/reconnect). The client derives start (`status:'active'`) and end (`status:'finished'`+`winner`). |
| `game:error`         | `{code,message}`                     | Rejected move / out-of-turn / stale version.|
| `matchmaking:matched`| `MatchedPayload` (code+token+seat+state+rated) | A Find Match pairing is formed.     |
| `matchmaking:status` | `{waiting,queueSize,elapsedMs}`       | Queue position updates while waiting.       |
| `profile:refresh`    | `ProfilePayload`                     | Pushed after a rating change (Elo update).  |

`PublicGameState` carries `players` (sanitized `PublicPlayer` per seat:
`{userId,username,rating,wins,draws,losses,connected}`), `lastMove` (human-readable
string, `""` before the first move), `rated`, `rematchCount`, `rematchRequests`
per seat, plus the board/turn/history. No secrets appear in any payload.

## Layout

```
server/
  src/            TypeScript backend (never deployed into the public web dir)
  test/           168 tests: 27 engine parity + auth/repo/matchmaking/server/multiplayer-auth
  migrations/     plain .sql migrations, applied in order at startup
  deploy/         systemd unit example
  Dockerfile      multi-stage container build (Node version via build-arg)
  dist/           build output (created by npm run build; migrations copied in the image)
docker-compose.yml   root compose: builds + runs the server, pins Node version
.dockerignore        root build-context ignore list
```

## Develop

```sh
cd server
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run  (168 tests)
npm run build         # tsc -> dist/
npm run dev           # tsx watch src/server.ts  (127.0.0.1:3543, NODE_ENV=development)
```

In dev the cookie is `dragonchess_session` (no `__Host-` prefix, no `Secure`)
so it works over plain HTTP on localhost. A development pepper fallback
(`DEV_PEPPER`) is used when `PASSWORD_PEPPER` is unset, with a one-time warning —
**production refuses to start without a real `PASSWORD_PEPPER`**.

## Admin reset (legacy accounts / password resets)

`admin:reset` is a CLI that resets a user's password using the same bcrypt+pepper
pipeline as the server. It is the only way to recover a legacy Argon2 account
(flagged `requires_reset=1`); after reset the flag is cleared so the user can log
in again. It reads `PASSWORD_PEPPER` from the environment and must be run with the
same pepper the server uses, or the new password will not validate.

```sh
cd server
PASSWORD_PEPPER='<your production pepper>' BCRYPT_COST=12 \
  npm run admin:reset -- alice 'new-strong-password'
# -> "Password reset for alice." (never prints the password)
```

Requires `NODE_ENV=production` + `PASSWORD_PEPPER` (or a dev environment). The
password is validated with the same rules as registration (8–128 code points,
not a blocklisted common password). The password itself is never logged.

## Docker (recommended for quick runs)

`docker-compose.yml` (at the repo root) builds and runs the server in a
container. The Node.js version is declared as a build arg (`NODE_VERSION: "20"`,
Node 20 LTS) and consumed by `server/Dockerfile`. Node ≥ 18 is required.

The base image is **`node:<ver>-slim` (Debian/glibc)** — deliberately *not* Alpine.
`better-sqlite3` v13 segfaults inside `new Database()` on musl/Alpine (and on glibc
too), so `package.json` pins **`better-sqlite3@^12.2.0`** (v12.11.1), which has
working prebuilds on both arm64 and amd64. glibc is the well-tested target for
these native addons. Password hashing uses **`bcryptjs`**, a pure-JavaScript
implementation — no native build, no `argon2` dependency.

The image is multi-stage: it installs the native-addon build toolchain
(`python3 make g++` via apt-get, kept as a fallback in case `better-sqlite3`
needs to compile from source when no prebuild is available) in the **build stage
only**, compiles the TypeScript, prunes to production deps (the `better-sqlite3`
native addon already compiled; `bcryptjs` needs no native build), then copies the
lean `node_modules`, `dist/`, **migrations**, and the single-file `index.html`
into a slim runtime image (with `libstdc++6` for the native addon) that runs as a
**non-root `app` user**.

The SQLite database lives on a **named volume** (`dragonchess_data`) mounted at
`/var/lib/dragonchess`, so accounts, sessions, ratings, and completed game
history survive container restarts and image rebuilds. `DATABASE_PATH` points
there by default.

```sh
docker compose build
docker compose up -d
curl http://127.0.0.1:3543/health      # -> {"status":"ok"}
docker compose logs -f
docker compose down                    # data volume persists across down/up
```

The port is published on the **host loopback only** (`127.0.0.1:3543`), so only
host-side Nginx can reach the backend — remote browsers never connect to it
directly. The container has a built-in `/health` healthcheck.

**You must provide `PASSWORD_PEPPER` to run in production.** Without it the
server refuses to start. Pass it via an env file or compose `environment:` block.

For production behind Nginx, unset `PUBLIC_DIR` in `docker-compose.yml` and let
Nginx serve the static `index.html` itself; Nginx still proxies `/socket.io/`
and `/api/` to `127.0.0.1:3543`. As with the bare-metal deploy, this project does
not create or edit any Nginx configuration.

## Deploy (Ubuntu, bare metal)

These steps install and run the backend only. **You must configure Nginx
yourself** to terminate TLS, serve the static `index.html`, and proxy
`/socket.io/` and `/api/` to `127.0.0.1:3543`. No Nginx commands are included
here — modify Nginx yourself.

### 1. Install Node.js + native build deps

Node.js ≥ 18 is required (Ubuntu 22.04 ships 12; use NodeSource or nvm). The
native addon (`better-sqlite3`) needs a C++ toolchain to build if no prebuilt
binary is available for your platform (`bcryptjs` is pure JS and needs none):

```sh
sudo apt-get install -y python3 make g++
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Build the backend

```sh
git clone <your repo> /tmp/dragonchess-build
cd /tmp/dragonchess-build/server
npm install                   # dev deps needed to build
npm run build                 # produces dist/
```

### 3. Install the backend into /opt (NOT the public web directory)

Backend source must not live inside the publicly served web directory.
**Copy `migrations/` alongside `dist/`** — the migration runner reads
`dist/migrations` (or `server/migrations`) at startup.

```sh
sudo mkdir -p /opt/dragonchess-server
sudo cp -r dist migrations package.json package-lock.json /opt/dragonchess-server/
cd /opt/dragonchess-server
sudo npm install --omit=dev   # production deps only (builds native addons)
```

### 4. Install only the frontend into the public web directory

Copy **only** `index.html` (the single-file frontend) to the directory Nginx
serves for the site. Do not copy `src/`, `test/`, `dist/`, or `migrations/` there.

```sh
sudo mkdir -p /var/www/dragonchess.belch.dk
sudo cp /tmp/dragonchess-build/index.html /var/www/dragonchess.belch.dk/
```

### 5. Create the data directory + an unprivileged service account

The SQLite file lives **outside the app/web root** at
`/var/lib/dragonchess/dragonchess.sqlite` (override with `DATABASE_PATH`).

```sh
sudo mkdir -p /var/lib/dragonchess
sudo useradd --system --no-create-home --shell /usr/sbin/nologin dragonchess
sudo chown -R dragonchess:dragonchess /opt/dragonchess-server /var/lib/dragonchess
```

### 6. Generate a pepper and install + start the systemd service

Generate a strong, random pepper once and keep it secret. Losing it invalidates
all existing passwords (every user must reset). Store it in the service
environment (e.g. a `PasswordPepper` entry in the systemd unit's
`EnvironmentFile`), **never** in the repo or a file inside the web root.

```sh
# Generate a 32-byte pepper, base64:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```sh
sudo cp /tmp/dragonchess-build/server/deploy/dragonchess.service.example \
        /etc/systemd/system/dragonchess.service
# Edit the unit to set NODE_ENV=production and PASSWORD_PEPPER=<your pepper>
sudo systemctl daemon-reload
sudo systemctl enable --now dragonchess
sudo systemctl status dragonchess
```

Logs:

```sh
sudo journalctl -u dragonchess -f
```

## Verify

```sh
# Backend health (loopback only):
curl http://127.0.0.1:3543/health           # -> {"status":"ok"}

# Auth round-trip (the cookie is HttpOnly, so use -c/-b cookie jars):
curl -c cj -s -XPOST http://127.0.0.1:3543/api/auth/register \
  -H 'Content-Type: application/json' -d '{"username":"alice","password":"correct horse battery staple"}'
curl -b cj -s http://127.0.0.1:3543/api/auth/me          # -> {"user":{...}}
curl -b cj -s http://127.0.0.1:3543/api/profile/history  # -> {"total":0,...}

# Socket.IO handshake from the public site (after you configure Nginx):
curl 'https://dragonchess.belch.dk/socket.io/?EIO=4&transport=polling'
```

Then open `https://dragonchess.belch.dk/` in two browsers (or two windows): sign
in on both with different accounts. To play a rated game, both click **Find
Match** — they are paired by closest Elo and the game auto-starts. For an
unranked private game, one clicks **Host** (gets a 6-character code + Gold) and
the other clicks **Join** and enters the code (Scarlet); the game auto-starts on
join — no ready-up. Moves made in one window appear in the other. After a rated
game finishes, each player's Elo updates and the game appears in Profile → Past
games; a rematch (both players request it) swaps colours and is always unranked.

## Nginx (you configure this)

You must configure Nginx to:

- Serve `/var/www/dragonchess.belch.dk/` as the static frontend over TLS.
- Proxy `/socket.io/` to `127.0.0.1:3543` (upgrade WebSocket headers).
- Proxy `/api/` to `127.0.0.1:3543`.

This project does not create, edit, or install any Nginx configuration.

## Configuration

| Env               | Default                                   | Notes                                              |
|-------------------|-------------------------------------------|----------------------------------------------------|
| `HOST`            | `127.0.0.1`                               | Bind loopback only; Nginx fronts it.               |
| `PORT`            | `3543`                                    |                                                    |
| `NODE_ENV`        | `development`                             | Set `production` to restrict CORS + use `__Host-` cookie + Secure + **require `PASSWORD_PEPPER`**. |
| `PASSWORD_PEPPER` | *(unset; dev fallback `DEV_PEPPER`)*      | **Required in production.** `base64url(HMAC-SHA256(pepper, password))` is the bcrypt input. Losing/changing it invalidates all passwords. |
| `BCRYPT_COST`     | `12`                                      | bcrypt cost factor. Raise for more work; lowers brute-force throughput. |
| `PUBLIC_DIR`      | *(unset)*                                 | Optional static serving for dev / self-contained image. |
| `DATABASE_PATH`   | `/var/lib/dragonchess/dragonchess.sqlite` | SQLite file, kept outside the web root.            |

CORS allows `https://dragonchess.belch.dk` always; localhost origins are allowed
only when `NODE_ENV !== 'production'`. In production the session cookie is
`__Host-dragonchess_session` with `Secure`; in development it is
`dragonchess_session` without `Secure` so it works over plain HTTP.