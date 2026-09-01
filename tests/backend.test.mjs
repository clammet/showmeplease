// End-to-end test of the built backend: sessions, WebSocket hub, chat,
// egress accounting, and the admin API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import WebSocket from "ws";

const root = new URL("../", import.meta.url);

const DEFAULT_OPTIONS = {
  codec: "auto",
  maxBitrateKbps: 6000,
  frameRate: 30,
  includeSystemAudio: true,
  allowViewerMic: false,
  allowViewerAnnotations: false,
};

async function startBackend(overrides = {}) {
  const child = spawn(process.execPath, ["dist/backend/index.mjs"], {
    cwd: new URL(".", root),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ADMIN_ALLOW_INSECURE: "1",
      VITE_CONVEX_URL: "https://test-deployment.convex.cloud",
      VITE_CONVEX_SITE_URL: "https://test-deployment.convex.site",
      AUTH_GOOGLE_ID: "test-client.apps.googleusercontent.com",
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      PUBLIC_ORIGIN: "",
      TRUST_PROXY: "",
      STATIC_ROOT: "dist/client",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolvePort, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("backend did not start")), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`backend exited early (${code})`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

function connectSocket(wsBase, code, role, token, clientId) {
  const socket = new WebSocket(`${wsBase}/api/sessions/${code}/ws`);
  socket.on("open", () => socket.send(JSON.stringify({ type: "auth", role, token, clientId })));
  return socket;
}

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (message.type === type) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      }
    };
    socket.on("message", onMessage);
  });
}

test("backend serves the app and runs the full session lifecycle", async (t) => {
  const { child, base } = await startBackend();
  t.after(() => child.kill());

  // Static frontend with origin rewriting.
  const home = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Share a screen/);
  assert.doesNotMatch(html, /http:\/\/localhost:3000/);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  // Status probe is idle before any session exists.
  const idle = await (await fetch(`${base}/api/status`)).json();
  assert.equal(idle.ok, true);
  assert.equal(idle.busy, false);
  assert.equal(idle.connectedClients, 0);

  // Convex's Vite-prefixed public URLs configure runtime auth.
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.auth, {
    convexUrl: "https://test-deployment.convex.cloud",
    convexSiteUrl: "https://test-deployment.convex.site",
    googleClientId: "test-client.apps.googleusercontent.com",
  });

  // Create a session.
  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ options: DEFAULT_OPTIONS, clientId: "creator-1" }),
    })
  ).json();
  assert.match(created.code, /^[A-Z0-9]{6}$/);
  assert.ok(created.token);

  // Options are validated strictly, bodies are size-limited, unknown paths 404.
  const badOptions = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ options: { ...DEFAULT_OPTIONS, frameRate: 999 }, clientId: "x" }),
  });
  assert.equal(badOptions.status, 400);
  const huge = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ options: DEFAULT_OPTIONS, clientId: "x", pad: "x".repeat(1_100_000) }),
  });
  assert.equal(huge.status, 413);
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-frame-options"), "DENY");

  // Joining before the creator is online is refused.
  const early = await fetch(`${base}/api/sessions/${created.code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "viewer-1" }),
  });
  assert.equal(early.status, 404);

  // Creator connects over WebSocket and authenticates with the first frame.
  const wsBase = base.replace("http", "ws");
  const creator = connectSocket(wsBase, created.code, "creator", created.token, "creator-1");
  const creatorWelcome = nextMessage(creator, "welcome");
  assert.deepEqual((await creatorWelcome).options, DEFAULT_OPTIONS);

  // Status probe reports the live session (counts only, never codes).
  const busy = await (await fetch(`${base}/api/status`)).json();
  assert.equal(busy.busy, true);
  assert.equal(busy.connectedClients, 1);
  assert.equal(busy.activeSessions, 1);
  assert.doesNotMatch(JSON.stringify(busy), new RegExp(created.code));

  // A bad token, or the right token with the wrong client id, is rejected.
  const intruder = connectSocket(wsBase, created.code, "creator", "wrong", "x");
  const [closeCode] = await once(intruder, "close");
  assert.equal(closeCode, 4001);
  const impostor = connectSocket(wsBase, created.code, "creator", created.token, "not-creator");
  const [impostorCode] = await once(impostor, "close");
  assert.equal(impostorCode, 4001);

  // Viewer joins and connects; creator is notified.
  const joined = await (
    await fetch(`${base}/api/sessions/${created.code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "viewer-1" }),
    })
  ).json();
  assert.ok(joined.token);

  const waiting = nextMessage(creator, "viewer-waiting");
  const viewer = connectSocket(wsBase, created.code, "viewer", joined.token, "viewer-1");
  await nextMessage(viewer, "welcome");
  assert.equal((await waiting).viewerCount, 1);

  // Chat reaches both sides and viewer byte reports feed the egress ledger.
  const chatAtViewer = nextMessage(viewer, "chat");
  creator.send(JSON.stringify({ type: "chat", text: "hello viewer" }));
  assert.equal((await chatAtViewer).text, "hello viewer");

  viewer.send(JSON.stringify({ type: "stats", inboundBytes: 250000, outboundBytes: 1000 }));
  viewer.send(JSON.stringify({ type: "stats", inboundBytes: 750000, outboundBytes: 2000 }));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

  // Admin overview reflects the session and the reported egress.
  const overview = await (
    await fetch(`${base}/api/admin/overview?billingCycleDay=12`)
  ).json();
  assert.equal(overview.sessions.length, 1);
  assert.equal(overview.sessions[0].code, created.code);
  assert.equal(overview.sessions[0].viewerCount, 1);
  assert.equal(overview.sessions[0].egressBytes, 750000);
  assert.equal(overview.billingCycleDay, 12);
  assert.equal(new Date(overview.billingPeriodStart).getUTCDate(), 12);
  assert.equal(new Date(overview.billingPeriodEnd).getUTCDate(), 12);
  assert.ok(overview.billingPeriodStart <= overview.now);
  assert.ok(overview.billingPeriodEnd > overview.now);
  assert.equal(overview.totals.egressBytesBillingPeriod, 750000);
  assert.equal(overview.totals.ingressBytesBillingPeriod, 2000);
  assert.equal(overview.totals.egressBytesLastDay, 750000);
  assert.equal(overview.series.length, 96);
  assert.equal(overview.cloudflare.egressBytesBillingPeriod, null);
  assert.equal(overview.cloudflare.freeTierBytes, 1_000_000_000_000);

  // Admin can terminate the session; clients get creator-end, a terminal
  // close code, and the room is retired.
  const ended = nextMessage(viewer, "creator-end");
  const viewerClosed = once(viewer, "close");
  const kill = await fetch(`${base}/api/admin/sessions/${created.code}`, {
    method: "DELETE",
  });
  assert.equal(kill.status, 200);
  assert.equal((await ended).reason, "terminated");
  assert.equal((await viewerClosed)[0], 4004);

  const after = await (await fetch(`${base}/api/admin/overview`)).json();
  assert.equal(after.sessions.length, 0);
  assert.equal(after.endedSessions[0].code, created.code);
  assert.equal(after.endedSessions[0].egressBytes, 750000);

  creator.close();
  viewer.close();
});

test("admin API requires auth when not in insecure dev mode", async (t) => {
  const { child, base } = await startBackend({
    ADMIN_ALLOW_INSECURE: "",
    ADMIN_EMAILS: "admin@example.com",
  });
  t.after(() => child.kill());

  const noToken = await fetch(`${base}/api/admin/overview`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${base}/api/admin/overview`, {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  assert.equal(badToken.status, 401);
});

test("ADMIN_ALLOW_INSECURE is ignored in production", async (t) => {
  const { child, base } = await startBackend({
    NODE_ENV: "production",
    ADMIN_ALLOW_INSECURE: "1",
    ADMIN_EMAILS: "admin@example.com",
  });
  t.after(() => child.kill());
  assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
});

test("host header is not reflected into HTML unless it looks like a host", async (t) => {
  const { child, base } = await startBackend();
  t.after(() => child.kill());
  // fetch() refuses a malformed Host header, so send it with node:http.
  const html = await new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/", headers: { host: 'x"><script>alert(1)</script>' } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /http:\/\/localhost:3000/, "placeholder left alone when host is invalid");
  const forwarded = await fetch(`${base}/`, {
    headers: { "x-forwarded-host": "evil.example", host: "127.0.0.1:1" },
  });
  assert.doesNotMatch(await forwarded.text(), /evil\.example/, "forwarded host ignored without TRUST_PROXY");
});
