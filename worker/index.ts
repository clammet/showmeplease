import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import type { SessionOptions, SharedTrack } from "../lib/realtime";

type RoomRecord = {
  creatorToken: string;
  options: SessionOptions;
  createdAt: number;
};

type ChatMessage = {
  type: "chat";
  id: string;
  senderId: string;
  senderRole: "creator" | "viewer";
  text: string;
  timestamp: number;
};

type SocketClient = {
  id: string;
  role: "creator" | "viewer";
  socket: WebSocket;
};

type DurableObjectIdLike = object;

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  SESSION_HUB: DurableObjectNamespaceLike;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const json = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(
    bytes,
    (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length],
  ).join("");
}

function roomStub(env: Env, code: string) {
  return env.SESSION_HUB.get(env.SESSION_HUB.idFromName(code));
}

function internalRequest(path: string, body?: unknown, request?: Request) {
  return new Request(`https://room.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(request?.headers.get("upgrade")
        ? { upgrade: request.headers.get("upgrade") as string }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createRoom(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as {
    options?: SessionOptions;
  };
  if (!body.options) return json({ error: "Missing session options" }, { status: 400 });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = createCode();
    const creatorToken = crypto.randomUUID();
    const response = await roomStub(env, code).fetch(
      internalRequest("/init", {
        creatorToken,
        options: body.options,
        createdAt: Date.now(),
      }),
    );
    if (response.status === 201) {
      return json({ code, token: creatorToken, options: body.options });
    }
  }

  return json({ error: "Could not allocate a session code" }, { status: 503 });
}

async function joinRoom(request: Request, env: Env, code: string) {
  const body = (await request.json().catch(() => ({}))) as { clientId?: string };
  if (!body.clientId) return json({ error: "Missing client ID" }, { status: 400 });
  return roomStub(env, code).fetch(
    internalRequest("/join", { clientId: body.clientId }),
  );
}

async function authorizeRealtime(request: Request, env: Env) {
  const code = request.headers.get("x-session-code")?.toUpperCase();
  const token = request.headers.get("x-session-token");
  if (!code || !token) return false;
  const response = await roomStub(env, code).fetch(
    internalRequest("/authorize", { token }),
  );
  return response.ok;
}

async function realtimeProxy(request: Request, env: Env, path: string) {
  if (!env.REALTIME_APP_ID || !env.REALTIME_APP_SECRET) {
    return json(
      {
        error: "Realtime is not configured",
        detail:
          "Add REALTIME_APP_ID and REALTIME_APP_SECRET to the Worker environment.",
      },
      { status: 503 },
    );
  }
  if (!(await authorizeRealtime(request, env))) {
    return json({ error: "Session authorization failed" }, { status: 401 });
  }

  let upstreamPath: string | null = null;
  let method: "POST" | "PUT" | null = null;
  if (path === "/api/realtime/sessions/new" && request.method === "POST") {
    upstreamPath = `/apps/${env.REALTIME_APP_ID}/sessions/new`;
    method = "POST";
  } else {
    const tracks = path.match(
      /^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/tracks\/new$/,
    );
    const renegotiate = path.match(
      /^\/api\/realtime\/sessions\/([A-Za-z0-9_-]+)\/renegotiate$/,
    );
    if (tracks && request.method === "POST") {
      upstreamPath = `/apps/${env.REALTIME_APP_ID}/sessions/${tracks[1]}/tracks/new`;
      method = "POST";
    } else if (renegotiate && request.method === "PUT") {
      upstreamPath = `/apps/${env.REALTIME_APP_ID}/sessions/${renegotiate[1]}/renegotiate`;
      method = "PUT";
    }
  }

  if (!upstreamPath || !method) {
    return json({ error: "Unsupported Realtime operation" }, { status: 404 });
  }

  const requestBody = path.endsWith("/sessions/new")
    ? undefined
    : await request.text();
  const upstream = await fetch(`https://rtc.live.cloudflare.com/v1${upstreamPath}`, {
    method,
    headers: {
      authorization: `Bearer ${env.REALTIME_APP_SECRET}`,
      "content-type": "application/json",
    },
    body: requestBody || undefined,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}

async function routeApi(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/sessions" && request.method === "POST") {
    return createRoom(request, env);
  }

  const join = url.pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/join$/i);
  if (join && request.method === "POST") {
    return joinRoom(request, env, join[1].toUpperCase());
  }

  const socket = url.pathname.match(/^\/api\/sessions\/([A-Z0-9]{6})\/ws$/i);
  if (socket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const target = new URL(request.url);
    target.hostname = "room.internal";
    target.pathname = "/socket";
    return roomStub(env, socket[1].toUpperCase()).fetch(
      new Request(target, request),
    );
  }

  if (url.pathname.startsWith("/api/realtime/")) {
    return realtimeProxy(request, env, url.pathname);
  }

  return null;
}

export class SessionHub {
  private readonly state: DurableObjectStateLike;
  private clients = new Map<WebSocket, SocketClient>();
  private viewerTokens = new Set<string>();
  private viewerTokensLoaded = false;
  private messages: ChatMessage[] = [];
  private sharedTracks: SharedTrack[] = [];

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  private async record() {
    return this.state.storage.get<RoomRecord>("room");
  }

  private async loadViewerTokens() {
    if (!this.viewerTokensLoaded) {
      const stored = (await this.state.storage.get<string[]>("viewerTokens")) ?? [];
      this.viewerTokens = new Set(stored);
      this.viewerTokensLoaded = true;
    }
    return this.viewerTokens;
  }

  private async addViewerToken(token: string) {
    const tokens = await this.loadViewerTokens();
    tokens.add(token);
    const bounded = Array.from(tokens).slice(-512);
    this.viewerTokens = new Set(bounded);
    await this.state.storage.put("viewerTokens", bounded);
  }

  private creatorOnline() {
    return Array.from(this.clients.values()).some(
      (client) => client.role === "creator",
    );
  }

  private viewerCount() {
    return Array.from(this.clients.values()).filter(
      (client) => client.role === "viewer",
    ).length;
  }

  private send(socket: WebSocket, value: unknown) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(value));
    }
  }

  private broadcast(value: unknown, role?: SocketClient["role"]) {
    for (const client of this.clients.values()) {
      if (!role || client.role === role) this.send(client.socket, value);
    }
  }

  private presence() {
    this.broadcast({
      type: "presence",
      viewerCount: this.viewerCount(),
      creatorOnline: this.creatorOnline(),
    });
  }

  private async handleMessage(client: SocketClient, raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type === "ping") {
      this.send(client.socket, { type: "pong", at: Date.now() });
      return;
    }

    if (message.type === "chat" && typeof message.text === "string") {
      const text = message.text.trim().slice(0, 2000);
      if (!text) return;
      const chat: ChatMessage = {
        type: "chat",
        id: crypto.randomUUID(),
        senderId: client.id,
        senderRole: client.role,
        text,
        timestamp: Date.now(),
      };
      this.messages.push(chat);
      if (this.messages.length > 100) this.messages.splice(0, this.messages.length - 100);
      this.broadcast(chat);
      return;
    }

    if (
      client.role === "creator" &&
      (message.type === "tracks-ready" || message.type === "tracks-added") &&
      Array.isArray(message.tracks)
    ) {
      const incoming = message.tracks as SharedTrack[];
      for (const track of incoming) {
        if (!this.sharedTracks.some((existing) => existing.trackName === track.trackName)) {
          this.sharedTracks.push(track);
        }
      }
      this.broadcast({ type: message.type, tracks: incoming }, "viewer");
      return;
    }

    if (
      client.role === "viewer" &&
      message.type === "viewer-audio" &&
      message.track
    ) {
      this.broadcast(
        { type: "viewer-audio", track: message.track, viewerId: client.id },
        "creator",
      );
      return;
    }

    if (client.role === "creator" && message.type === "mic-policy") {
      const room = await this.record();
      if (room) {
        room.options.allowViewerMic = Boolean(message.allowed);
        await this.state.storage.put("room", room);
      }
      this.broadcast(
        { type: "mic-policy", allowed: Boolean(message.allowed) },
        "viewer",
      );
      return;
    }

    if (client.role === "creator" && message.type === "creator-end") {
      this.broadcast({ type: "creator-end" }, "viewer");
      this.sharedTracks = [];
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (await this.record()) return json({ error: "Code already used" }, { status: 409 });
      const room = (await request.json()) as RoomRecord;
      await this.state.storage.put("room", room);
      return json({ ok: true }, { status: 201 });
    }

    if (url.pathname === "/join" && request.method === "POST") {
      const room = await this.record();
      if (!room || !this.creatorOnline()) {
        return json({ error: "That share is not available" }, { status: 404 });
      }
      const token = crypto.randomUUID();
      await this.addViewerToken(token);
      return json({ token, options: room.options });
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const room = await this.record();
      const { token } = (await request.json()) as { token?: string };
      const viewerTokens = await this.loadViewerTokens();
      const allowed = Boolean(
        room && token && (token === room.creatorToken || viewerTokens.has(token)),
      );
      return json({ allowed }, { status: allowed ? 200 : 401 });
    }

    if (url.pathname !== "/socket") {
      return json({ error: "Not found" }, { status: 404 });
    }

    const room = await this.record();
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");
    const clientId = url.searchParams.get("clientId");
    const viewerTokens = await this.loadViewerTokens();
    const allowed = Boolean(
      room &&
        clientId &&
        (role === "creator" || role === "viewer") &&
        token &&
        (role === "creator"
          ? token === room.creatorToken
          : viewerTokens.has(token)),
    );
    if (!allowed || !room || !clientId || (role !== "creator" && role !== "viewer")) {
      return json({ error: "Socket authorization failed" }, { status: 401 });
    }

    const Pair = (globalThis as unknown as {
      WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
    }).WebSocketPair;
    const pair = new Pair();
    const clientSocket = pair[0];
    const serverSocket = pair[1] as WebSocket & { accept(): void };
    serverSocket.accept();

    const socketClient: SocketClient = { id: clientId, role, socket: serverSocket };
    this.clients.set(serverSocket, socketClient);
    this.send(serverSocket, {
      type: "welcome",
      options: room.options,
      messages: this.messages,
      tracks: this.sharedTracks,
      viewerCount: this.viewerCount(),
    });
    if (role === "viewer") {
      this.broadcast(
        { type: "viewer-waiting", viewerCount: this.viewerCount() },
        "creator",
      );
    }
    this.presence();

    serverSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") void this.handleMessage(socketClient, event.data);
    });
    const disconnect = () => {
      this.clients.delete(serverSocket);
      if (role === "viewer") {
        this.broadcast({ type: "viewer-left", viewerId: clientId }, "creator");
      }
      this.presence();
    };
    serverSocket.addEventListener("close", disconnect, { once: true });
    serverSocket.addEventListener("error", disconnect, { once: true });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit & { webSocket: WebSocket });
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const apiResponse = await routeApi(request, env);
    if (apiResponse) return apiResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
