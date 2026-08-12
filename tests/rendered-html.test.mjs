import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the functional screen-share entry", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>showmeplease — simple screen sharing<\/title>/i);
  assert.match(html, /Share a screen/);
  assert.match(html, /Create share/);
  assert.match(html, /ENTER CODE/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps the relay gated by viewer presence and chat bounded", async () => {
  const [app, worker, realtime, packageJson] = await Promise.all([
    readFile(new URL("app/ShareApp.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("lib/realtime.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(app, /message\.type === "viewer-waiting"/);
  assert.match(app, /ensurePublishedRef\.current\(\)/);
  assert.match(app, /showmeplease\.session-options\.v1/);
  assert.match(worker, /this\.messages\.length > 100/);
  assert.match(worker, /this\.messages\.splice/);
  assert.match(worker, /REALTIME_APP_SECRET/);
  assert.match(realtime, /stun:stun\.cloudflare\.com:3478/);
  assert.match(realtime, /requiresImmediateRenegotiation/);
  assert.match(packageJson, /"packageManager": "pnpm@/);
  assert.match(packageJson, /"lucide-react"/);
});
