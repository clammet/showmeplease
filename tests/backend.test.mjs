// End-to-end test of the built backend: sessions, WebSocket hub, chat,
// egress accounting, and the admin API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

const root = new URL("../", import.meta.url);

const DEFAULT_OPTIONS = {
  codec: "auto",
  maxBitrateKbps: 6000,
  frameRate: 30,
  includeSystemAudio: true,
  allowViewerMic: false,
};

async function startBackend() {
  const child = spawn(process.execPath, ["dist/backend/index.mjs"], {
    cwd: new URL(".", root),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      ADMIN_ALLOW_INSECURE: "1",
      STATIC_ROOT: "dist/client",
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

  // Config endpoint reports auth disabled without Convex env.
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.auth, null);

  // Create a session.
  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ options: DEFAULT_OPTIONS }),
    })
  ).json();
  assert.match(created.code, /^[A-Z0-9]{6}$/);
  assert.ok(created.token);

  // Joining before the creator is online is refused.
  const early = await fetch(`${base}/api/sessions/${created.code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "viewer-1" }),
  });
  assert.equal(early.status, 404);

  // Creator connects over WebSocket.
  const wsBase = base.replace("http", "ws");
  const creator = new WebSocket(
    `${wsBase}/api/sessions/${created.code}/ws?role=creator&token=${created.token}&clientId=creator-1`,
  );
  const creatorWelcome = nextMessage(creator, "welcome");
  await once(creator, "open");
  assert.deepEqual((await creatorWelcome).options, DEFAULT_OPTIONS);

  // A bad token is rejected.
  const intruder = new WebSocket(
    `${wsBase}/api/sessions/${created.code}/ws?role=creator&token=wrong&clientId=x`,
  );
  const [closeCode] = await once(intruder, "close");
  assert.equal(closeCode, 4001);

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
  const viewer = new WebSocket(
    `${wsBase}/api/sessions/${created.code}/ws?role=viewer&token=${joined.token}&clientId=viewer-1`,
  );
  const viewerWelcome = nextMessage(viewer, "welcome");
  await once(viewer, "open");
  await viewerWelcome;
  assert.equal((await waiting).viewerCount, 1);

  // Chat reaches both sides and viewer byte reports feed the egress ledger.
  const chatAtViewer = nextMessage(viewer, "chat");
  creator.send(JSON.stringify({ type: "chat", text: "hello viewer" }));
  assert.equal((await chatAtViewer).text, "hello viewer");

  viewer.send(JSON.stringify({ type: "stats", inboundBytes: 250000, outboundBytes: 1000 }));
  viewer.send(JSON.stringify({ type: "stats", inboundBytes: 750000, outboundBytes: 2000 }));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

  // Admin overview reflects the session and the reported egress.
  const overview = await (await fetch(`${base}/api/admin/overview`)).json();
  assert.equal(overview.sessions.length, 1);
  assert.equal(overview.sessions[0].code, created.code);
  assert.equal(overview.sessions[0].viewerCount, 1);
  assert.equal(overview.sessions[0].egressBytes, 750000);
  assert.equal(overview.totals.egressBytes, 750000);
  assert.equal(overview.totals.ingressBytes, 2000);
  assert.ok(overview.series.length > 0);

  // Admin can terminate the session; clients get creator-end and the room is retired.
  const ended = nextMessage(viewer, "creator-end");
  const kill = await fetch(`${base}/api/admin/sessions/${created.code}`, {
    method: "DELETE",
  });
  assert.equal(kill.status, 200);
  await ended;

  const after = await (await fetch(`${base}/api/admin/overview`)).json();
  assert.equal(after.sessions.length, 0);
  assert.equal(after.endedSessions[0].code, created.code);
  assert.equal(after.endedSessions[0].egressBytes, 750000);

  creator.close();
  viewer.close();
});

test("admin API requires auth when not in insecure dev mode", async (t) => {
  const child = spawn(process.execPath, ["dist/backend/index.mjs"], {
    cwd: new URL(".", root),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      ADMIN_ALLOW_INSECURE: "",
      AUTH_GOOGLE_ID: "test-client.apps.googleusercontent.com",
      ADMIN_EMAILS: "admin@example.com",
      STATIC_ROOT: "dist/client",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill());
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
  });

  const noToken = await fetch(`http://127.0.0.1:${port}/api/admin/overview`);
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`http://127.0.0.1:${port}/api/admin/overview`, {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  assert.equal(badToken.status, 401);
});
