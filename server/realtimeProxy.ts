import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionHub } from "./hub";
import { readBody, sendJson } from "./http";

// The browser talks only to this server; the Realtime app secret never leaves
// it. Only the three operations the client needs are forwarded.
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
  if (!code || !token || !hub.authorize(code, token)) {
    sendJson(response, 401, { error: "Session authorization failed" });
    return;
  }

  let upstreamPath: string | null = null;
  let method: "POST" | "PUT" | null = null;
  if (pathname === "/api/realtime/sessions/new" && request.method === "POST") {
    upstreamPath = `/apps/${appId}/sessions/new`;
    method = "POST";
  } else {
    const tracks = pathname.match(/^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/tracks\/new$/);
    const renegotiate = pathname.match(
      /^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/renegotiate$/,
    );
    if (tracks && request.method === "POST") {
      upstreamPath = `/apps/${appId}/sessions/${tracks[1]}/tracks/new`;
      method = "POST";
    } else if (renegotiate && request.method === "PUT") {
      upstreamPath = `/apps/${appId}/sessions/${renegotiate[1]}/renegotiate`;
      method = "PUT";
    }
  }

  if (!upstreamPath || !method) {
    sendJson(response, 404, { error: "Unsupported Realtime operation" });
    return;
  }

  const requestBody = pathname.endsWith("/sessions/new") ? undefined : await readBody(request);
  const upstream = await fetch(`https://rtc.live.cloudflare.com/v1${upstreamPath}`, {
    method,
    headers: {
      authorization: `Bearer ${appSecret}`,
      "content-type": "application/json",
    },
    body: requestBody || undefined,
  });

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}
