import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { SessionOptions, SharedTrack } from "../lib/realtime";
import { EgressLedger } from "./egress";

type Role = "creator" | "viewer";

export type ChatMessage = {
  type: "chat";
  id: string;
  senderId: string;
  senderRole: Role;
  text: string;
  timestamp: number;
};

type SocketClient = {
  id: string;
  connectionId: string;
  role: Role;
  socket: WebSocket;
  // Last cumulative RTCPeerConnection byte counters reported by this client.
  lastInboundBytes: number;
  lastOutboundBytes: number;
};

export type Room = {
  code: string;
  creatorToken: string;
  viewerTokens: Set<string>;
  options: SessionOptions;
  createdAt: number;
  lastActivity: number;
  clients: Map<WebSocket, SocketClient>;
  messages: ChatMessage[];
  sharedTracks: SharedTrack[];
  egressBytes: number;
  ingressBytes: number;
};

export type EndedSession = {
  code: string;
  createdAt: number;
  endedAt: number;
  egressBytes: number;
  ingressBytes: number;
};

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_VIEWER_TOKENS = 512;
const MAX_MESSAGES = 100;
const IDLE_ROOM_TTL_MS = 60 * 60_000;
const MAX_ENDED_SESSIONS = 50;

function createCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export class SessionHub {
  readonly ledger = new EgressLedger();
  readonly startedAt = Date.now();
  sessionsCreated = 0;
  private rooms = new Map<string, Room>();
  private ended: EndedSession[] = [];
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 10 * 60_000);
    this.sweeper.unref();
  }

  createRoom(options: SessionOptions): { code: string; token: string } | null {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = createCode();
      if (this.rooms.has(code)) continue;
      const creatorToken = randomUUID();
      this.rooms.set(code, {
        code,
        creatorToken,
        viewerTokens: new Set(),
        options,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        clients: new Map(),
        messages: [],
        sharedTracks: [],
        egressBytes: 0,
        ingressBytes: 0,
      });
      this.sessionsCreated += 1;
      return { code, token: creatorToken };
    }
    return null;
  }

  room(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  join(code: string): { token: string; options: SessionOptions } | null {
    const room = this.room(code);
    if (!room || !this.creatorOnline(room)) return null;
    const token = randomUUID();
    room.viewerTokens.add(token);
    if (room.viewerTokens.size > MAX_VIEWER_TOKENS) {
      const excess = room.viewerTokens.size - MAX_VIEWER_TOKENS;
      for (const stale of Array.from(room.viewerTokens).slice(0, excess)) {
        room.viewerTokens.delete(stale);
      }
    }
    room.lastActivity = Date.now();
    return { token, options: room.options };
  }

  authorize(code: string, token: string): boolean {
    const room = this.room(code);
    return Boolean(
      room && token && (token === room.creatorToken || room.viewerTokens.has(token)),
    );
  }

  creatorOnline(room: Room) {
    return Array.from(room.clients.values()).some((client) => client.role === "creator");
  }

  viewerCount(room: Room) {
    return Array.from(room.clients.values()).filter((client) => client.role === "viewer")
      .length;
  }

  wsClientCount() {
    let count = 0;
    for (const room of this.rooms.values()) count += room.clients.size;
    return count;
  }

  activeRooms(): Room[] {
    return Array.from(this.rooms.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  endedSessions(): EndedSession[] {
    return [...this.ended];
  }

  /** Admin action: end a session, notify everyone, and drop the room. */
  terminate(code: string): boolean {
    const room = this.room(code);
    if (!room) return false;
    this.broadcast(room, { type: "creator-end" });
    for (const client of room.clients.values()) client.socket.close(1000, "session ended");
    this.retire(room);
    return true;
  }

  private retire(room: Room) {
    this.rooms.delete(room.code);
    this.ended.unshift({
      code: room.code,
      createdAt: room.createdAt,
      endedAt: Date.now(),
      egressBytes: room.egressBytes,
      ingressBytes: room.ingressBytes,
    });
    if (this.ended.length > MAX_ENDED_SESSIONS) this.ended.length = MAX_ENDED_SESSIONS;
  }

  private sweep() {
    const now = Date.now();
    for (const room of Array.from(this.rooms.values())) {
      if (room.clients.size === 0 && now - room.lastActivity > IDLE_ROOM_TTL_MS) {
        this.retire(room);
      }
    }
  }

  private send(socket: WebSocket, value: unknown) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  }

  private broadcast(room: Room, value: unknown, role?: Role) {
    for (const client of room.clients.values()) {
      if (!role || client.role === role) this.send(client.socket, value);
    }
  }

  private presence(room: Room) {
    this.broadcast(room, {
      type: "presence",
      viewerCount: this.viewerCount(room),
      creatorOnline: this.creatorOnline(room),
    });
  }

  /**
   * Attach an already-upgraded WebSocket to a room. Returns false when the
   * caller's token does not authorize the requested role.
   */
  connect(
    code: string,
    role: string | null,
    token: string | null,
    clientId: string | null,
    socket: WebSocket,
  ): boolean {
    const room = this.room(code);
    const allowed = Boolean(
      room &&
        clientId &&
        (role === "creator" || role === "viewer") &&
        token &&
        (role === "creator" ? token === room.creatorToken : room.viewerTokens.has(token)),
    );
    if (!allowed || !room || !clientId || (role !== "creator" && role !== "viewer")) {
      return false;
    }

    const client: SocketClient = {
      id: clientId,
      connectionId: randomUUID(),
      role,
      socket,
      lastInboundBytes: 0,
      lastOutboundBytes: 0,
    };
    room.clients.set(socket, client);
    room.lastActivity = Date.now();

    this.send(socket, {
      type: "welcome",
      options: room.options,
      messages: room.messages,
      tracks: room.sharedTracks,
      viewerCount: this.viewerCount(room),
    });
    if (role === "viewer") {
      this.broadcast(
        room,
        { type: "viewer-waiting", viewerCount: this.viewerCount(room) },
        "creator",
      );
    }
    this.presence(room);

    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.handleMessage(room, client, data.toString());
    });
    const disconnect = () => {
      if (!room.clients.delete(socket)) return;
      if (role === "viewer") {
        this.broadcast(room, { type: "viewer-left", viewerId: clientId }, "creator");
      }
      room.lastActivity = Date.now();
      this.presence(room);
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
    return true;
  }

  private handleMessage(room: Room, client: SocketClient, raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    room.lastActivity = Date.now();

    if (message.type === "ping") {
      this.send(client.socket, { type: "pong", at: Date.now() });
      return;
    }

    if (message.type === "stats") {
      this.recordStats(room, client, message);
      return;
    }

    if (message.type === "chat" && typeof message.text === "string") {
      const text = message.text.trim().slice(0, 2000);
      if (!text) return;
      const chat: ChatMessage = {
        type: "chat",
        id: randomUUID(),
        senderId: client.id,
        senderRole: client.role,
        text,
        timestamp: Date.now(),
      };
      room.messages.push(chat);
      if (room.messages.length > MAX_MESSAGES) {
        room.messages.splice(0, room.messages.length - MAX_MESSAGES);
      }
      this.broadcast(room, chat);
      return;
    }

    if (
      client.role === "creator" &&
      (message.type === "tracks-ready" || message.type === "tracks-added") &&
      Array.isArray(message.tracks)
    ) {
      const incoming = message.tracks as SharedTrack[];
      for (const track of incoming) {
        if (!room.sharedTracks.some((existing) => existing.trackName === track.trackName)) {
          room.sharedTracks.push(track);
        }
      }
      this.broadcast(room, { type: message.type, tracks: incoming }, "viewer");
      return;
    }

    if (client.role === "viewer" && message.type === "viewer-audio" && message.track) {
      this.broadcast(
        room,
        { type: "viewer-audio", track: message.track, viewerId: client.id },
        "creator",
      );
      return;
    }

    if (client.role === "creator" && message.type === "mic-policy") {
      room.options.allowViewerMic = Boolean(message.allowed);
      this.broadcast(room, { type: "mic-policy", allowed: Boolean(message.allowed) }, "viewer");
      return;
    }

    if (client.role === "creator" && message.type === "creator-end") {
      this.broadcast(room, { type: "creator-end" }, "viewer");
      room.sharedTracks = [];
    }
  }

  private recordStats(room: Room, client: SocketClient, message: Record<string, unknown>) {
    const inbound = Number(message.inboundBytes);
    const outbound = Number(message.outboundBytes);
    if (!Number.isFinite(inbound) || !Number.isFinite(outbound)) return;
    if (inbound < 0 || outbound < 0) return;

    // Counters are cumulative per RTCPeerConnection; a lower reading means the
    // client rebuilt its connection, so the new value is itself the delta.
    const inboundDelta = inbound >= client.lastInboundBytes
      ? inbound - client.lastInboundBytes
      : inbound;
    const outboundDelta = outbound >= client.lastOutboundBytes
      ? outbound - client.lastOutboundBytes
      : outbound;
    client.lastInboundBytes = inbound;
    client.lastOutboundBytes = outbound;

    room.egressBytes += inboundDelta;
    room.ingressBytes += outboundDelta;
    this.ledger.record(inboundDelta, outboundDelta);
  }
}
