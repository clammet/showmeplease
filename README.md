# showmeplease

A small, functional screen-sharing app built with pnpm, TypeScript, React, WebRTC, Cloudflare Realtime SFU, Durable Objects, and Lucide icons.

## What it does

- Creates short, shareable session codes.
- Captures the presenter screen locally for an immediate preview.
- Delays publishing media to Cloudflare Realtime until a viewer is waiting.
- Relays the screen, system audio, presenter microphone, and permitted viewer microphones as separate SFU tracks.
- Keeps presence and the last 100 chat messages in a session's in-memory WebSocket hub.
- Retries viewer WebSocket and WebRTC connections with exponential backoff.
- Stores presenter defaults in browser local storage.

## Local setup

1. Create a Cloudflare Realtime SFU app in the Cloudflare dashboard.
2. Copy `.dev.vars.example` to `.dev.vars` and add the Realtime App ID and secret.
3. Install and run the app:

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000` in two browser windows to test a presenter and viewer.

## Commands

```sh
pnpm dev
pnpm build
pnpm lint
pnpm test
```

## Architecture

The browser talks only to the app Worker; the Realtime secret is never sent to clients. One Durable Object is addressed by each six-character share code and provides session presence, authorization, track announcements, and chat over WebSockets. Chat messages are intentionally not written to durable storage.

Each browser owns one Cloudflare Realtime session (one `RTCPeerConnection`). Presenter video/audio tracks are published only after the Durable Object reports a waiting viewer. Viewers pull those tracks. When viewer microphones are enabled, each viewer publishes a separate audio track and the presenter pulls it into the existing connection—there is no shared reply DataChannel or single-speaker bottleneck.

## Production notes

Deploy the built Worker with a `SESSION_HUB` Durable Object binding for the exported `SessionHub` class and set `REALTIME_APP_ID` and `REALTIME_APP_SECRET` as encrypted Worker secrets. The Vite development configuration contains the matching local binding and initial Durable Object migration.
