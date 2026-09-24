# CineSync — *Watch together. Wherever you are.*

Private two-person watch rooms with server-authoritative playback sync, WebRTC video calling, chat and reactions.

## 1. Requirements
Node 20+, and optionally PostgreSQL 14+ (the app runs fully in-memory without it).

## 2. Install & run
```bash
npm install
cp .env.example .env      # fill in values
npm run db:migrate        # only if DATABASE_URL is set
npm run dev               # prints a random localhost port each run
```
Open the room link in two different browsers (or one normal + one private window) to test sync.

## 3. Sign-in
For local development, CineSync provides a name-based sign-in (`POST /auth/dev`). It is hard-disabled when `NODE_ENV=production`.

## 4. PostgreSQL
`psql "$DATABASE_URL" -f db/schema.sql` (or `npm run db:migrate`). Tables: `users`, `rooms`, `room_members`, `media`, `messages`. Video files are never stored in Postgres — only their paths.

## 5. Storage
`UPLOAD_DIR` must live **outside the source tree** (default: OS temp dir). Files are renamed to a random 32-hex name, type-checked by magic bytes, and served only to signed-in users over HTTP range requests, so a large movie is streamed and never buffered into RAM. Swapping in S3/Supabase means replacing the multer storage engine and the `/media/:file` handler in `server/index.js`.

## 6. STUN / TURN
`STUN_SERVER` defaults to Google's public STUN. For reliable connections behind symmetric NAT, set `TURN_SERVER`, `TURN_USERNAME`, `TURN_PASSWORD`; they're delivered to the client at runtime via `GET /api/config/ice` and never baked into frontend code.

## 7. Production deployment
Run behind a TLS-terminating reverse proxy (`trust proxy` is on; session cookies become `Secure` automatically when `NODE_ENV=production`). Socket.IO needs WebSocket upgrade passthrough — in nginx, `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`. Run a single instance, or add the Socket.IO Redis adapter plus a shared room-state store before scaling horizontally.

---

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/dev` | development-only name-based sign-in |
| POST | `/auth/logout` | destroys session |
| GET | `/api/me` | current user |
| GET | `/api/config/ice` | ICE server list |
| POST | `/api/rooms` | `{name,max,everyoneControls,chat,call}` → room + `/watch/CODE` |
| GET | `/api/rooms` | recent rooms |
| GET | `/api/rooms/:code` | room lookup (404 if expired) |
| POST | `/api/media/validate-url` | SSRF-guarded; HTTPS + public IP only |
| POST | `/api/upload` | multipart `video`; MIME + magic-byte validated |
| GET | `/media/:file` | authenticated range streaming |

## WebSocket events

**Client → server:** `room:join` · `playback:control {action: PLAY\|PAUSE\|SEEK\|RATE, currentTime, playbackRate}` · `media:change` · `room:settings` · `sync:request` · `chat:send` · `reaction` · `webrtc:offer` / `webrtc:answer` / `webrtc:ice` / `webrtc:hangup`

**Server → client:** `room:state` · `PLAYBACK_UPDATE` · `chat:message` · `reaction` · `peer:joined` / `peer:left` · `webrtc:*` · `room:error`

Every socket is authenticated from the HTTP session; permissions are re-checked server-side on each control event, never trusted from the client.

## How synchronization works
The server holds the only authoritative playback state and projects it forward on read:
`expected = currentTime + (now − updatedAt) × playbackRate`.

On each update a client compares its own position against that expectation:

| drift | action |
|---|---|
| `< 0.25s` | ignore — no visible seek |
| `0.25s – 1.5s` | nudge `playbackRate` ±5% for ~1.8s, then restore |
| `> 1.5s` | hard seek |

Echo loops are prevented two ways: updates carry the originating user id (the sender ignores its own), and an `applyingRemote` flag suppresses the local `play`/`pause`/`seeked` handlers while a remote state is being applied. A 5s watchdog and a `visibilitychange` handler re-request authoritative state after tab switches and reconnects.

## Security
HTTPS + secure cookies in production · session-authenticated WebSockets · server-side room authorization · SSRF guard (HTTPS-only, DNS resolution checked against private/loopback/link-local/metadata ranges) · magic-byte file-type validation · randomized filenames · configurable upload size cap · HTML-escaped chat (XSS) · parameterized SQL · rate limiting on auth, room creation and URL validation · no secrets in frontend JS · no stack traces in responses.

CineSync does not bypass DRM, paywalls, authentication, geo-restrictions or anti-hotlinking, and does not scrape media sites. Non-embeddable sources are rejected with a clear message.

## Privacy
Camera and mic activate only after you press **Join call** and grant browser permission. Uploaded videos are reachable only by signed-in users via unguessable filenames and are never publicly listed. Room codes are randomly generated and rooms expire after 24 hours.

## Testing
Manual matrix: two browsers on the same room → play/pause/seek propagation, rapid seeks, refresh mid-playback (state restores), host-only vs everyone-controls, camera-denied path, oversized upload, `.txt` renamed to `.mp4` (rejected), `http://127.0.0.1/x.mp4` as URL source (rejected), non-existent room code, socket connect while signed out (rejected).

## Known gaps vs. the full spec
Built as Express + vanilla ES modules rather than Next.js/Prisma/shadcn, so it runs from a single `npm install`. Not yet implemented: YouTube IFrame-API playback sync (the embed loads but doesn't sync), Vimeo source, resumable chunked uploads, watch history/favorites, and an automated test suite — the testing section above is a manual matrix.
# appsync
# cinesync
# cinesync
# cinesync
