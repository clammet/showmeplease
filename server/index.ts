import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CLIENT_ID_PATTERN, parseSessionOptions } from "../lib/options";
import { checkAdmin, insecureAdminEnabled } from "./adminAuth";
import { loadEnvFiles } from "./env";
import {
  CLOUDFLARE_FREE_TIER_BYTES,
  CloudflareUsagePoller,
  utcBillingPeriod,
} from "./egress";
import { clientAddress, HttpError, readJson, SECURITY_HEADERS, sendJson } from "./http";
import { SessionHub } from "./hub";
import { RateLimiter } from "./rateLimit";
import { handleRealtimeProxy } from "./realtimeProxy";
import { StaticServer } from "./staticFiles";

loadEnvFiles();

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const WS_MAX_PAYLOAD = 64 * 1024;
const WS_AUTH_TIMEOUT_MS = 5_000;

// These public Convex endpoints use the same Vite-prefixed names managed by
// the Convex CLI. Defining parallel CONVEX_* aliases makes Convex reject the
// environment as ambiguous.
const convexUrl = process.env.VITE_CONVEX_URL;
const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL;
const googleClientId = process.env.AUTH_GOOGLE_ID;
const authConfig =
  convexUrl && convexSiteUrl && googleClientId
    ? { convexUrl, convexSiteUrl, googleClientId }
    : null;

// In the container the bundle lives in dist/backend and the frontend export
// in dist/client; when run from source (tsx) the same relative layout holds.
const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = process.env.STATIC_ROOT ?? resolve(here, "../client");
const statics = new StaticServer(staticRoot);

const hub = new SessionHub();

// Per-address limits on the two unauthenticated endpoints that allocate state.
const createLimiter = new RateLimiter(10, 60_000);
const joinLimiter = new RateLimiter(30, 60_000);
setInterval(() => {
  createLimiter.sweep();
  joinLimiter.sweep();
}, 5 * 60_000).unref();

const cloudflarePoller =
  process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID
    ? new CloudflareUsagePoller({
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      })
    : null;
cloudflarePoller?.start();

function validClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://internal");
  const pathname = url.pathname;

  try {
    if (pathname === "/healthz") {
      response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }

    // Unauthenticated liveness-plus-load probe: aggregate counts only (no
    // session codes). Deployment tooling uses `busy` to defer container
    // restarts (e.g. image updates) until no session is in progress.
    if (pathname === "/api/status" && request.method === "GET") {
      sendJson(response, 200, { ok: true, uptimeMs: Date.now() - hub.startedAt, ...hub.status() });
      return;
    }

    // Runtime configuration for the static frontend (Docker-friendly: no
    // rebuild needed to point at a different Convex deployment).
    if (pathname === "/api/config" && request.method === "GET") {
      sendJson(response, 200, { auth: authConfig });
      return;
    }

    if (pathname === "/api/sessions" && request.method === "POST") {
      if (!createLimiter.allow(clientAddress(request))) {
        sendJson(response, 429, { error: "Too many shares created; try again in a minute" });
        return;
      }
      const body = await readJson(request);
      const options = parseSessionOptions(body.options);
      if (!options) {
        sendJson(response, 400, { error: "Missing or invalid session options" });
        return;
      }
      if (!validClientId(body.clientId)) {
        sendJson(response, 400, { error: "Missing client ID" });
        return;
      }
      const created = hub.createRoom(options, body.clientId);
      if (!created) {
        sendJson(response, 503, { error: "Could not allocate a session code" });
        return;
      }
      sendJson(response, 200, { ...created, options });
      return;
    }

    const join = pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/join$/i);
    if (join && request.method === "POST") {
      if (!joinLimiter.allow(clientAddress(request))) {
        sendJson(response, 429, { error: "Too many join attempts; try again in a minute" });
        return;
      }
      const body = await readJson(request);
      if (!validClientId(body.clientId)) {
        sendJson(response, 400, { error: "Missing client ID" });
        return;
      }
      const joined = hub.join(join[1], body.clientId);
      if (joined === null) {
        sendJson(response, 404, { error: "That share is not available" });
        return;
      }
      if (joined === "full") {
        sendJson(response, 503, { error: "That share is full" });
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
        const requestedCycleDay = Number(url.searchParams.get("billingCycleDay") ?? 1);
        const billingCycleDay =
          Number.isInteger(requestedCycleDay) && requestedCycleDay >= 1 && requestedCycleDay <= 31
            ? requestedCycleDay
            : 1;
        const billingPeriod = utcBillingPeriod(billingCycleDay, now);
        const billingPeriodTotals = hub.ledger.bytesSince(billingPeriod.start);
        sendJson(response, 200, {
          now,
          startedAt: hub.startedAt,
          billingCycleDay,
          billingPeriodStart: billingPeriod.start,
          billingPeriodEnd: billingPeriod.end,
          sessionsCreated: hub.sessionsCreated,
          wsClients: hub.wsClientCount(),
          totals: {
            egressBytesBillingPeriod: billingPeriodTotals.egressBytes,
            ingressBytesBillingPeriod: billingPeriodTotals.ingressBytes,
            egressBytesLastDay: hub.ledger.bytesInLast(24 * 60),
          },
          series: hub.ledger.series(24 * 60, 15),
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
            ? cloudflarePoller.snapshot(billingPeriod.start, billingPeriod.end)
            : {
                enabled: false,
                egressBytesBillingPeriod: null,
                dailySeries: [],
                billingPeriodStart: billingPeriod.start,
                billingPeriodEnd: billingPeriod.end,
                freeTierBytes: CLOUDFLARE_FREE_TIER_BYTES,
                updatedAt: null,
                error: null,
              },
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
      response.writeHead(503, { ...SECURITY_HEADERS, "content-type": "text/plain" });
      response.end(
        "Frontend build not found. Run `pnpm build` (or use the Docker image), or use `pnpm dev` for development.\n",
      );
      return;
    }
    await statics.serve(request, response, pathname);
  } catch (error) {
    if (error instanceof HttpError) {
      if (!response.headersSent) sendJson(response, error.status, { error: error.message });
      else response.end();
      return;
    }
    console.error("Request failed:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

/**
 * Sockets authenticate with their first message, `{type: "auth", role, token,
 * clientId}`, so the token never appears in a URL or access log. Close codes:
 * 4001 bad credentials, 4002 no auth message in time, 4004 session ended.
 */
function awaitAuth(code: string, ws: WebSocket) {
  const timer = setTimeout(() => ws.close(4002, "Authentication timed out"), WS_AUTH_TIMEOUT_MS);
  ws.once("message", (data, isBinary) => {
    clearTimeout(timer);
    let message: Record<string, unknown> = {};
    try {
      if (!isBinary) message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      message = {};
    }
    const role = typeof message.role === "string" ? message.role : null;
    const token = typeof message.token === "string" ? message.token : null;
    const clientId = validClientId(message.clientId) ? message.clientId : null;
    const accepted =
      message.type === "auth" && hub.connect(code, role, token, clientId, ws);
    if (!accepted) ws.close(4001, "Socket authorization failed");
  });
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://internal");
  const match = url.pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/ws$/i);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => awaitAuth(match[1].toUpperCase(), ws));
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`showmeplease backend listening on http://${HOST}:${port}`);
  console.log(`  static frontend: ${statics.available() ? staticRoot : "not built (API only)"}`);
  console.log(`  realtime proxy:  ${process.env.REALTIME_APP_ID ? "configured" : "NOT CONFIGURED"}`);
  console.log(`  turn:            ${process.env.TURN_KEY_ID ? "configured" : "STUN only"}`);
  console.log(`  convex auth:     ${authConfig ? "configured" : "not configured"}`);
  console.log(`  cloudflare usage poller: ${cloudflarePoller ? "enabled" : "disabled"}`);
  if (process.env.ADMIN_ALLOW_INSECURE === "1") {
    console.log(
      insecureAdminEnabled()
        ? "  WARNING: ADMIN_ALLOW_INSECURE=1, /api/admin is open without sign-in"
        : "  ADMIN_ALLOW_INSECURE=1 ignored because NODE_ENV=production",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.close();
    cloudflarePoller?.stop();
    server.close();
    wss.close();
    process.exit(0);
  });
}
