import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionHub } from "./hub";
import { readBody, readJson, sendJson, SECURITY_HEADERS } from "./http";

// The browser talks only to this server; the Realtime app secret never leaves
// it. Only the operations the client needs are forwarded, and every
// Cloudflare session id in a request must belong to the caller (or, for
// remote pulls, to someone in the caller's room).

const REALTIME_BASE = "https://rtc.live.cloudflare.com/v1";
const UPSTREAM_TIMEOUT_MS = 15_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

const STUN_ONLY: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * Short-lived TURN credentials from Cloudflare when TURN_KEY_ID and
 * TURN_KEY_API_TOKEN are set; STUN only otherwise.
 */
async function iceServers(): Promise<IceServer[]> {
  const keyId = process.env.TURN_KEY_ID;
  const keyToken = process.env.TURN_KEY_API_TOKEN;
  if (!keyId || !keyToken) return STUN_ONLY;
  const response = await fetch(`${REALTIME_BASE}/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: 3600 }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TURN credential request failed (${response.status})`);
  const payload = (await response.json()) as { iceServers?: IceServer | IceServer[] };
  const servers = payload.iceServers;
  if (!servers) throw new Error("TURN credential response had no iceServers");
  return [...STUN_ONLY, ...(Array.isArray(servers) ? servers : [servers])];
}

export async function handleRealtimeProxy(
  request: IncomingMessage,
  response: ServerResponse,
  hub: SessionHub,
  pathname: string,
): Promise<void> {
  const appId = process.env.REALTIME_APP_ID;
  const appSecret = process.env.REALTIME_APP_SECRET;
  if (!appId || !appSecret) {
    sendJson(response, 503, {
      error: "Realtime is not configured",
      detail: "Add REALTIME_APP_ID and REALTIME_APP_SECRET to the server environment.",
    });
    return;
  }

  const code = (request.headers["x-session-code"] as string | undefined)?.toUpperCase();
  const token = request.headers["x-session-token"] as string | undefined;
  const participant = code && token ? hub.authorize(code, token) : null;
  if (!code || !token || !participant) {
    sendJson(response, 401, { error: "Session authorization failed" });
    return;
  }

  if (pathname === "/api/realtime/ice" && request.method === "GET") {
    try {
      sendJson(response, 200, { iceServers: await iceServers() });
    } catch (error) {
      console.error("TURN credentials unavailable, falling back to STUN:", error);
      sendJson(response, 200, { iceServers: STUN_ONLY });
    }
    return;
  }

  const upstreamHeaders = {
    authorization: `Bearer ${appSecret}`,
    "content-type": "application/json",
  };

  if (pathname === "/api/realtime/sessions/new" && request.method === "POST") {
    const upstream = await fetch(`${REALTIME_BASE}/apps/${appId}/sessions/new`, {
      method: "POST",
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await upstream.text();
    if (upstream.ok) {
      let sessionId: unknown;
      try {
        sessionId = (JSON.parse(body) as { sessionId?: unknown }).sessionId;
      } catch {
        sessionId = undefined;
      }
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        sendJson(response, 502, { error: "Cloudflare did not return a session id" });
        return;
      }
      hub.registerRealtimeSession(code, token, sessionId);
    }
    relay(response, upstream, body);
    return;
  }

  const tracks = pathname.match(/^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/tracks\/new$/);
  const renegotiate = pathname.match(/^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/renegotiate$/);

  if (tracks && request.method === "POST") {
    const sessionId = tracks[1];
    if (!hub.ownsRealtimeSession(code, token, sessionId)) {
      sendJson(response, 403, { error: "That Realtime session is not yours" });
      return;
    }
    const body = await readJson(request);
    if (!Array.isArray(body.tracks)) {
      sendJson(response, 400, { error: "Missing tracks" });
      return;
    }
    for (const track of body.tracks as unknown[]) {
      if (typeof track !== "object" || track === null) {
        sendJson(response, 400, { error: "Malformed track" });
        return;
      }
      const { location, sessionId: remoteSessionId } = track as Record<string, unknown>;
      if (location === "remote") {
        if (
          typeof remoteSessionId !== "string" ||
          !hub.roomHasRealtimeSession(code, remoteSessionId)
        ) {
          sendJson(response, 403, { error: "That track is not part of this share" });
          return;
        }
      } else if (location !== "local") {
        sendJson(response, 400, { error: "Malformed track" });
        return;
      }
    }
    const upstream = await fetch(`${REALTIME_BASE}/apps/${appId}/sessions/${sessionId}/tracks/new`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    relay(response, upstream, await upstream.text());
    return;
  }

  if (renegotiate && request.method === "PUT") {
    const sessionId = renegotiate[1];
    if (!hub.ownsRealtimeSession(code, token, sessionId)) {
      sendJson(response, 403, { error: "That Realtime session is not yours" });
      return;
    }
    const body = await readBody(request);
    const upstream = await fetch(`${REALTIME_BASE}/apps/${appId}/sessions/${sessionId}/renegotiate`, {
      method: "PUT",
      headers: upstreamHeaders,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    relay(response, upstream, await upstream.text());
    return;
  }

  sendJson(response, 404, { error: "Unsupported Realtime operation" });
}

function relay(response: ServerResponse, upstream: Response, body: string) {
  response.writeHead(upstream.status, {
    ...SECURITY_HEADERS,
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  });
  response.end(body);
}
