# showmeplease

A small, functional screen-sharing app built with pnpm, TypeScript, React,
WebRTC, the Cloudflare Realtime SFU, Convex, and Lucide icons.

## What it does

- Creates short, shareable session codes.
- Captures the presenter screen locally for an immediate preview.
- Delays publishing media to Cloudflare Realtime until a viewer is waiting.
- Relays the screen, system audio, presenter microphone, and permitted viewer
  microphones as separate SFU tracks.
- Keeps presence and the last 100 chat messages in a per-session in-memory
  WebSocket hub.
- Optional Google sign-in (and anonymous identities) via Convex and
  [`@clammet/convex-googly-auth`](https://github.com/clammet/convex-googly-auth).
- Admin dashboard at `/admin` with live sessions, an SFU egress monitor, and a
  terminate-session action.
- Retries viewer WebSocket and WebRTC connections with exponential backoff.
- Stores presenter defaults in browser local storage.

## Architecture

One Docker container serves everything except media and auth:

```
browser ── static frontend + /api ──► Node backend (this container)
   │                                    ├─ session hub (codes, presence, chat, WebSockets)
   │                                    ├─ Realtime proxy (holds the SFU app secret)
   │                                    ├─ egress monitor + admin API
   ├── WebRTC media ──► Cloudflare Realtime SFU   (the heavy lifting)
   └── auth + profiles ──► Convex deployment      (googly-auth component)
```

- The browser talks to the backend for session control; the Realtime secret
  never reaches clients. Media flows directly between browsers and the
  Cloudflare SFU.
- Each browser owns one Realtime session (one `RTCPeerConnection`). Presenter
  tracks are published only after the hub reports a waiting viewer; viewers
  pull those tracks, and permitted viewer microphones are published back as
  separate tracks.
- Session state is in-memory in the single backend process (chat is
  intentionally ephemeral). Convex stores only identities/profiles.
- **Egress monitor:** every client reports its cumulative WebRTC byte counters
  over the session WebSocket; bytes a client receives are exactly what the SFU
  egressed, so the backend reconstructs per-session and global egress without
  Cloudflare credentials. Optionally, the backend also polls Cloudflare's
  GraphQL analytics (`callsUsageAdaptiveGroups` and
  `callsTurnUsageAdaptiveGroups`) for account-wide Realtime daily and
  billing-period usage shown in the dashboard.

## Local development

```sh
pnpm devsetup   # install deps, set up a *local* Convex instance, write .env.local
pnpm dev        # sync local auth env, then start Convex + backend (:8787) + web (:3000)
```

Open `http://127.0.0.1:3000` in two browser windows to test presenter and
viewer, and `http://127.0.0.1:3000/admin` for the dashboard
(`ADMIN_ALLOW_INSECURE=1` is set for dev, so no sign-in is needed locally).

`devsetup` uses the Convex CLI's anonymous local deployment — a real Convex
backend running on your machine, no account required. Re-run it whenever you
change auth-related values in `.env.local`; it forwards them to the Convex
deployment.

To exercise real media relay locally, create a Realtime SFU app in the
Cloudflare dashboard and fill `REALTIME_APP_ID` / `REALTIME_APP_SECRET` in
`.env.local`. To enable Google sign-in, create an OAuth client and fill
`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (see `.env.example` for everything).

## Commands

```sh
pnpm devsetup       # one-time (idempotent) dev environment setup
pnpm dev            # convex + backend + web with proxy/HMR
pnpm build          # static frontend export + bundled backend (dist/)
pnpm start          # run the built backend (serves dist/client)
pnpm test           # build + integration tests against the built backend
pnpm lint
pnpm image:build    # docker build
pnpm image:publish  # multi-arch buildx push (IMAGE_NAME=… IMAGE_TAG=…)
```

## Docker deployment

The image contains the static frontend and the Node backend in one container;
Cloudflare Realtime does the media heavy lifting and Convex handles auth.

```sh
pnpm image:build
docker run --rm -p 8080:8080 \
  -e REALTIME_APP_ID=... \
  -e REALTIME_APP_SECRET=... \
  -e VITE_CONVEX_URL=https://your-deployment.convex.cloud \
  -e VITE_CONVEX_SITE_URL=https://your-deployment.convex.site \
  -e AUTH_GOOGLE_ID=...apps.googleusercontent.com \
  -e ADMIN_EMAILS=you@example.com \
  showmeplease:latest
```

There is also a compose file in `deploy/docker-compose.yml`. The container
exposes port `8080`, `/healthz` for readiness/liveness, and an unauthenticated
`/api/status` returning aggregate counts (`sessions`, `activeSessions`,
`connectedClients`, `busy`; never session codes) so deployment tooling can
defer restarts — e.g. image updates — until `busy` is false. All configuration
is runtime environment (`.env.example` documents every variable) — the
frontend fetches `/api/config` at boot, so one image works for any deployment.

Convex in production is either [convex.dev](https://convex.dev) cloud or a
[self-hosted Convex](https://github.com/get-convex/convex-backend/tree/main/self-hosted)
instance; deploy the functions with `npx convex deploy` and set
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `SITE_URL` (your public origin), and
`ADMIN_EMAILS` on that deployment.

### Production Convex deployment

The `Deploy Convex production` GitHub Actions workflow tests the selected
revision, reconciles the application environment, deploys the Convex
functions, and verifies a public query. It runs after every push to `main` and
can also be dispatched manually.

Create a GitHub environment named `production` and configure these environment
secrets (repository Actions secrets with the same names also work):

- `CONVEX_SELF_HOSTED_URL`: public Convex API/backend origin, for example
  `https://your-convex-backend.example.org`.
- `CONVEX_SELF_HOSTED_ADMIN_KEY`: admin key generated by the running
  self-hosted Convex backend with `./generate_admin_key.sh`.
- `AUTH_GOOGLE_ID`: Google OAuth web client ID. This must match the public
  `AUTH_GOOGLE_ID` supplied to the showmeplease container.
- `AUTH_GOOGLE_SECRET`: secret for that Google OAuth client. It is only sent
  to Convex and must not be supplied to the showmeplease container.
- `SITE_URL`: public showmeplease origin, for example
  `https://showmeplease.example.org`.
- `ADMIN_EMAILS`: comma-separated Google account emails allowed to use
  `/admin`. This must match the `ADMIN_EMAILS` supplied to the container.

Configure this authorized redirect URI on the Google OAuth web client, using
the public Convex HTTP-actions origin:

```text
https://your-convex-site.example.org/auth/google/callback
```

Bootstrap the self-hosted Convex instance before the workflow's first run,
then generate its admin key from the backend container. The workflow does not
build or manage the Convex server itself; it owns the application environment
and function deployment running on that server.

## Dependency pinning & updates

Everything the repo consumes is pinned exactly, and a self-hosted Renovate
turns each upstream release into a PR:

- npm packages: exact versions in `package.json`, resolved by
  `pnpm-lock.yaml`; pnpm itself carries its sha512 in the `packageManager`
  field, and CI's Node version is pinned in `.node-version`.
- Docker base image and the `# syntax` directive: tag + sha256 digest in the
  `Dockerfile`.
- GitHub Actions: full commit SHAs, with the release version as a comment.
- Deployed image: `deploy/docker-compose.yml` references
  `ghcr.io/clammet/showmeplease` by digest, so the server runs exactly the
  image CI built and tested.
- Anything built from source in the future gets the same treatment: pinned
  version plus a checksum verified before use.

`renovate.json5` holds the policy; `.github/workflows/renovate.yml` runs
Renovate every 4 hours. CI (lint, build, tests, and a full image build) runs
on every PR. Minor/patch/pin/digest PRs merge via GitHub auto-merge once all
checks are green — a ruleset on `main` makes both CI checks required (repo
admins bypass it, so direct pushes still work) — while majors and anything
with a red check wait for a human. npm
updates wait 3 days after release before being taken (compromised packages
are usually yanked within days), except `@clammet/*` packages, which are
taken immediately. A weekly Trivy scan checks the published `:latest` image
for CVEs disclosed since the last merge, fails the run on fixable
HIGH/CRITICAL findings, and reports to the repo's Security tab.

## Admin dashboard

`/admin` requires signing in with a Google account listed in `ADMIN_EMAILS`
(the backend verifies the Google ID token issued through googly-auth; Convex
uses the same allowlist to show the Admin link). It shows:

- active sessions, connected clients, sessions created, uptime
- SFU egress: last day, selected billing-period total, 15-minute chart,
  per-session totals
- optional account-wide Cloudflare Realtime SFU + TURN daily graph and
  billing-period progress against the shared 1,000 GB free tier, with a
  browser-persisted billing-period start-date picker
  (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, token scope Account
  Analytics:Read)
- recently ended sessions and an "End" action that terminates a session for
  everyone

Client-reported byte counters are a close reconstruction of SFU egress;
Cloudflare's own metering remains authoritative for billing.
