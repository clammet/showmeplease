import type { SessionOptions, SharedTrack } from "./options";
import { RealtimeConnection, RealtimeError } from "./realtime";

export type Role = "creator" | "viewer";

export type SessionStatus =
  | "waiting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "error";

export type ChatMessage = {
  type: "chat";
  id: string;
  senderId: string;
  senderRole: Role;
  text: string;
  timestamp: number;
};

type ServerEvent = {
  type: string;
  options?: SessionOptions;
  messages?: ChatMessage[];
  tracks?: SharedTrack[];
  track?: SharedTrack;
  viewerCount?: number;
  creatorOnline?: boolean;
  reason?: string;
  code?: string;
};

export type SessionEvent =
  | { type: "status"; status: SessionStatus }
  | { type: "options"; options: SessionOptions }
  | { type: "viewer-count"; viewerCount: number }
  | { type: "chat"; message: ChatMessage }
  | { type: "remote-stream"; stream: MediaStream | null }
  | { type: "creator-audio"; stream: MediaStream | null }
  | { type: "mic"; muted: boolean }
  | { type: "error"; message: string }
  | { type: "ended"; reason: "presenter" | "terminated" | "unauthorized" | "gave-up" };

export type SessionClientOptions = {
  role: Role;
  code: string;
  token: string;
  clientId: string;
  options: SessionOptions;
  /** Creator only: the screen capture to publish. */
  localStream?: MediaStream;
  onEvent: (event: SessionEvent) => void;
};

/** WebSocket close codes the hub uses for terminal conditions. */
const TERMINAL_CLOSE_CODES = new Set([4001, 4002, 4004]);
const MAX_SOCKET_ATTEMPTS = 20;
const MAX_MEDIA_ATTEMPTS = 8;
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 30_000;
const STATS_INTERVAL_MS = 10_000;

function backoff(attempt: number, baseMs: number, capMs: number) {
  return Math.min(capMs, baseMs * 2 ** attempt) + Math.random() * 300;
}

/**
 * Everything about one share that is not React: the hub socket, its
 * reconnect policy, the Cloudflare media connection, and microphone state.
 * The UI subscribes through `onEvent` and calls the public methods.
 */
export class SessionClient {
  readonly role: Role;
  readonly code: string;
  private readonly token: string;
  readonly clientId: string;
  private options: SessionOptions;
  private readonly localStream: MediaStream | null;
  private readonly emit: (event: SessionEvent) => void;

  private active = false;
  private socket: WebSocket | null = null;
  private socketAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  private connection: RealtimeConnection | null = null;
  private mediaAttempts = 0;
  private mediaRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private microphone: MediaStream | null = null;

  // Creator: what we have told the hub about.
  private publishedTracks: SharedTrack[] = [];
  private publishing = false;
  // Viewer: what the presenter offers, and what we have pulled so far.
  private offeredTracks: SharedTrack[] = [];
  private pulledTrackNames = new Set<string>();

  private readonly seenMessageIds = new Set<string>();

  constructor(options: SessionClientOptions) {
    this.role = options.role;
    this.code = options.code;
    this.token = options.token;
    this.clientId = options.clientId;
    this.options = options.options;
    this.localStream = options.localStream ?? null;
    this.emit = options.onEvent;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.openSocket();
    this.statsTimer = setInterval(() => void this.reportStats(), STATS_INTERVAL_MS);
    if (this.role === "creator") {
      this.localStream?.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (!this.active) return;
          this.stop(true);
          this.emit({ type: "ended", reason: "presenter" });
        },
        { once: true },
      );
    }
  }

  /** Tear everything down. `notify` tells the hub the presenter ended the share. */
  stop(notify: boolean) {
    if (notify && this.role === "creator") this.send({ type: "creator-end" });
    this.active = false;
    this.clearTimers();
    this.socket?.close(1000, "leaving");
    this.socket = null;
    this.connection?.close();
    this.connection = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.microphone = null;
    this.publishedTracks = [];
    this.offeredTracks = [];
    this.pulledTrackNames.clear();
    this.seenMessageIds.clear();
  }

  sendChat(text: string) {
    const value = text.trim();
    if (value) this.send({ type: "chat", text: value });
  }

  /** Creator: apply new settings locally and tell the hub (which fans them out). */
  updateOptions(options: SessionOptions) {
    this.options = options;
    if (this.role !== "creator") return;
    this.send({ type: "options", options });
    void this.connection?.updatePreferences(options).catch(() => undefined);
  }

  get microphoneMuted(): boolean {
    const track = this.microphone?.getAudioTracks()[0];
    return !track || !track.enabled;
  }

  /** Toggle the microphone, capturing and publishing it on first use. */
  async toggleMicrophone(): Promise<void> {
    if (this.role === "viewer" && !this.options.allowViewerMic) return;
    const existing = this.microphone?.getAudioTracks()[0];
    if (existing) {
      existing.enabled = !existing.enabled;
      this.emit({ type: "mic", muted: !existing.enabled });
      return;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.microphone = mic;
      this.emit({ type: "mic", muted: false });
      if (this.role === "creator") {
        // Not yet relaying (no viewer): the mic is picked up by the next publish.
        if (!this.connection) return;
        const [published] = await this.connection.publishTracks([
          { track: mic.getAudioTracks()[0], source: "presenter-mic" },
        ]);
        this.publishedTracks.push(published);
        this.send({ type: "tracks-added", tracks: [published] });
        return;
      }
      const connection = this.ensureConnection();
      const [published] = await connection.publishTracks([
        { track: mic.getAudioTracks()[0], source: "viewer-mic" },
      ]);
      this.send({ type: "viewer-audio", track: published });
    } catch (error) {
      this.microphone?.getTracks().forEach((track) => track.stop());
      this.microphone = null;
      this.emit({ type: "mic", muted: true });
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : "Microphone access failed",
      });
    }
  }

  // ---- socket ----------------------------------------------------------

  private send(value: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }

  private openSocket() {
    if (!this.active) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/sessions/${this.code}/ws`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          role: this.role,
          token: this.token,
          clientId: this.clientId,
        }),
      );
      this.socketAttempts = 0;
      this.startPing();
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", (event) => {
      this.stopPing();
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.active) return;
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        this.finish(event.code === 4004 ? "terminated" : "unauthorized");
        return;
      }
      if (this.socketAttempts >= MAX_SOCKET_ATTEMPTS) {
        this.finish("gave-up");
        return;
      }
      this.emit({ type: "status", status: "reconnecting" });
      const delay = backoff(this.socketAttempts++, 500, 10_000);
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    });
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        // Half-open socket: force a close so the reconnect path runs.
        this.pongTimer = null;
        this.socket?.close(4000, "pong timeout");
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private finish(reason: "presenter" | "terminated" | "unauthorized" | "gave-up") {
    this.active = false;
    this.clearTimers();
    this.connection?.close();
    this.connection = null;
    this.emit({ type: "remote-stream", stream: null });
    this.emit({ type: "status", status: reason === "presenter" ? "ended" : "error" });
    this.emit({ type: "ended", reason });
  }

  private clearTimers() {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.mediaRetryTimer) clearTimeout(this.mediaRetryTimer);
    this.reconnectTimer = null;
    this.statsTimer = null;
    this.mediaRetryTimer = null;
  }

  private async reportStats() {
    const totals = await this.connection?.byteTotals().catch(() => null);
    if (totals) this.send({ type: "stats", ...totals });
  }

  private handleMessage(event: MessageEvent) {
    let message: ServerEvent;
    try {
      message = JSON.parse(event.data) as ServerEvent;
    } catch {
      return;
    }

    switch (message.type) {
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;

      case "welcome":
        if (message.options) this.applyOptions(message.options);
        if (message.messages) message.messages.forEach((chat) => this.deliverChat(chat));
        if (typeof message.viewerCount === "number") {
          this.emit({ type: "viewer-count", viewerCount: message.viewerCount });
        }
        this.emit({
          type: "status",
          status: this.connection ? "live" : "waiting",
        });
        if (this.role === "viewer") {
          this.replaceOffer(message.tracks ?? []);
        } else if ((message.viewerCount ?? 0) > 0) {
          if (this.publishedTracks.length) {
            this.send({ type: "tracks-ready", tracks: this.publishedTracks });
          } else {
            void this.ensurePublished();
          }
        }
        return;

      case "presence":
        if (typeof message.viewerCount === "number") {
          this.emit({ type: "viewer-count", viewerCount: message.viewerCount });
        }
        return;

      case "viewer-waiting":
        if (this.role !== "creator") return;
        if (typeof message.viewerCount === "number") {
          this.emit({ type: "viewer-count", viewerCount: message.viewerCount });
        }
        void this.ensurePublished();
        return;

      case "tracks-ready":
        if (this.role === "viewer") this.replaceOffer(message.tracks ?? []);
        return;

      case "tracks-added":
        if (this.role === "viewer") void this.pullOffered(message.tracks ?? []);
        return;

      case "viewer-audio":
        if (this.role === "creator" && message.track && this.connection) {
          void this.connection.pullTracks([message.track]).catch((error: unknown) => {
            console.warn("Could not receive viewer audio:", error);
          });
        }
        return;

      case "options":
        if (message.options) this.applyOptions(message.options);
        return;

      case "creator-end":
        this.finish(message.reason === "terminated" ? "terminated" : "presenter");
        return;

      case "chat":
        this.deliverChat(message as unknown as ChatMessage);
        return;

      case "error":
        if (message.code === "chat-rate-limit") {
          this.emit({ type: "error", message: "Slow down; a few messages every ten seconds." });
        }
        return;

      default:
        return;
    }
  }

  private applyOptions(options: SessionOptions) {
    this.options = options;
    this.emit({ type: "options", options });
    if (!options.allowViewerMic && this.role === "viewer") {
      this.microphone?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      this.emit({ type: "mic", muted: true });
    }
  }

  private deliverChat(chat: ChatMessage) {
    if (!chat?.id || this.seenMessageIds.has(chat.id)) return;
    this.seenMessageIds.add(chat.id);
    this.emit({ type: "chat", message: chat });
  }

  // ---- media: creator --------------------------------------------------

  private ensureConnection(): RealtimeConnection {
    if (this.connection) return this.connection;
    this.connection = new RealtimeConnection({
      code: this.code,
      token: this.token,
      preferences: this.options,
      onRemoteStream: (stream) =>
        this.emit(
          this.role === "creator"
            ? { type: "creator-audio", stream }
            : { type: "remote-stream", stream },
        ),
      onConnectionState: (state) => this.handleConnectionState(state),
    });
    return this.connection;
  }

  private handleConnectionState(state: RTCPeerConnectionState) {
    if (state === "connected") {
      this.mediaAttempts = 0;
      if (this.mediaRetryTimer) clearTimeout(this.mediaRetryTimer);
      this.mediaRetryTimer = null;
      this.emit({ type: "status", status: "live" });
      return;
    }
    if (state === "failed") {
      this.scheduleMediaRetry(0);
      return;
    }
    if (state === "disconnected") {
      this.emit({ type: "status", status: "reconnecting" });
      // Give ICE a few seconds to recover on its own before rebuilding.
      this.scheduleMediaRetry(4000);
    }
  }

  /** Rebuild the media connection with exponential backoff and a cap. */
  private scheduleMediaRetry(minimumDelayMs: number) {
    if (!this.active || this.mediaRetryTimer) return;
    if (this.mediaAttempts >= MAX_MEDIA_ATTEMPTS) {
      this.emit({ type: "error", message: "The media connection keeps failing." });
      this.emit({ type: "status", status: "error" });
      return;
    }
    this.emit({ type: "status", status: "reconnecting" });
    const delay = Math.max(minimumDelayMs, backoff(this.mediaAttempts++, 1000, 15_000));
    this.mediaRetryTimer = setTimeout(() => {
      this.mediaRetryTimer = null;
      if (!this.active) return;
      this.connection?.close();
      this.connection = null;
      if (this.role === "creator") {
        this.publishedTracks = [];
        void this.ensurePublished();
      } else {
        this.pulledTrackNames.clear();
        this.emit({ type: "remote-stream", stream: null });
        void this.pullOffered(this.offeredTracks);
      }
    }, delay);
  }

  private async ensurePublished() {
    if (this.role !== "creator" || this.publishing || this.publishedTracks.length) return;
    if (!this.localStream || !this.active) return;
    this.publishing = true;
    this.emit({ type: "status", status: "connecting" });
    try {
      const connection = this.ensureConnection();
      const sources: Array<{ track: MediaStreamTrack; source: SharedTrack["source"] }> =
        this.localStream.getTracks().map((track) => ({ track, source: "screen" }));
      const micTrack = this.microphone?.getAudioTracks()[0];
      if (micTrack) sources.push({ track: micTrack, source: "presenter-mic" });
      const tracks = await connection.publishTracks(sources);
      this.publishedTracks = tracks;
      this.send({ type: "tracks-ready", tracks });
      this.emit({ type: "status", status: "live" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the relay";
      this.emit({ type: "error", message });
      if (error instanceof RealtimeError && error.status === 503) {
        this.emit({ type: "status", status: "error" });
      } else {
        this.connection?.close();
        this.connection = null;
        this.scheduleMediaRetry(0);
      }
    } finally {
      this.publishing = false;
    }
  }

  // ---- media: viewer ---------------------------------------------------

  /** The presenter (re)published: drop what we had and pull the new set. */
  private replaceOffer(tracks: SharedTrack[]) {
    this.offeredTracks = tracks;
    const stale = [...this.pulledTrackNames].some(
      (name) => !tracks.some((track) => track.trackName === name),
    );
    if (stale) {
      this.connection?.close();
      this.connection = null;
      this.pulledTrackNames.clear();
      this.emit({ type: "remote-stream", stream: null });
    }
    void this.pullOffered(tracks);
  }

  private async pullOffered(tracks: SharedTrack[]) {
    if (this.role !== "viewer" || !this.active) return;
    for (const track of tracks) {
      if (!this.offeredTracks.some((item) => item.trackName === track.trackName)) {
        this.offeredTracks.push(track);
      }
    }
    const fresh = tracks.filter((track) => !this.pulledTrackNames.has(track.trackName));
    if (!fresh.length) return;
    this.emit({ type: "status", status: "connecting" });
    try {
      const connection = this.ensureConnection();
      await connection.pullTracks(fresh);
      fresh.forEach((track) => this.pulledTrackNames.add(track.trackName));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not receive the share";
      this.emit({ type: "error", message });
      if (error instanceof RealtimeError && (error.status === 503 || error.status === 403)) {
        this.emit({ type: "status", status: "error" });
        return;
      }
      if (error instanceof RealtimeError && error.status === 410) {
        // The presenter's tracks are gone; wait for a new tracks-ready.
        this.offeredTracks = this.offeredTracks.filter(
          (track) => !fresh.some((item) => item.trackName === track.trackName),
        );
        this.emit({ type: "status", status: "waiting" });
        return;
      }
      this.connection?.close();
      this.connection = null;
      this.pulledTrackNames.clear();
      this.scheduleMediaRetry(0);
    }
  }
}
