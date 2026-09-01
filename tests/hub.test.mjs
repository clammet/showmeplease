// Unit tests for the hub, ledger, and billing period. Run with
// `node --import tsx --test`; no build or network needed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EgressLedger, utcBillingPeriod } from "../server/egress.ts";
import {
  MAX_SHARED_TRACKS,
  MAX_VIEWERS,
  SessionHub,
  VIEWER_TOKEN_GRACE_MS,
} from "../server/hub.ts";
import { RateLimiter } from "../server/rateLimit.ts";
import { parseSessionOptions } from "../lib/options.ts";
import { parseDrawingInstruction } from "../lib/annotations.ts";

const OPTIONS = {
  codec: "auto",
  maxBitrateKbps: 6000,
  frameRate: 30,
  includeSystemAudio: true,
  allowViewerMic: false,
  allowViewerAnnotations: false,
};

/** Minimal stand-in for a ws socket: records sent frames, can emit events. */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.pings = 0;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close(1006, "terminated");
  }
  ping() {
    this.pings += 1;
  }
  receive(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
  last(type) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

function hubWithRoom() {
  const hub = new SessionHub({ timers: false });
  const created = hub.createRoom(OPTIONS, "creator-1");
  const creator = new FakeSocket();
  assert.ok(hub.connect(created.code, "creator", created.token, "creator-1", creator));
  return { hub, code: created.code, creatorToken: created.token, creator };
}

function joinViewer(hub, code, clientId) {
  const joined = hub.join(code, clientId);
  assert.notEqual(joined, null);
  assert.notEqual(joined, "full");
  const socket = new FakeSocket();
  assert.ok(hub.connect(code, "viewer", joined.token, clientId, socket));
  return { token: joined.token, socket };
}

test("parseSessionOptions rejects out-of-range and unknown values", () => {
  assert.deepEqual(parseSessionOptions(OPTIONS), OPTIONS);
  assert.equal(parseSessionOptions({ ...OPTIONS, codec: "<x>" }), null);
  assert.equal(parseSessionOptions({ ...OPTIONS, frameRate: 999 }), null);
  assert.equal(parseSessionOptions({ ...OPTIONS, maxBitrateKbps: Infinity }), null);
  assert.equal(parseSessionOptions({ ...OPTIONS, maxBitrateKbps: 100 }), null);
  assert.equal(parseSessionOptions({ ...OPTIONS, allowViewerMic: "yes" }), null);
  assert.equal(parseSessionOptions({ ...OPTIONS, allowViewerAnnotations: "yes" }), null);
  assert.equal(parseSessionOptions(null), null);
});

test("drawing instructions only accept bounded normalized vector data", () => {
  assert.deepEqual(
    parseDrawingInstruction({
      kind: "stroke-start",
      strokeId: "stroke_1",
      color: "#ff4d4f",
      point: { x: 0.25, y: 1 },
    }),
    {
      kind: "stroke-start",
      strokeId: "stroke_1",
      color: "#ff4d4f",
      point: { x: 0.25, y: 1 },
    },
  );
  assert.equal(
    parseDrawingInstruction({
      kind: "stroke-start",
      strokeId: "stroke_1",
      color: "red",
      point: { x: 0.25, y: 0.5 },
    }),
    null,
  );
  assert.equal(
    parseDrawingInstruction({
      kind: "laser-move",
      color: "#ff4d4f",
      point: { x: -0.1, y: 0.5 },
    }),
    null,
  );
});

test("tokens are bound to the client id and role they were minted for", () => {
  const { hub, code, creatorToken } = hubWithRoom();
  const joined = hub.join(code, "viewer-1");
  const wrongClient = new FakeSocket();
  assert.equal(hub.connect(code, "viewer", joined.token, "someone-else", wrongClient), false);
  const wrongRole = new FakeSocket();
  assert.equal(hub.connect(code, "creator", joined.token, "viewer-1", wrongRole), false);
  const creatorAsViewer = new FakeSocket();
  assert.equal(hub.connect(code, "viewer", creatorToken, "creator-1", creatorAsViewer), false);
});

test("join is refused until the creator is online and reuses a client's token", () => {
  const hub = new SessionHub({ timers: false });
  const { code, token } = hub.createRoom(OPTIONS, "creator-1");
  assert.equal(hub.join(code, "viewer-1"), null);
  hub.connect(code, "creator", token, "creator-1", new FakeSocket());
  const first = hub.join(code, "viewer-1");
  const again = hub.join(code, "viewer-1");
  assert.equal(first.token, again.token);
});

test("joining at capacity does not evict connected viewers", () => {
  const { hub, code } = hubWithRoom();
  const live = joinViewer(hub, code, "viewer-live");
  for (let i = 0; i < MAX_VIEWERS + 10; i += 1) {
    const result = hub.join(code, `attacker-${i}`);
    if (result === "full") break;
  }
  assert.equal(hub.join(code, "one-more"), "full");
  const reconnect = new FakeSocket();
  assert.ok(hub.connect(code, "viewer", live.token, "viewer-live", reconnect));
});

test("viewer tokens without a socket expire after the grace period", () => {
  const { hub, code } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  viewer.socket.close(1000, "bye");
  hub.sweep(Date.now() + 1000);
  assert.ok(hub.authorize(code, viewer.token), "still valid inside the grace period");
  hub.sweep(Date.now() + VIEWER_TOKEN_GRACE_MS + 1000);
  assert.equal(hub.authorize(code, viewer.token), null);
});

test("egress stats are not double counted across a socket reconnect", () => {
  const { hub, code } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  viewer.socket.receive({ type: "stats", inboundBytes: 1000, outboundBytes: 0 });
  viewer.socket.close(1000, "drop");
  const again = new FakeSocket();
  hub.connect(code, "viewer", viewer.token, "viewer-1", again);
  again.receive({ type: "stats", inboundBytes: 1000, outboundBytes: 0 });
  again.receive({ type: "stats", inboundBytes: 1500, outboundBytes: 0 });
  assert.equal(hub.room(code).egressBytes, 1500);
  // A rebuilt peer connection restarts its counters; the reading is the delta.
  again.receive({ type: "stats", inboundBytes: 200, outboundBytes: 0 });
  assert.equal(hub.room(code).egressBytes, 1700);
});

test("shared tracks must sit on a Cloudflare session the creator opened", () => {
  const { hub, code, creatorToken, creator } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  const track = { sessionId: "cf-session-a", trackName: "screen-1", kind: "video", source: "screen" };
  creator.receive({ type: "tracks-ready", tracks: [track] });
  assert.equal(hub.room(code).sharedTracks.length, 0, "unregistered session is ignored");
  assert.equal(viewer.socket.last("tracks-ready"), undefined);

  hub.registerRealtimeSession(code, creatorToken, "cf-session-a");
  creator.receive({ type: "tracks-ready", tracks: [track] });
  assert.equal(hub.room(code).sharedTracks.length, 1);
  assert.equal(hub.room(code).sharedTracks[0].ownerId, "creator-1");
  assert.deepEqual(viewer.socket.last("tracks-ready").tracks[0].trackName, "screen-1");

  // tracks-ready replaces (a republish), tracks-added appends and is capped.
  creator.receive({ type: "tracks-ready", tracks: [{ ...track, trackName: "screen-2" }] });
  assert.deepEqual(hub.room(code).sharedTracks.map((t) => t.trackName), ["screen-2"]);
  for (let i = 0; i < MAX_SHARED_TRACKS + 5; i += 1) {
    creator.receive({ type: "tracks-added", tracks: [{ ...track, trackName: `mic-${i}` }] });
  }
  assert.equal(hub.room(code).sharedTracks.length, MAX_SHARED_TRACKS);
  // Malformed entries are rejected as a whole.
  creator.receive({ type: "tracks-ready", tracks: [{ ...track, trackName: "bad name!" }] });
  assert.equal(hub.room(code).sharedTracks.length, MAX_SHARED_TRACKS);
});

test("viewer audio is dropped unless the presenter allows microphones", () => {
  const { hub, code, creator } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  hub.registerRealtimeSession(code, viewer.token, "cf-viewer");
  const track = { sessionId: "cf-viewer", trackName: "viewer-mic-1", kind: "audio", source: "viewer-mic" };
  viewer.socket.receive({ type: "viewer-audio", track });
  assert.equal(creator.last("viewer-audio"), undefined);

  creator.receive({ type: "options", options: { ...OPTIONS, allowViewerMic: true } });
  assert.equal(viewer.socket.last("options").options.allowViewerMic, true);
  viewer.socket.receive({ type: "viewer-audio", track: { ...track, sessionId: "not-mine" } });
  assert.equal(creator.last("viewer-audio"), undefined, "session must belong to the sender");
  viewer.socket.receive({ type: "viewer-audio", track });
  assert.equal(creator.last("viewer-audio").track.trackName, "viewer-mic-1");
  assert.equal(creator.last("viewer-audio").viewerId, "viewer-1");
});

test("options updates are validated and stored on the room", () => {
  const { hub, code, creator } = hubWithRoom();
  creator.receive({ type: "options", options: { ...OPTIONS, maxBitrateKbps: 999999 } });
  assert.equal(hub.room(code).options.maxBitrateKbps, 6000);
  creator.receive({ type: "options", options: { ...OPTIONS, maxBitrateKbps: 2500 } });
  assert.equal(hub.room(code).options.maxBitrateKbps, 2500);
});

test("annotations are host-gated, synchronized as vectors, snapshotted, and clearable", () => {
  const { hub, code, creator } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  const start = {
    kind: "stroke-start",
    strokeId: "stroke-a",
    color: "#ff4d4f",
    point: { x: 0.1, y: 0.2 },
  };

  viewer.socket.receive({ type: "annotation", instruction: start });
  assert.equal(hub.room(code).drawings.size, 0);
  assert.equal(viewer.socket.last("error").code, "annotation-not-allowed");

  creator.receive({ type: "annotation", instruction: start });
  assert.equal(hub.room(code).drawings.size, 1, "presenter always has annotation access");
  assert.deepEqual(viewer.socket.last("annotation").instruction, start);

  creator.receive({
    type: "options",
    options: { ...OPTIONS, allowViewerAnnotations: true },
  });
  viewer.socket.receive({
    type: "annotation",
    instruction: {
      kind: "stroke-start",
      strokeId: "stroke-b",
      color: "#3b82f6",
      point: { x: 0.3, y: 0.4 },
    },
  });
  viewer.socket.receive({
    type: "annotation",
    instruction: {
      kind: "stroke-add",
      strokeId: "stroke-b",
      points: [{ x: 0.5, y: 0.6 }],
    },
  });
  viewer.socket.receive({
    type: "annotation",
    instruction: { kind: "stroke-end", strokeId: "stroke-b" },
  });
  assert.deepEqual(hub.room(code).drawings.get("stroke-b").points, [
    { x: 0.3, y: 0.4 },
    { x: 0.5, y: 0.6 },
  ]);

  viewer.socket.receive({
    type: "annotation",
    instruction: { kind: "laser-move", color: "#34c759", point: { x: 0.8, y: 0.1 } },
  });
  assert.equal(creator.last("annotation").instruction.kind, "laser-move");
  assert.equal(hub.room(code).drawings.size, 2, "laser trails are transient");

  const lateViewer = joinViewer(hub, code, "viewer-2");
  assert.equal(lateViewer.socket.last("welcome").drawings.length, 2);
  assert.equal(lateViewer.socket.last("welcome").drawings[1].complete, true);

  viewer.socket.receive({ type: "annotation", instruction: { kind: "clear" } });
  assert.equal(hub.room(code).drawings.size, 0);
  assert.equal(creator.last("annotation").instruction.kind, "clear");
  assert.equal(lateViewer.socket.last("annotation").instruction.kind, "clear");
});

test("chat is rate limited per participant", () => {
  const { hub, code, creator } = hubWithRoom();
  const viewer = joinViewer(hub, code, "viewer-1");
  for (let i = 0; i < 12; i += 1) viewer.socket.receive({ type: "chat", text: `m${i}` });
  assert.equal(hub.room(code).messages.length, 10);
  assert.equal(viewer.socket.last("error").code, "chat-rate-limit");
  assert.equal(creator.sent.filter((m) => m.type === "chat").length, 10);
});

test("heartbeat terminates sockets that stop answering pings", () => {
  const { hub, code, creator } = hubWithRoom();
  hub.heartbeat();
  assert.equal(creator.pings, 1);
  creator.emit("pong");
  hub.heartbeat();
  assert.equal(creator.closed, null);
  hub.heartbeat();
  assert.equal(creator.closed.code, 1006);
  assert.equal(hub.creatorOnline(hub.room(code)), false);
});

test("terminate closes sockets with a terminal code and retires the room", () => {
  const { hub, code, creator } = hubWithRoom();
  assert.ok(hub.terminate(code));
  assert.equal(creator.closed.code, 4004);
  assert.equal(creator.last("creator-end").reason, "terminated");
  assert.equal(hub.room(code), undefined);
  assert.equal(hub.endedSessions()[0].code, code);
});

test("realtime session ownership is per token, visibility per room", () => {
  const { hub, code, creatorToken } = hubWithRoom();
  const other = hub.createRoom(OPTIONS, "creator-2");
  hub.registerRealtimeSession(code, creatorToken, "cf-a");
  assert.ok(hub.ownsRealtimeSession(code, creatorToken, "cf-a"));
  assert.ok(hub.roomHasRealtimeSession(code, "cf-a"));
  assert.equal(hub.ownsRealtimeSession(other.code, other.token, "cf-a"), false);
  assert.equal(hub.roomHasRealtimeSession(other.code, "cf-a"), false);
});

test("ledger windows and billing periods", () => {
  const ledger = new EgressLedger();
  const now = Date.UTC(2026, 7, 28, 12, 0, 30);
  ledger.record(100, 0, now - 25 * 60 * 60_000);
  ledger.record(200, 0, now - 60_000);
  ledger.record(300, 0, now);
  assert.equal(ledger.bytesInLast(24 * 60, now), 500);
  assert.equal(ledger.bytesInLast(1, now), 300);
  assert.equal(ledger.series(2, 1, now).map((b) => b.egressBytes).join(","), "200,300");

  const jan31 = Date.UTC(2026, 0, 31, 12);
  assert.deepEqual(utcBillingPeriod(31, jan31), {
    start: Date.UTC(2026, 0, 31),
    end: Date.UTC(2026, 1, 28),
  });
  const mar1 = Date.UTC(2026, 2, 1, 12);
  assert.deepEqual(utcBillingPeriod(31, mar1), {
    start: Date.UTC(2026, 1, 28),
    end: Date.UTC(2026, 2, 31),
  });
  assert.deepEqual(utcBillingPeriod(15, Date.UTC(2026, 0, 3)), {
    start: Date.UTC(2025, 11, 15),
    end: Date.UTC(2026, 0, 15),
  });
});

test("rate limiter counts per key per window", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.ok(limiter.allow("a", 0));
  assert.ok(limiter.allow("a", 10));
  assert.equal(limiter.allow("a", 20), false);
  assert.ok(limiter.allow("b", 20));
  assert.ok(limiter.allow("a", 1001));
});
