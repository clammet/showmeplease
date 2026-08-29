import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  parseSessionOptions,
  parseSharedTrack,
  type SessionOptions,
  type SharedTrack,
} from "../lib/options";
import { EgressLedger } from "./egress";
import { RateLimiter } from "./rateLimit";

export type Role = "creator" | "viewer";

export type ChatMessage = {
  type: "chat";
  id: string;
  senderId: string;
  senderRole: Role;
  text: string;
  timestamp: number;
};

/**
 * One token holder. A participant is created by `createRoom` (creator) or
 * `join` (viewer), is bound to the client id given at that time, and owns the
 * Cloudflare Realtime sessions it opened through the proxy.
 */
export type Participant = {
  token: string;
  clientId: string;
  role: Role;
  realtimeSessions: Set<string>;
  /** Last time this participant had an open socket. */
  lastSeen: number;
};

type SocketClient = {
  participant: Participant;
  socket: WebSocket;
  alive: boolean;
};

type ByteCounters = { inbound: number; outbound: number };

export type Room = {
  code: string;
  options: SessionOptions;
  createdAt: number;
  lastActivity: number;
  participants: Map<string, Participant>;
  clients: Map<WebSocket, SocketClient>;
  messages: ChatMessage[];
  sharedTracks: SharedTrack[];
  /** Last cumulative RTCPeerConnection counters per client id, kept across socket reconnects. */
  stats: Map<string, ByteCounters>;
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
export const MAX_ROOMS = 1000;
export const MAX_VIEWERS = 512;
export const MAX_MESSAGES = 100;
export const MAX_SHARED_TRACKS = 16;
export const MAX_CHAT_LENGTH = 2000;
const IDLE_ROOM_TTL_MS = 60 * 60_000;
/** A viewer token outlives its socket this long so a reconnect can reuse it. */
export const VIEWER_TOKEN_GRACE_MS = 5 * 60_000;
const MAX_ENDED_SESSIONS = 50;
const STATUS_RECENT_ACTIVITY_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
const CHAT_LIMIT = { max: 10, windowMs: 10_000 };

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
  private readonly chatLimiter = new RateLimiter(CHAT_LIMIT.max, CHAT_LIMIT.windowMs);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(options: { timers?: boolean } = {}) {
    if (options.timers !== false) {
      const sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      const heartbeat = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
      sweeper.unref();
      heartbeat.unref();
      this.timers.push(sweeper, heartbeat);
    }
  }

  close() {
    for (const timer of this.timers) clearInterval(timer);
  }

  createRoom(
    options: SessionOptions,
    clientId: string,
    now = Date.now(),
  ): { code: string; token: string } | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = createCode();
      if (this.rooms.has(code)) continue;
      const creator: Participant = {
        token: randomUUID(),
        clientId,
        role: "creator",
        realtimeSessions: new Set(),
        lastSeen: now,
      };
      this.rooms.set(code, {
        code,
        options,
        createdAt: now,
        lastActivity: now,
        participants: new Map([[creator.token, creator]]),
        clients: new Map(),
        messages: [],
        sharedTracks: [],
        stats: new Map(),
        egressBytes: 0,
        ingressBytes: 0,
      });
      this.sessionsCreated += 1;
      return { code, token: creator.token };
    }
    return null;
  }

  room(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /**
   * Mint a viewer token bound to `clientId`. Returns "full" when the room has
   * MAX_VIEWERS tokens that are all backed by live or recently live sockets;
   * tokens are never taken away from someone who is still connected.
   */
  join(
    code: string,
    clientId: string,
    now = Date.now(),
  ): { token: string; options: SessionOptions } | "full" | null {
    const room = this.room(code);
    if (!room || !this.creatorOnline(room)) return null;
    // A client that joins again (page reload before the old socket closed)
    // reuses its existing token instead of minting a second one.
    for (const participant of room.participants.values()) {
      if (participant.role === "viewer" && participant.clientId === clientId) {
        participant.lastSeen = now;
        return { token: participant.token, options: room.options };
      }
    }
    if (this.viewerTokenCount(room) >= MAX_VIEWERS) {
      this.pruneViewers(room, now);
      if (this.viewerTokenCount(room) >= MAX_VIEWERS) return "full";
    }
    const participant: Participant = {
      token: randomUUID(),
      clientId,
      role: "viewer",
      realtimeSessions: new Set(),
      lastSeen: now,
    };
    room.participants.set(participant.token, participant);
    room.lastActivity = now;
    return { token: participant.token, options: room.options };
  }

  authorize(code: string, token: string | undefined): Participant | null {
    const room = this.room(code);
    if (!room || !token) return null;
    return room.participants.get(token) ?? null;
  }

  /** Record a Cloudflare session opened through the proxy by this token. */
  registerRealtimeSession(code: string, token: string, sessionId: string): boolean {
    const participant = this.authorize(code, token);
    if (!participant) return false;
    participant.realtimeSessions.add(sessionId);
    return true;
  }

  ownsRealtimeSession(code: string, token: string, sessionId: string): boolean {
    return this.authorize(code, token)?.realtimeSessions.has(sessionId) ?? false;
  }

  /** True when any participant of the room opened this Cloudflare session. */
  roomHasRealtimeSession(code: string, sessionId: string): boolean {
    const room = this.room(code);
    if (!room) return false;
    for (const participant of room.participants.values()) {
      if (participant.realtimeSessions.has(sessionId)) return true;
    }
    return false;
  }

  creatorOnline(room: Room) {
    for (const client of room.clients.values()) {
      if (client.participant.role === "creator") return true;
    }
    return false;
  }

  viewerCount(room: Room) {
    let count = 0;
    for (const client of room.clients.values()) {
      if (client.participant.role === "viewer") count += 1;
    }
    return count;
  }

  private viewerTokenCount(room: Room) {
    let count = 0;
    for (const participant of room.participants.values()) {
      if (participant.role === "viewer") count += 1;
    }
    return count;
  }

  private liveTokens(room: Room): Set<string> {
    const live = new Set<string>();
    for (const client of room.clients.values()) live.add(client.participant.token);
    return live;
  }

  /** Drop viewer tokens with no socket for longer than the grace period. */
  private pruneViewers(room: Room, now: number) {
    const live = this.liveTokens(room);
    for (const [token, participant] of room.participants) {
      if (participant.role !== "viewer" || live.has(token)) continue;
      if (now - participant.lastSeen > VIEWER_TOKEN_GRACE_MS) room.participants.delete(token);
    }
  }

  wsClientCount() {
    let count = 0;
    for (const room of this.rooms.values()) count += room.clients.size;
    return count;
  }

  activeRooms(): Room[] {
    return Array.from(this.rooms.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Aggregate, non-sensitive counters for the unauthenticated /api/status
   * probe. `busy` is true while anyone is connected or a room saw activity
   * within `recentMs` (covers a presenter mid-reconnect between retries), so
   * a deployment can hold off restarting the container until sessions drain.
   */
  status(recentMs = STATUS_RECENT_ACTIVITY_MS) {
    const now = Date.now();
    let connectedClients = 0;
    let recentlyActive = 0;
    for (const room of this.rooms.values()) {
      connectedClients += room.clients.size;
      if (room.clients.size > 0 || now - room.lastActivity < recentMs) recentlyActive += 1;
    }
    return {
      sessions: this.rooms.size,
      activeSessions: recentlyActive,
      connectedClients,
      busy: recentlyActive > 0,
    };
  }

  endedSessions(): EndedSession[] {
    return [...this.ended];
  }

  /** Admin action: end a session, notify everyone, and drop the room. */
  terminate(code: string): boolean {
    const room = this.room(code);
    if (!room) return false;
    this.broadcast(room, { type: "creator-end", reason: "terminated" });
    for (const client of room.clients.values()) client.socket.close(4004, "session ended");
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

  sweep(now = Date.now()) {
    for (const room of Array.from(this.rooms.values())) {
      if (room.clients.size === 0 && now - room.lastActivity > IDLE_ROOM_TTL_MS) {
        this.retire(room);
        continue;
      }
      this.pruneViewers(room, now);
    }
    this.chatLimiter.sweep(now);
  }

  /** ws-level liveness: a socket that misses one heartbeat window is terminated. */
  heartbeat() {
    for (const room of this.rooms.values()) {
      for (const client of room.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }
  }

  private send(socket: WebSocket, value: unknown) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  }

  private broadcast(room: Room, value: unknown, role?: Role) {
    for (const client of room.clients.values()) {
      if (!role || client.participant.role === role) this.send(client.socket, value);
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
   * token does not exist, does not match the requested role, or was minted
   * for a different client id.
   */
  connect(
    code: string,
    role: string | null,
    token: string | null,
    clientId: string | null,
    socket: WebSocket,
  ): boolean {
    const room = this.room(code);
    const participant = room && token ? room.participants.get(token) : undefined;
    if (
      !room ||
      !participant ||
      !clientId ||
      participant.role !== role ||
      participant.clientId !== clientId
    ) {
      return false;
    }

    const client: SocketClient = { participant, socket, alive: true };
    room.clients.set(socket, client);
    room.lastActivity = Date.now();
    participant.lastSeen = Date.now();

    this.send(socket, {
      type: "welcome",
      options: room.options,
      messages: room.messages,
      tracks: room.sharedTracks,
      viewerCount: this.viewerCount(room),
      creatorOnline: this.creatorOnline(room),
    });
    if (participant.role === "viewer") {
      this.broadcast(
        room,
        { type: "viewer-waiting", viewerCount: this.viewerCount(room) },
        "creator",
      );
    }
    this.presence(room);

    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      client.alive = true;
      if (!isBinary) this.handleMessage(room, client, data.toString());
    });
    const disconnect = () => {
      if (!room.clients.delete(socket)) return;
      participant.lastSeen = Date.now();
      if (participant.role === "viewer") {
        this.broadcast(
          room,
          { type: "viewer-left", viewerId: participant.clientId },
          "creator",
        );
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
    if (typeof message !== "object" || message === null) return;
    room.lastActivity = Date.now();
    const { participant } = client;

    switch (message.type) {
      case "ping":
        this.send(client.socket, { type: "pong", at: Date.now() });
        return;
      case "stats":
        this.recordStats(room, participant.clientId, message);
        return;
      case "chat":
        this.handleChat(room, client, message);
        return;
      case "tracks-ready":
      case "tracks-added":
        if (participant.role === "creator") this.handleTracks(room, participant, message);
        return;
      case "viewer-audio":
        if (participant.role === "viewer") this.handleViewerAudio(room, participant, message);
        return;
      case "options":
        if (participant.role === "creator") this.handleOptions(room, message);
        return;
      case "creator-end":
        if (participant.role === "creator") {
          this.broadcast(room, { type: "creator-end", reason: "ended" }, "viewer");
          room.sharedTracks = [];
        }
        return;
      default:
        return;
    }
  }

  private handleChat(room: Room, client: SocketClient, message: Record<string, unknown>) {
    if (typeof message.text !== "string") return;
    const text = message.text.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;
    if (!this.chatLimiter.allow(`${room.code}:${client.participant.token}`)) {
      this.send(client.socket, { type: "error", code: "chat-rate-limit" });
      return;
    }
    const chat: ChatMessage = {
      type: "chat",
      id: randomUUID(),
      senderId: client.participant.clientId,
      senderRole: client.participant.role,
      text,
      timestamp: Date.now(),
    };
    room.messages.push(chat);
    if (room.messages.length > MAX_MESSAGES) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    }
    this.broadcast(room, chat);
  }

  /**
   * Accept only well-formed tracks on Cloudflare sessions this participant
   * opened. `tracks-ready` replaces the room's track list (a republish after
   * media recovery); `tracks-added` appends (a microphone added mid-session).
   */
  private handleTracks(room: Room, participant: Participant, message: Record<string, unknown>) {
    if (!Array.isArray(message.tracks)) return;
    const incoming: SharedTrack[] = [];
    for (const raw of message.tracks) {
      const track = parseSharedTrack(raw);
      if (!track || !participant.realtimeSessions.has(track.sessionId)) return;
      incoming.push({ ...track, ownerId: participant.clientId });
    }
    if (message.type === "tracks-ready") {
      room.sharedTracks = incoming.slice(0, MAX_SHARED_TRACKS);
    } else {
      for (const track of incoming) {
        if (room.sharedTracks.length >= MAX_SHARED_TRACKS) break;
        if (!room.sharedTracks.some((existing) => existing.trackName === track.trackName)) {
          room.sharedTracks.push(track);
        }
      }
    }
    this.broadcast(room, { type: message.type, tracks: incoming }, "viewer");
  }

  private handleViewerAudio(
    room: Room,
    participant: Participant,
    message: Record<string, unknown>,
  ) {
    if (!room.options.allowViewerMic) return;
    const track = parseSharedTrack(message.track);
    if (!track || track.kind !== "audio" || track.source !== "viewer-mic") return;
    if (!participant.realtimeSessions.has(track.sessionId)) return;
    this.broadcast(
      room,
      {
        type: "viewer-audio",
        track: { ...track, ownerId: participant.clientId },
        viewerId: participant.clientId,
      },
      "creator",
    );
  }

  private handleOptions(room: Room, message: Record<string, unknown>) {
    const options = parseSessionOptions(message.options);
    if (!options) return;
    room.options = options;
    this.broadcast(room, { type: "options", options });
  }

  private recordStats(room: Room, clientId: string, message: Record<string, unknown>) {
    const inbound = Number(message.inboundBytes);
    const outbound = Number(message.outboundBytes);
    if (!Number.isFinite(inbound) || !Number.isFinite(outbound)) return;
    if (inbound < 0 || outbound < 0) return;

    const last = room.stats.get(clientId) ?? { inbound: 0, outbound: 0 };
    // Counters are cumulative per RTCPeerConnection; a lower reading means the
    // client rebuilt its connection, so the new value is itself the delta.
    const inboundDelta = inbound >= last.inbound ? inbound - last.inbound : inbound;
    const outboundDelta = outbound >= last.outbound ? outbound - last.outbound : outbound;
    room.stats.set(clientId, { inbound, outbound });

    room.egressBytes += inboundDelta;
    room.ingressBytes += outboundDelta;
    this.ledger.record(inboundDelta, outboundDelta);
  }
}
