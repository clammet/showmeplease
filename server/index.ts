import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { SessionOptions } from "../lib/realtime";
import { checkAdmin } from "./adminAuth";
import { loadEnvFiles } from "./env";
import { CloudflareUsagePoller } from "./egress";
import { readJson, sendJson } from "./http";
import { SessionHub } from "./hub";
import { handleRealtimeProxy } from "./realtimeProxy";
import { StaticServer } from "./staticFiles";

loadEnvFiles();

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

// In the container the bundle lives in dist/backend and the frontend export
// in dist/client; when run from source (tsx) the same relative layout holds.
const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = process.env.STATIC_ROOT ?? resolve(here, "../client");
const statics = new StaticServer(staticRoot);

const hub = new SessionHub();

const cloudflarePoller =
  process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.REALTIME_APP_ID
    ? new CloudflareUsagePoller({
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        appId: process.env.REALTIME_APP_ID,
      })
    : null;
cloudflarePoller?.start();

function validOptions(options: unknown): options is SessionOptions {
  if (typeof options !== "object" || options === null) return false;
  const candidate = options as Partial<SessionOptions>;
  return (
    typeof candidate.codec === "string" &&
    typeof candidate.maxBitrateKbps === "number" &&
    typeof candidate.frameRate === "number" &&
    typeof candidate.includeSystemAudio === "boolean" &&
    typeof candidate.allowViewerMic === "boolean"
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://internal");
  const pathname = url.pathname;

  try {
    if (pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }

    // Runtime configuration for the static frontend (Docker-friendly: no
    // rebuild needed to point at a different Convex deployment).
    if (pathname === "/api/config" && request.method === "GET") {
      const convexUrl = process.env.CONVEX_URL;
      const convexSiteUrl = process.env.CONVEX_SITE_URL;
      const googleClientId = process.env.AUTH_GOOGLE_ID;
      sendJson(response, 200, {
        auth:
          convexUrl && convexSiteUrl && googleClientId
            ? { convexUrl, convexSiteUrl, googleClientId }
            : null,
      });
      return;
    }

    if (pathname === "/api/sessions" && request.method === "POST") {
      const body = await readJson<{ options?: unknown }>(request);
      if (!validOptions(body.options)) {
        sendJson(response, 400, { error: "Missing session options" });
        return;
      }
      const created = hub.createRoom(body.options);
      if (!created) {
        sendJson(response, 503, { error: "Could not allocate a session code" });
        return;
      }
      sendJson(response, 200, { ...created, options: body.options });
      return;
    }

    const join = pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/join$/i);
    if (join && request.method === "POST") {
      const body = await readJson<{ clientId?: string }>(request);
      if (!body.clientId) {
        sendJson(response, 400, { error: "Missing client ID" });
        return;
      }
      const joined = hub.join(join[1]);
      if (!joined) {
        sendJson(response, 404, { error: "That share is not available" });
        return;
      }
      sendJson(response, 200, joined);
      return;
    }

    if (pathname.startsWith("/api/realtime/")) {
      await handleRealtimeProxy(request, response, hub, pathname);
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      const admin = await checkAdmin(request);
      if (!admin.ok) {
        sendJson(response, admin.status, { error: admin.error });
        return;
      }

      if (pathname === "/api/admin/overview" && request.method === "GET") {
        const now = Date.now();
        sendJson(response, 200, {
          now,
          startedAt: hub.startedAt,
          sessionsCreated: hub.sessionsCreated,
          wsClients: hub.wsClientCount(),
          totals: {
            egressBytes: hub.ledger.totalEgressBytes,
            ingressBytes: hub.ledger.totalIngressBytes,
            egressBytesLastHour: hub.ledger.bytesInLast(60),
          },
          series: hub.ledger.series(60),
          sessions: hub.activeRooms().map((room) => ({
            code: room.code,
            createdAt: room.createdAt,
            creatorOnline: hub.creatorOnline(room),
            viewerCount: hub.viewerCount(room),
            egressBytes: room.egressBytes,
            ingressBytes: room.ingressBytes,
            options: room.options,
          })),
          endedSessions: hub.endedSessions(),
          cloudflare: cloudflarePoller
            ? cloudflarePoller.snapshot()
            : { enabled: false, egressBytes24h: null, updatedAt: null, error: null },
        });
        return;
      }

      const terminate = pathname.match(/^\/api\/admin\/sessions\/([A-Z0-9]{6})$/i);
      if (terminate && request.method === "DELETE") {
        if (!hub.terminate(terminate[1].toUpperCase())) {
          sendJson(response, 404, { error: "No such session" });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (!statics.available()) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(
        "Frontend build not found. Run `pnpm build` (or use the Docker image), or use `pnpm dev` for development.\n",
      );
      return;
    }
    await statics.serve(request, response, pathname);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://internal");
  const match = url.pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/ws$/i);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const accepted = hub.connect(
      match[1].toUpperCase(),
      url.searchParams.get("role"),
      url.searchParams.get("token"),
      url.searchParams.get("clientId"),
      ws,
    );
    if (!accepted) ws.close(4001, "Socket authorization failed");
  });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`showmeplease backend listening on http://${HOST}:${port}`);
  console.log(`  static frontend: ${statics.available() ? staticRoot : "not built (API only)"}`);
  console.log(`  realtime proxy:  ${process.env.REALTIME_APP_ID ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  convex auth:     ${process.env.CONVEX_URL ? "configured" : "not configured"}`);
  console.log(`  cloudflare usage poller: ${cloudflarePoller ? "enabled" : "disabled"}`);
});
