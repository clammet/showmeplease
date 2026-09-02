import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("static export renders the functional screen-share entry", async () => {
  const html = await readFile(new URL("dist/client/index.html", root), "utf8");
  assert.match(html, /<title>showmeplease — simple screen sharing<\/title>/i);
  assert.match(html, /Share a screen/);
  assert.match(html, /Create share/);
  assert.match(html, /or join/);
  assert.match(html, /aria-label="Share ID"/);
});

test("static export includes the admin dashboard and auth callback routes", async () => {
  const admin = await readFile(new URL("dist/client/admin.html", root), "utf8").catch(
    () => readFile(new URL("dist/client/admin/index.html", root), "utf8"),
  );
  assert.match(admin, /showmeplease — admin/i);
  await readFile(new URL("dist/client/auth/callback.html", root), "utf8").catch(() =>
    readFile(new URL("dist/client/auth/callback/index.html", root), "utf8"),
  );
});

test("realtime secret stays server-side", async () => {
  const proxy = await readFile(new URL("server/realtimeProxy.ts", root), "utf8");
  assert.match(proxy, /REALTIME_APP_SECRET/);
  const clientLib = await readFile(new URL("lib/realtime.ts", root), "utf8");
  assert.doesNotMatch(clientLib, /REALTIME_APP_SECRET/);
});
