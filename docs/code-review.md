# Code review: showmeplease

Reviewed at commit e0b9549 (2026-08-28). Scope: everything under `server/`, `lib/`, `app/`, `convex/`, `scripts/`, `tests/`, the Dockerfile, compose file, and workflows. Generated code, CSS, and the vendored Convex skills were skipped.

Baseline: `tsc --noEmit`, `pnpm lint`, and `pnpm test` (build plus 6 tests) all pass on a clean install.

Update, same day: every finding below has been addressed; see "Fix status" at the end for what changed and what was verified afterwards. Findings marked "confirmed" were reproduced against the built backend with a throwaway script; the rest are from reading the code.

The design is sound for what it is. The Realtime secret stays server-side, admin auth verifies Google ID tokens with audience, issuer, and `email_verified`, static file serving guards against path traversal, request bodies are capped, actions and base images are pinned by digest, and the Convex functions use validators and an index. The problems below are mostly at the trust boundary between browser and hub, plus reconnect behaviour.

## Severity key

High: exploitable by any participant or breaks the product in normal use. Medium: wrong numbers, missing recovery, or abuse that needs some effort. Low: hygiene, docs, small UX.

## High

### 1. Realtime proxy does not bind the Cloudflare session id to the caller

`server/realtimeProxy.ts:25` checks that the `x-session-token` belongs to the room in `x-session-code`, then forwards `/tracks/new` and `/renegotiate` for whatever Cloudflare `sessionId` appears in the path. Nothing ties that session id to the room or the token. Any viewer of any room can, with a session id and track name from another room, pull that room's screen and audio, or push tracks into someone else's peer connection. Session ids and track names are only sent to room members, so this needs a leak or a former member, but former members keep valid tokens for the life of the room (see finding 3).

Fix: parse the response of `sessions/new`, record the returned `sessionId` against the token that created it, and refuse `/tracks/new` and `/renegotiate` for a session id the caller did not create. For remote pulls, also check that every `tracks[].sessionId` in the body belongs to the same room.

### 2. Viewer microphone policy is enforced only in the browser

`server/hub.ts:338` relays `viewer-audio` to the creator whenever the sender's role is `viewer`. It never reads `room.options.allowViewerMic`, and `message.track` is forwarded as-is. The creator then calls `pullTracks([message.track])` (`app/ShareApp.tsx:651`) and plays every audio track it receives (`app/ShareApp.tsx:534`). A viewer with a modified client can publish audio to the presenter with the policy off, and can point the presenter at any session id and track name.

Confirmed live: a forged `viewer-audio` from a second viewer socket, with the policy off, reached the presenter. The presenter then called Cloudflare for the bogus session, got 410 Gone, and the `void connectionRef.current?.pullTracks(...)` at `app/ShareApp.tsx:651` surfaced as an unhandled rejection ("Realtime request failed") since nothing catches it.

Fix: drop `viewer-audio` when `allowViewerMic` is false, validate the track object's shape, and only accept a `sessionId` the sender created (same bookkeeping as finding 1). Catch the pull error on the presenter side.

### 3. Unauthenticated `/join` can evict every real viewer's token (confirmed)

`server/hub.ts:103` mints a viewer token on every `POST /api/sessions/:code/join` with no rate limit and no client binding, and caps the set at 512 by deleting the oldest entries. 512 joins from anyone who knows the code push out the tokens of every connected viewer. Those viewers stay connected until their socket drops, then reconnect with a dead token, get close code 4001, and (finding 4) retry forever. Reproduced: after 512 joins, a legitimate viewer's reconnect closes with 4001.

Tokens also never expire and are not removed when a viewer leaves, so anyone who ever joined keeps proxy access (finding 1) for the life of the room.

Fix: bind the token to the `clientId` sent at join time and check it on WebSocket connect; remove a token when its socket closes (after a reconnect grace period); rate limit `/join` per IP and per code; evict only tokens with no live socket.

### 4. Clients reconnect forever after the room is gone

`app/ShareApp.tsx:475` treats every socket close the same. After an admin terminate, the server sends `creator-end`, closes the sockets, and deletes the room. The `creator-end` handler (`app/ShareApp.tsx:666`) sets status to `ended` but leaves `activeRef` true, so the close handler flips status to `reconnecting` and schedules a retry. Each retry gets 4001 and reschedules, at the 10 s cap, until the tab is closed. The creator sees "Reconnecting" instead of "ended". The same loop runs for a viewer whose token was evicted (finding 3) or who reloads after the presenter stopped.

Fix: on `creator-end` set `activeRef.current = false`; in the close handler treat 4001 (and any 4xxx code) as terminal and show the ended or error state; cap total attempts.

## Medium

### 5. Egress is double-counted across a WebSocket reconnect (confirmed)

`server/hub.ts:242` creates a fresh `SocketClient` with `lastInboundBytes = 0` on every connect, but the browser keeps the same `RTCPeerConnection` and its cumulative counters across a socket reconnect. The first `stats` message after reconnect is treated as a full delta. Reproduced: one viewer reporting 1000 cumulative bytes, reconnecting, and reporting 1000 again is recorded as 2000. On a flaky network this inflates the per-session and billing-period numbers on the dashboard by the whole running total per drop.

Fix: keep the last counters keyed by `clientId` for the life of the room (or have the client send a per-peer-connection id and reset only when it changes).

### 6. The presenter has no media recovery path

When the presenter's peer connection reports `failed`, `app/ShareApp.tsx:537` sets status to `error` and stops. `publishedRef` stays true, so `ensurePublished` never runs again, and the stale track names stay in `room.sharedTracks` (`server/hub.ts:329`) and are re-sent to every new viewer via `welcome`. Viewers then pull dead tracks and enter the retry loop in finding 7. The local capture is still running the whole time.

Fix: on `failed` (and after a `disconnected` timeout) close the connection, clear `publishedRef` and `publishedTracksRef`, republish, and have the hub replace `sharedTracks` on `tracks-ready` rather than merge. Cloudflare's `renegotiate` endpoint also allows an ICE restart without a new session.

### 7. Viewer media retry is a fixed 1.2 s loop that creates a Cloudflare session per attempt

`app/ShareApp.tsx:500` closes the connection and re-pulls after 1.2 s on `failed`, and after 4 s on `disconnected`. There is no backoff and no attempt cap, each attempt calls `sessions/new` (a fresh Cloudflare session), and the timer is not stored in `mediaRetryTimerRef`, so `stopSession` cannot cancel it. README says WebRTC reconnects use exponential backoff; only the WebSocket does.

### 8. The hub never detects dead sockets

There is no server-side ping/pong or idle timeout. The client's `ping` message (`app/ShareApp.tsx:472`) is answered but not used to expire connections. A presenter whose laptop sleeps stays `creatorOnline` until TCP gives up (minutes to hours), so `/join` keeps handing out tokens for a share nobody is presenting and the dashboard over-counts viewers. `WebSocketServer` at `server/index.ts:215` also leaves `maxPayload` at the default 100 MiB; chat is truncated to 2000 characters only after the whole frame is parsed.

Fix: `ws` heartbeat (server `ping`, terminate on missed `pong`), and `maxPayload: 64 * 1024`.

### 9. Unbounded, unauthenticated resource creation

`POST /api/sessions` needs no auth and has no rate limit; every room lives at least an hour (`IDLE_ROOM_TTL_MS`). `room.sharedTracks` grows without limit from `tracks-added`. Chat has no per-client rate limit. None of this is exotic, but a single script can pin the process's memory.

### 10. Loose validation at the trust boundary

- `validOptions` (`server/index.ts:51`) checks types only. `codec` may be any string, `frameRate` any number, `maxBitrateKbps` any number including `Infinity`. Viewers receive and apply these.
- `tracks-ready` / `tracks-added` (`server/hub.ts:328`) casts `message.tracks` to `SharedTrack[]` and stores whatever arrives.
- `clientId` is chosen by the client with no length limit and is the identity used for chat attribution. A viewer who reconnects with the presenter's id (visible as `senderId` on every presenter chat line) has their messages rendered as "You" on the presenter's screen (`app/ShareApp.tsx:312`).
- `readJson` (`server/http.ts:23`) swallows the "body too large" error and returns `{}`, so an oversize request gets 400 "Missing session options" rather than 413.

### 11. `Host` and `X-Forwarded-Host` are spliced into HTML unescaped

`server/staticFiles.ts:30` builds the origin from whichever of `x-forwarded-host` or `host` is present and `replaceAll`s it into the page. With no reverse proxy in front (the compose file exposes 8080 directly), a client controls that value byte-for-byte. It is only reflected to the requester, so the impact is limited to poisoning any cache in between, but there is no reason to trust it. Prefer a `PUBLIC_ORIGIN` env var, falling back to a validated hostname pattern.

### 12. TLS is required but not documented or provided

`getDisplayMedia` and `crypto.randomUUID()` (`app/ShareApp.tsx:400`, `lib/realtime.ts:156`) only exist in secure contexts. `deploy/docker-compose.yml` publishes plain `8080` and README's deployment section does not mention a TLS terminator. Anyone reaching the container over `http://<lan-ip>:8080` gets a broken app with no message. Worth a sentence in README and a guard in `ShareApp` that explains it.

### 13. STUN only, no TURN

`lib/realtime.ts:117` configures a single STUN server. Viewers behind symmetric NAT or UDP-blocking firewalls will fail ICE. Cloudflare Realtime provides TURN credentials, and the dashboard already sums `callsTurnUsageAdaptiveGroups`, so the intent seems to be to use it. Decide either way and document it.

### 14. No production guard on `ADMIN_ALLOW_INSECURE`

`server/adminAuth.ts:26` honours the flag unconditionally, and `server/env.ts` loads `.env.local` from the working directory in every environment. `pnpm devsetup` writes `ADMIN_ALLOW_INSECURE=1` into `.env.local`. One copied file opens the admin API. Refuse the flag when `NODE_ENV=production`, or at least log loudly at startup.

## Low

### 15. Every unknown path is a 200

`server/staticFiles.ts:62` falls back to `index.html` for anything it cannot resolve (confirmed: `GET /nope` is 200). The build produces `dist/client/404.html`, which is never served. Monitoring, crawlers, and typo'd links all see success.

### 16. Static server edge cases

`decodeURIComponent` at `server/staticFiles.ts:49` throws on malformed percent-encoding, which surfaces as a 500. `existsSync` and `statSync` run synchronously on every request; fine at this scale, but easy to replace with a startup-time file list.

### 17. No security headers

No CSP, `X-Frame-Options`, `Referrer-Policy`, or HSTS on any response. Also, the WebSocket token travels in the query string (`app/ShareApp.tsx:461`) and will show up in proxy and access logs; a first-message auth handshake avoids that.

### 18. Admin dashboard details

- After one sign-in redirect, `signInStarted` (`app/admin/AdminDashboard.tsx:629`) suppresses further attempts, so a later 401 leaves the page on a spinner with no message.
- `terminate` (`:466`) ignores the response; a failed delete looks like success until the next poll.
- `formatBytes` uses 1024 and `formatMeteredBytes` uses 1000, both labelled `KB`/`MB`/`GB`. The two panels compare the same quantity in different units.
- The "Current period started" date input (`:296`) only reads the day of month; picking a date in another month silently changes meaning.

### 19. Misleading admin error on JWKS failure

`server/adminAuth.ts:57` returns 401 "Invalid or expired token" for any exception, including Google's JWKS endpoint being unreachable. That case should be a 503.

### 20. `room.options` drifts from the live settings

`mic-policy` (`server/hub.ts:347`) is the only setting the hub updates after creation. Bitrate changes by the presenter apply locally but the admin overview and late-joining viewers see the original values.

### 21. Test coverage

- `tests/rendered-html.test.mjs` test 3 greps source files for strings like `room\.messages\.splice`. It asserts implementation text, not behaviour, and will break on any refactor that keeps behaviour.
- No unit tests for `SessionHub`, `EgressLedger`, or `utcBillingPeriod` (cycle day 31, month rollover, the double-count in finding 5). These are pure and cheap to test without the build.
- `pnpm test` requires a full `vinext build` first, so a hub change costs a frontend build to verify.
- CI runs eslint but not `tsc --noEmit`. It passes today; add it so it stays that way.

### 22. `ShareApp.tsx` structure

1157 lines, one component, with `react-hooks/refs`, `react-hooks/set-state-in-effect`, and an a11y rule disabled for the whole file. Session logic lives in functions assigned to refs during render (`app/ShareApp.tsx:525`, `:568`, `:601`). It works, but the reconnect bugs above are hard to see in this shape. `lib/realtime.ts` already shows the better pattern: a plain class with an operation queue. A `SessionClient` class owning the socket, timers, and media state, with React holding only view state via a reducer, would remove all three lint disables.

### 23. Cloudflare poller

`server/egress.ts:259` calls `response.json()` before checking `response.ok`, so a Cloudflare HTML error page produces a JSON parse message in the dashboard instead of the status code. On error the previous `dailySeries` is kept, which is reasonable, but `updatedAt` should be shown alongside so staleness is visible.

### 24. Small things

- `bytesInLast(1440)` (`server/egress.ts:114`): reported as an off-by-one, but on re-reading the window is exactly `minutes` buckets. Withdrawn; a unit test now pins the behaviour.
- `app/ShareApp.tsx:583` builds a new `MediaStream` on every track event and reassigns `srcObject`, which restarts the video element each time a track arrives.
- `lib/realtime.ts:242` sets `encodings = [{}]` when empty; the spec requires the same number of encodings as the sender was created with.
- `.env.example` lists `AUTH_GOOGLE_SECRET` under values the backend needs; only the Convex deployment and `sync-convex-env.mjs` use it.
- README: the WebRTC exponential-backoff claim (finding 7), and no TLS requirement (finding 12).
- `public/favicon.svg` exists but `app/layout.tsx` never links it, so every page load logs a 404 for `/favicon.ico` (in production the SPA fallback answers it with `index.html`, finding 15).

## Live test results

Run on 2026-08-28 against `pnpm dev` with real Cloudflare Realtime and Cloudflare Analytics credentials and the local anonymous Convex deployment. Google sign-in was not exercised (it needs an interactive OAuth consent), so the admin API was reached with `ADMIN_ALLOW_INSECURE=1`. Scripts: an API-level check with Node, and a two-page headless Chrome run using fake screen capture (`puppeteer-core` against the system Chrome).

What works:

- Presenter creates a share, viewer joins by `?join=CODE`, and the viewer's `<video>` had 800 px frames 4.0 s after clicking Join. Media went through the Cloudflare SFU (both peers on the same machine, so no NAT traversal was tested).
- Presenter status went "Waiting for a viewer" to "Sharing live", viewer count 1. Chat from viewer to presenter arrived and raised the unread badge.
- Egress accounting: after ~12 s of streaming the admin overview showed 275 KB egress and 351 KB ingress for the session.
- Cloudflare usage poller: `enabled: true`, `error: null`, `updatedAt` set, a billing-period total in the hundreds of MB, 29 daily buckets. The GraphQL query and token scope are correct.
- Convex: `devsetup` installed the `googlyAuth` component and the `profiles.by_identityId` index on the local deployment; `ensureProfile` ran on page load without errors in the console.

What was confirmed broken:

- Finding 1: room B's token was accepted for `POST /api/realtime/sessions/<room A's sessionId>/tracks/new` (HTTP 200; Cloudflare processed the remote pull and returned `requiresImmediateRenegotiation: true`) and for `PUT .../renegotiate` (HTTP 400 from Cloudflare for the bogus SDP, not 401 from the proxy). A wrong token was still refused with 401, so the room check works; the session-id check is what is missing.
- Finding 2: as described above. Forged `viewer-audio` reached the presenter with the policy off and caused an unhandled rejection.
- Finding 4: after `DELETE /api/admin/sessions/<code>` the presenter showed "Reconnecting" and the viewer "Connection interrupted", 6 s later and indefinitely. The hub had already moved the session to `endedSessions`.
- Findings 3, 5, and 15 were confirmed earlier against the built backend without Cloudflare (token eviction after 512 joins, 2000 bytes recorded for 1000, `GET /nope` is 200).

Not tested live: presenter media recovery (finding 6) and the viewer retry loop (finding 7), which need a forced ICE failure; TURN (finding 13), which needs a NAT between peers; Google sign-in and the Convex `currentProfile` admin flag.

## Suggested order

1. Findings 1, 2, 3 together: they share one change, which is tracking Cloudflare session ids and client ids per token in the hub.
2. Finding 4, then 6 and 7: reconnect semantics on the client. Small diffs, large effect on how the product behaves under bad networks.
3. Finding 5 and 8: hub bookkeeping, both testable without the frontend.
4. Finding 21: hub and ledger unit tests, `tsc` in CI. Do this before or alongside 1 to 3 so the fixes have coverage.
5. The rest as time allows. 12 and 14 are one-line docs or guards.

## Fix status

All findings were addressed in the commits that follow the review. Verification after the fixes: `tsc`, `lint`, 15 new unit tests (`tests/hub.test.mjs`, run without a build), the 4 integration tests, and the same two live scripts against real Cloudflare and local Convex.

### Server

- 1, 2: the hub now tracks a `Participant` per token with the Cloudflare session ids it opened. The proxy parses the `sessions/new` response and records the id; `tracks/new` and `renegotiate` require the path session to belong to the caller, and every `location: "remote"` entry must name a session opened by someone in the same room. `viewer-audio` is dropped unless `allowViewerMic` is on, the track parses, and its session belongs to the sender. Live: cross-room `tracks/new` and `renegotiate` now return 403, a participant's own session still reaches Cloudflare, and the forged `viewer-audio` never reached the presenter.
- 3: tokens are bound to the `clientId` given at create or join time and checked on connect. A client that joins twice gets the same token. Tokens are removed five minutes after their last socket closes; at the 512 cap the room reports "full" (503) instead of evicting anyone with a live socket. `/api/sessions` and `/join` are rate limited per address (10 and 30 per minute; `TRUST_PROXY=1` enables `X-Forwarded-For`).
- 5: byte counters are keyed by client id on the room, not by socket. Unit test covers reconnect and peer-connection rebuild.
- 8: server `ping` every 15 s, sockets that miss one window are terminated; `maxPayload` is 64 KiB.
- 9: 1000 rooms max, 16 shared tracks per room, chat limited to 10 messages per 10 s per participant (the client is told with an `error` frame).
- 10: `lib/options.ts` has a strict `parseSessionOptions` used by the hub and the create endpoint, and `parseSharedTrack` for every track object. Client ids must match `^[A-Za-z0-9_-]{1,64}$`. Oversize bodies are 413, malformed JSON is 400.
- 11, 17: `PUBLIC_ORIGIN` wins; otherwise the Host header is accepted only if it matches a hostname pattern, and forwarded headers need `TRUST_PROXY=1`. Every response carries `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Permissions-Policy`. The WebSocket authenticates with a first `{type: "auth"}` frame; the token is no longer in the URL. Close codes: 4001 bad credentials, 4002 auth timeout, 4004 session ended.
- 13: optional TURN. With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, `GET /api/realtime/ice` returns short-lived Cloudflare TURN credentials; the client asks for them before building a peer connection and falls back to STUN.
- 14: `ADMIN_ALLOW_INSECURE` is ignored when `NODE_ENV=production`, and startup logs a warning when it is active.
- 15, 16: unknown paths serve `404.html` with status 404; malformed percent-encoding is a 404 rather than a 500.
- 19: JWKS fetch failures return 503; only jose verification errors map to 401.
- 20: the creator sends a full validated `options` message; the hub stores it and fans it out to everyone. `mic-policy` is gone.
- 23: `response.ok` is checked before parsing; the poll has a 30 s timeout; the dashboard shows when the Cloudflare data was last refreshed.

### Client

- 4, 6, 7, 22: session logic moved into `lib/session.ts` (`SessionClient`). The socket reconnects with backoff, treats 4xxx close codes as terminal, and gives up after 20 attempts. `creator-end` ends the session (reason `presenter` or `terminated`). Media retries use backoff (1 s doubling to 15 s, 8 attempts), the timer is tracked and cancelled on stop, and the presenter republishes after a failed peer connection; `tracks-ready` replaces the room's track list and viewers rebuild when their pulled tracks disappear. A 410 from Cloudflare (track gone) puts the viewer back in `waiting` for the next `tracks-ready` instead of retrying. `ShareApp.tsx` is view state only; the three file-wide lint disables are gone. Live: after admin terminate both pages show a terminal state with "Return home" and the hub reports zero connected clients 12 s later.
- 12: the landing page warns when `window.isSecureContext` is false and "Create share" explains that HTTPS is required. README's deployment section says to terminate TLS in front of the container.
- 18: one decimal byte formatter for both panels; the billing input is a day-of-month number; a failed terminate shows an alert; a second 401 after sign-in shows a message with a sign-out button instead of a spinner.
- 24: the viewer reuses one `MediaStream` per connection instead of creating a new one per track; `applyBitrate` no longer invents an encodings entry; `favicon.svg` is linked from the layout; `.env.example` explains which side uses `AUTH_GOOGLE_SECRET`; README no longer claims exponential backoff for something that did not have it.

### Tests and CI

- 21: `tests/hub.test.mjs` covers token binding, capacity, grace expiry, stats across reconnect, track ownership and replace/append, the mic policy, options validation, chat rate limiting, heartbeat, terminate, the ledger windows, and `utcBillingPeriod` for cycle day 31 and month rollover. It runs with `pnpm test:unit` (no build). The integration test now also checks strict options, 413, 404, security headers, client-id binding, the 4004 close code, the production guard for `ADMIN_ALLOW_INSECURE`, and Host header handling. The source-grep test was removed. CI and the Convex deploy workflow run `pnpm typecheck`.

Not re-tested live: presenter media recovery and viewer retry under a forced ICE failure (the logic has unit-level coverage of the hub side only), TURN (no key configured), Google sign-in.
