"use client";

/* eslint-disable jsx-a11y/media-has-caption, react-hooks/refs, react-hooks/set-state-in-effect */

import {
  Check,
  ChevronRight,
  CircleAlert,
  GripVertical,
  Link2,
  LoaderCircle,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Settings,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  RealtimeConnection,
  SessionOptions,
  SharedTrack,
} from "@/lib/realtime";

type Role = "creator" | "viewer";
type AppMode = "landing" | "session";
type SessionStatus =
  | "waiting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "error";

type ChatMessage = {
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
  allowed?: boolean;
};

const STORAGE_KEY = "showmeplease.session-options.v1";

const DEFAULT_OPTIONS: SessionOptions = {
  codec: "auto",
  maxBitrateKbps: 6000,
  frameRate: 30,
  includeSystemAudio: true,
  allowViewerMic: false,
};

function parseOptions(value: string | null): SessionOptions {
  if (!value) return DEFAULT_OPTIONS;
  try {
    const parsed = JSON.parse(value) as Partial<SessionOptions>;
    return {
      ...DEFAULT_OPTIONS,
      ...parsed,
      maxBitrateKbps: Math.min(
        20000,
        Math.max(500, Number(parsed.maxBitrateKbps) || 6000),
      ),
    };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function normaliseCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function SettingsDialog({
  open,
  options,
  sessionActive,
  onClose,
  onSave,
}: {
  open: boolean;
  options: SessionOptions;
  sessionActive: boolean;
  onClose: () => void;
  onSave: (options: SessionOptions) => void;
}) {
  const [draft, setDraft] = useState(options);

  useEffect(() => {
    if (open) setDraft(options);
  }, [open, options]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Share preferences</p>
            <h2 id="settings-title">Session settings</h2>
          </div>
          <button className="icon-button quiet" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        <div className="settings-stack">
          <label className="field-label">
            <span>Preferred video codec</span>
            <select
              value={draft.codec}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  codec: event.target.value as SessionOptions["codec"],
                })
              }
            >
              <option value="auto">Automatic</option>
              <option value="AV1">AV1</option>
              <option value="VP9">VP9</option>
              <option value="VP8">VP8</option>
              <option value="H264">H.264</option>
            </select>
          </label>

          <label className="field-label">
            <span>
              Max video bitrate
              <strong>{draft.maxBitrateKbps.toLocaleString()} kbps</strong>
            </span>
            <input
              type="range"
              min="500"
              max="20000"
              step="500"
              value={draft.maxBitrateKbps}
              onChange={(event) =>
                setDraft({ ...draft, maxBitrateKbps: Number(event.target.value) })
              }
            />
          </label>

          <label className="field-label">
            <span>Frame rate</span>
            <select
              value={draft.frameRate}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  frameRate: Number(event.target.value) as 15 | 30 | 60,
                })
              }
            >
              <option value="15">15 fps</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </label>

          <label className="toggle-row">
            <span>
              <strong>Include system audio</strong>
              <small>Offer tab or computer audio in the browser share picker.</small>
            </span>
            <input
              type="checkbox"
              aria-label="Include system audio"
              checked={draft.includeSystemAudio}
              onChange={(event) =>
                setDraft({ ...draft, includeSystemAudio: event.target.checked })
              }
            />
          </label>

          <label className="toggle-row">
            <span>
              <strong>Allow viewer microphone</strong>
              <small>Viewers may speak back through their own SFU audio track.</small>
            </span>
            <input
              type="checkbox"
              aria-label="Allow viewer microphone"
              checked={draft.allowViewerMic}
              onChange={(event) =>
                setDraft({ ...draft, allowViewerMic: event.target.checked })
              }
            />
          </label>
        </div>

        {sessionActive && (
          <p className="dialog-note">
            Bitrate and viewer mic access update now. Codec and capture options become the defaults
            for the next media connection.
          </p>
        )}

        <div className="dialog-actions">
          <button className="button secondary" onClick={onClose}>Cancel</button>
          <button
            className="button primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatPane({
  open,
  messages,
  clientId,
  onClose,
  onSend,
}: {
  open: boolean;
  messages: ChatMessage[];
  clientId: string;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  return (
    <aside className={`chat-pane ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="chat-header">
        <div>
          <p className="eyebrow">In this session</p>
          <h2>Chat</h2>
        </div>
        <button className="icon-button quiet" onClick={onClose} aria-label="Hide chat">
          <X size={18} />
        </button>
      </div>
      <div className="chat-feed" aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <MessageCircle size={22} />
            <p>No messages yet.</p>
          </div>
        )}
        {messages.map((message) => (
          <div
            className={`chat-message ${message.senderId === clientId ? "mine" : ""}`}
            key={message.id}
          >
            <div className="message-meta">
              <span>
                {message.senderId === clientId
                  ? "You"
                  : message.senderRole === "creator"
                    ? "Presenter"
                    : "Viewer"}
              </span>
              <time dateTime={new Date(message.timestamp).toISOString()}>
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <p>{message.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <input
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message everyone"
          aria-label="Chat message"
          tabIndex={open ? 0 : -1}
        />
        <button className="send-button" aria-label="Send message" disabled={!text.trim()}>
          <ChevronRight size={18} />
        </button>
      </form>
    </aside>
  );
}

export default function ShareApp() {
  const [mode, setMode] = useState<AppMode>("landing");
  const [role, setRole] = useState<Role>("creator");
  const [status, setStatus] = useState<SessionStatus>("waiting");
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [creatorAudio, setCreatorAudio] = useState<MediaStream | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [micMuted, setMicMuted] = useState(true);
  const [viewerMicAllowed, setViewerMicAllowed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dockPosition, setDockPosition] = useState({ x: 20, y: 20 });
  const [clientId, setClientId] = useState("");

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const creatorAudioRef = useRef<HTMLAudioElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const activeRef = useRef(false);
  const roleRef = useRef<Role>("creator");
  const codeRef = useRef("");
  const tokenRef = useRef("");
  const optionsRef = useRef(options);
  const localStreamRef = useRef<MediaStream | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const publishedRef = useRef(false);
  const publishedTracksRef = useRef<SharedTrack[]>([]);
  const publishingRef = useRef(false);
  const pulledTracksRef = useRef(new Set<string>());
  const viewerTracksRef = useRef<SharedTrack[]>([]);
  const seenMessageIdsRef = useRef(new Set<string>());
  const chatOpenRef = useRef(false);
  const handleSocketMessageRef = useRef<(event: MessageEvent) => void>(() => undefined);
  const ensurePublishedRef = useRef<() => Promise<void>>(async () => undefined);
  const pullViewerTracksRef = useRef<(tracks: SharedTrack[]) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    setClientId(crypto.randomUUID());
    const stored = parseOptions(localStorage.getItem(STORAGE_KEY));
    setOptions(stored);
    optionsRef.current = stored;
    const queryCode = normaliseCode(new URLSearchParams(window.location.search).get("join") || "");
    if (queryCode) setJoinCode(queryCode);
  }, []);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    localStreamRef.current = localStream;
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (creatorAudioRef.current) creatorAudioRef.current.srcObject = creatorAudio;
  }, [creatorAudio]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) setUnread(0);
  }, [chatOpen]);

  useEffect(() => {
    if (mode !== "session") return;
    setDockPosition({ x: 20, y: Math.max(20, window.innerHeight - 82) });
  }, [mode]);

  const sendSocket = (value: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(value));
    }
  };

  const openSocket = (nextRole: Role, code: string, token: string) => {
    if (!clientId || !activeRef.current) return;
    socketRef.current?.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/api/sessions/${code}/ws`);
    url.searchParams.set("role", nextRole);
    url.searchParams.set("token", token);
    url.searchParams.set("clientId", clientId);
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      reconnectAttemptRef.current = 0;
      setStatus((current) =>
        current === "reconnecting" ? (connectionRef.current ? "live" : "waiting") : current,
      );
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => sendSocket({ type: "ping" }), 15000);
    });
    socket.addEventListener("message", (event) => handleSocketMessageRef.current(event));
    socket.addEventListener("close", () => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (!activeRef.current) return;
      setStatus("reconnecting");
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(10000, 500 * 2 ** attempt) + Math.random() * 300;
      reconnectTimerRef.current = setTimeout(
        () => openSocket(roleRef.current, codeRef.current, tokenRef.current),
        delay,
      );
    });
  };

  const mergeMessages = (incoming: ChatMessage[]) => {
    setMessages((current) => {
      const merged = [...current];
      for (const message of incoming) {
        if (seenMessageIdsRef.current.has(message.id)) continue;
        seenMessageIdsRef.current.add(message.id);
        merged.push(message);
      }
      return merged.sort((a, b) => a.timestamp - b.timestamp).slice(-100);
    });
  };

  const scheduleViewerMediaRetry = () => {
    if (!activeRef.current || roleRef.current !== "viewer") return;
    setStatus("reconnecting");
    window.setTimeout(() => {
      connectionRef.current?.close();
      connectionRef.current = null;
      pulledTracksRef.current.clear();
      void pullViewerTracksRef.current(viewerTracksRef.current);
    }, 1200);
  };

  const handleViewerConnectionState = (state: RTCPeerConnectionState) => {
    if (state === "connected") {
      if (mediaRetryTimerRef.current) clearTimeout(mediaRetryTimerRef.current);
      mediaRetryTimerRef.current = null;
      setStatus("live");
    }
    if (state === "failed") scheduleViewerMediaRetry();
    if (state === "disconnected") {
      setStatus("reconnecting");
      if (mediaRetryTimerRef.current) clearTimeout(mediaRetryTimerRef.current);
      mediaRetryTimerRef.current = setTimeout(scheduleViewerMediaRetry, 4000);
    }
  };

  ensurePublishedRef.current = async () => {
    if (publishedRef.current || publishingRef.current || !localStreamRef.current) return;
    publishingRef.current = true;
    setStatus("connecting");
    try {
      const connection = new RealtimeConnection({
        code: codeRef.current,
        token: tokenRef.current,
        preferences: optionsRef.current,
        onRemoteStream: (stream) => setCreatorAudio(new MediaStream(stream.getAudioTracks())),
        onConnectionState: (state) => {
          if (state === "connected") setStatus("live");
          if (state === "failed") setStatus("error");
        },
      });
      connectionRef.current = connection;
      const sources: Array<{
        track: MediaStreamTrack;
        source: SharedTrack["source"];
      }> = localStreamRef.current.getTracks().map((track) => ({
        track,
        source: "screen" as const,
      }));
      const micTrack = microphoneRef.current?.getAudioTracks()[0];
      if (micTrack) sources.push({ track: micTrack, source: "presenter-mic" as const });
      const tracks = (await connection.publishTracks(sources)).map((track) => ({
        ...track,
        ownerId: clientId,
      }));
      publishedRef.current = true;
      publishedTracksRef.current = tracks;
      sendSocket({ type: "tracks-ready", tracks });
      setStatus("live");
    } catch (publishError) {
      setStatus("error");
      setError(
        publishError instanceof Error ? publishError.message : "Could not start the relay",
      );
    } finally {
      publishingRef.current = false;
    }
  };

  pullViewerTracksRef.current = async (tracks: SharedTrack[]) => {
    const unique = tracks.filter((track) => !pulledTracksRef.current.has(track.trackName));
    for (const track of tracks) {
      if (!viewerTracksRef.current.some((item) => item.trackName === track.trackName)) {
        viewerTracksRef.current.push(track);
      }
    }
    if (!unique.length) return;
    setStatus("connecting");
    try {
      if (!connectionRef.current) {
        connectionRef.current = new RealtimeConnection({
          code: codeRef.current,
          token: tokenRef.current,
          preferences: optionsRef.current,
          onRemoteStream: (stream) => setRemoteStream(new MediaStream(stream.getTracks())),
          onConnectionState: handleViewerConnectionState,
        });
      }
      await connectionRef.current.pullTracks(unique);
      unique.forEach((track) => pulledTracksRef.current.add(track.trackName));
    } catch (pullError) {
      const message =
        pullError instanceof Error ? pullError.message : "Could not receive the share";
      setError(message);
      if (message.includes("REALTIME_APP_ID")) {
        setStatus("error");
      } else {
        scheduleViewerMediaRetry();
      }
    }
  };

  handleSocketMessageRef.current = (event) => {
    let message: ServerEvent;
    try {
      message = JSON.parse(event.data) as ServerEvent;
    } catch {
      return;
    }

    if (message.type === "welcome") {
      if (message.options) {
        setOptions(message.options);
        optionsRef.current = message.options;
        setViewerMicAllowed(message.options.allowViewerMic);
      }
      if (message.messages) mergeMessages(message.messages);
      if (typeof message.viewerCount === "number") setViewerCount(message.viewerCount);
      if (roleRef.current === "viewer" && message.tracks?.length) {
        void pullViewerTracksRef.current(message.tracks);
      }
      if (roleRef.current === "creator" && (message.viewerCount || 0) > 0) {
        if (publishedTracksRef.current.length) {
          sendSocket({ type: "tracks-ready", tracks: publishedTracksRef.current });
        } else {
          void ensurePublishedRef.current();
        }
      }
      return;
    }

    if (message.type === "presence") {
      if (typeof message.viewerCount === "number") setViewerCount(message.viewerCount);
      return;
    }

    if (message.type === "viewer-waiting" && roleRef.current === "creator") {
      if (typeof message.viewerCount === "number") setViewerCount(message.viewerCount);
      void ensurePublishedRef.current();
      return;
    }

    if (
      roleRef.current === "viewer" &&
      (message.type === "tracks-ready" || message.type === "tracks-added") &&
      message.tracks
    ) {
      void pullViewerTracksRef.current(message.tracks);
      return;
    }

    if (roleRef.current === "creator" && message.type === "viewer-audio" && message.track) {
      void connectionRef.current?.pullTracks([message.track]);
      return;
    }

    if (message.type === "mic-policy") {
      setViewerMicAllowed(Boolean(message.allowed));
      if (!message.allowed) {
        microphoneRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        setMicMuted(true);
      }
      return;
    }

    if (message.type === "creator-end") {
      setStatus("ended");
      connectionRef.current?.close();
      setRemoteStream(null);
      return;
    }

    if (message.type === "chat") {
      const chat = message as unknown as ChatMessage;
      if (!seenMessageIdsRef.current.has(chat.id)) {
        mergeMessages([chat]);
        if (!chatOpenRef.current && chat.senderId !== clientId) {
          setUnread((count) => count + 1);
        }
      }
    }
  };

  const stopSession = (notify = true) => {
    if (notify && roleRef.current === "creator") sendSocket({ type: "creator-end" });
    activeRef.current = false;
    socketRef.current?.close();
    connectionRef.current?.close();
    connectionRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    microphoneRef.current = null;
    publishedRef.current = false;
    publishedTracksRef.current = [];
    publishingRef.current = false;
    pulledTracksRef.current.clear();
    viewerTracksRef.current = [];
    seenMessageIdsRef.current.clear();
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (mediaRetryTimerRef.current) clearTimeout(mediaRetryTimerRef.current);
    setLocalStream(null);
    setRemoteStream(null);
    setCreatorAudio(null);
    setMessages([]);
    setUnread(0);
    setChatOpen(false);
    setMicMuted(true);
    setViewerCount(0);
    setError("");
    setStatus("waiting");
    setMode("landing");
    setSessionCode("");
    window.history.replaceState({}, "", "/");
  };

  useEffect(
    () => () => {
      activeRef.current = false;
      socketRef.current?.close();
      connectionRef.current?.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (mediaRetryTimerRef.current) clearTimeout(mediaRetryTimerRef.current);
    },
    [],
  );

  const saveOptions = (nextOptions: SessionOptions) => {
    setOptions(nextOptions);
    optionsRef.current = nextOptions;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextOptions));
    if (mode === "session" && roleRef.current === "creator") {
      setViewerMicAllowed(nextOptions.allowViewerMic);
      sendSocket({ type: "mic-policy", allowed: nextOptions.allowViewerMic });
      void connectionRef.current?.updatePreferences(nextOptions);
    }
  };

  const createShare = async () => {
    if (!clientId || busy) return;
    setBusy(true);
    setError("");
    let capture: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser");
      }
      capture = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: options.frameRate, max: options.frameRate } },
        audio: options.includeSystemAudio,
      });
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ options }),
      });
      const payload = (await response.json()) as {
        code?: string;
        token?: string;
        error?: string;
      };
      if (!response.ok || !payload.code || !payload.token) {
        throw new Error(payload.error || "Could not create the share");
      }

      roleRef.current = "creator";
      codeRef.current = payload.code;
      tokenRef.current = payload.token;
      activeRef.current = true;
      setRole("creator");
      setSessionCode(payload.code);
      setLocalStream(capture);
      setViewerMicAllowed(options.allowViewerMic);
      setMode("session");
      setStatus("waiting");
      window.history.replaceState({}, "", `/?host=${payload.code}`);
      capture.getVideoTracks()[0]?.addEventListener("ended", () => stopSession(true), {
        once: true,
      });
      openSocket("creator", payload.code, payload.token);
    } catch (createError) {
      capture?.getTracks().forEach((track) => track.stop());
      setError(createError instanceof Error ? createError.message : "Could not create the share");
    } finally {
      setBusy(false);
    }
  };

  const joinShare = async (event?: FormEvent) => {
    event?.preventDefault();
    const code = normaliseCode(joinCode);
    if (!clientId || code.length !== 6 || busy) {
      if (code.length !== 6) setError("Enter the 6-character share code");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/sessions/${code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const payload = (await response.json()) as {
        token?: string;
        options?: SessionOptions;
        error?: string;
      };
      if (!response.ok || !payload.token || !payload.options) {
        throw new Error(payload.error || "That share is not available");
      }
      roleRef.current = "viewer";
      codeRef.current = code;
      tokenRef.current = payload.token;
      activeRef.current = true;
      optionsRef.current = payload.options;
      setOptions(payload.options);
      setViewerMicAllowed(payload.options.allowViewerMic);
      setRole("viewer");
      setSessionCode(code);
      setMode("session");
      setStatus("waiting");
      window.history.replaceState({}, "", `/?join=${code}`);
      openSocket("viewer", code, payload.token);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Could not join the share");
    } finally {
      setBusy(false);
    }
  };

  const toggleMicrophone = async () => {
    if (role === "viewer" && !viewerMicAllowed) return;
    const existingTrack = microphoneRef.current?.getAudioTracks()[0];
    if (existingTrack) {
      existingTrack.enabled = !existingTrack.enabled;
      setMicMuted(!existingTrack.enabled);
      return;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      microphoneRef.current = mic;
      setMicMuted(false);
      if (!connectionRef.current) {
        if (roleRef.current === "creator") return;
        connectionRef.current = new RealtimeConnection({
          code: codeRef.current,
          token: tokenRef.current,
          preferences: optionsRef.current,
          onRemoteStream: (stream) => setRemoteStream(new MediaStream(stream.getTracks())),
          onConnectionState: handleViewerConnectionState,
        });
      }
      if (!connectionRef.current) throw new Error("Media connection is not ready yet");
      const source = roleRef.current === "creator" ? "presenter-mic" : "viewer-mic";
      const [published] = await connectionRef.current.publishTracks([
        { track: mic.getAudioTracks()[0], source },
      ]);
      const track = { ...published, ownerId: clientId };
      if (roleRef.current === "creator") {
        publishedTracksRef.current.push(track);
        sendSocket({ type: "tracks-added", tracks: [track] });
      } else {
        sendSocket({ type: "viewer-audio", track });
      }
    } catch (micError) {
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      microphoneRef.current = null;
      setMicMuted(true);
      setError(micError instanceof Error ? micError.message : "Microphone access failed");
    }
  };

  const copyShareLink = async () => {
    const link = `${window.location.origin}/?join=${sessionCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy the link. Copy it from the address bar instead.");
    }
  };

  const startDockDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      dockX: dockPosition.x,
      dockY: dockPosition.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const width = 330;
      const x = Math.min(
        window.innerWidth - Math.min(width, window.innerWidth - 16),
        Math.max(8, origin.dockX + moveEvent.clientX - origin.pointerX),
      );
      const y = Math.min(
        window.innerHeight - 58,
        Math.max(8, origin.dockY + moveEvent.clientY - origin.pointerY),
      );
      setDockPosition({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const statusCopy =
    role === "creator"
      ? status === "waiting"
        ? "Waiting for a viewer"
        : status === "connecting"
          ? "Starting relay"
          : status === "live"
            ? "Sharing live"
            : status === "reconnecting"
              ? "Reconnecting"
              : "Share unavailable"
      : status === "waiting"
        ? "Waiting for presenter"
        : status === "connecting"
          ? "Connecting to share"
          : status === "live"
            ? "Live"
            : status === "reconnecting"
              ? "Connection interrupted"
              : status === "ended"
                ? "Share ended"
                : "Unable to connect";

  if (mode === "landing") {
    return (
      <main className="landing-page">
        <header className="brand-bar" aria-label="Showmeplease">
          <span className="brand-mark"><MonitorUp size={17} /></span>
          <span>showmeplease</span>
        </header>

        <section className="start-panel" aria-labelledby="start-title">
          <div className="panel-heading">
            <div className="panel-icon"><MonitorUp size={24} strokeWidth={1.8} /></div>
            <div>
              <h1 id="start-title">Share a screen</h1>
              <p>Create a share or join one with a code.</p>
            </div>
          </div>

          <div className="create-row">
            <button className="button primary create-button" disabled={busy} onClick={createShare}>
              {busy ? <LoaderCircle className="spin" size={18} /> : <MonitorUp size={18} />}
              Create share
            </button>
            <button
              className="icon-button settings-button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Configure share settings"
              title="Share settings"
            >
              <Settings size={19} />
            </button>
          </div>

          <div className="or-divider"><span>or join</span></div>

          <form className="join-row" onSubmit={joinShare}>
            <input
              className="code-input"
              value={joinCode}
              onChange={(event) => {
                setJoinCode(normaliseCode(event.target.value));
                setError("");
              }}
              placeholder="ENTER CODE"
              aria-label="Share code"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={6}
            />
            <button className="button secondary join-button" disabled={busy || joinCode.length !== 6}>
              Join <ChevronRight size={17} />
            </button>
          </form>

          {error && (
            <div className="inline-error" role="alert">
              <CircleAlert size={16} />
              <span>{error}</span>
            </div>
          )}
        </section>

        <p className="landing-note">
          Your screen is only relayed after a viewer connects.
        </p>

        <SettingsDialog
          open={settingsOpen}
          options={options}
          sessionActive={false}
          onClose={() => setSettingsOpen(false)}
          onSave={saveOptions}
        />
      </main>
    );
  }

  return (
    <main className={`session-page ${chatOpen ? "chat-visible" : ""}`}>
      <section className="media-stage" aria-label={role === "creator" ? "Share preview" : "Shared screen"}>
        {role === "creator" ? (
          <video ref={localVideoRef} autoPlay muted playsInline className="share-video" />
        ) : (
          <video ref={remoteVideoRef} autoPlay playsInline className="share-video" />
        )}

        {role === "viewer" && status !== "live" && (
          <div className="stage-state">
            <div className={`state-orb ${status}`}>
              {status === "ended" || status === "error" ? (
                <MonitorUp size={27} />
              ) : (
                <LoaderCircle className="spin" size={25} />
              )}
            </div>
            <h1>{statusCopy}</h1>
            <p>
              {status === "reconnecting"
                ? "We’ll keep trying automatically."
                : status === "ended"
                  ? "The presenter stopped this session."
                  : status === "error"
                    ? error
                    : `Share code ${sessionCode}`}
            </p>
            {(status === "ended" || status === "error") && (
              <button className="button stage-button" onClick={() => stopSession(false)}>
                Return home
              </button>
            )}
          </div>
        )}

        {role === "creator" && (
          <div className="preview-label">
            <span className={`status-dot ${status}`} />
            {statusCopy}
          </div>
        )}
      </section>

      <audio ref={creatorAudioRef} autoPlay className="visually-hidden" />

      <div
        className="control-dock"
        style={{ left: dockPosition.x, top: dockPosition.y }}
        aria-label="Session controls"
      >
        <div
          className="dock-grip"
          onPointerDown={startDockDrag}
          role="button"
          tabIndex={0}
          aria-label="Move controls"
          title="Drag to move"
        >
          <GripVertical size={15} />
        </div>
        <div className="dock-status" title={statusCopy}>
          <span className={`status-dot ${status}`} />
          <strong>{sessionCode}</strong>
          {role === "creator" && (
            <span className="viewer-count"><Users size={13} />{viewerCount}</span>
          )}
        </div>
        <div className="dock-divider" />
        <button className="dock-button" onClick={copyShareLink} title="Copy viewer link" aria-label="Copy viewer link">
          {copied ? <Check size={18} /> : <Link2 size={18} />}
        </button>
        <button
          className={`dock-button ${chatOpen ? "active" : ""}`}
          onClick={() => setChatOpen((open) => !open)}
          title="Toggle chat"
          aria-label="Toggle chat"
        >
          <MessageCircle size={18} />
          {unread > 0 && <span className="unread-badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <button
          className={`dock-button ${!micMuted ? "active" : ""}`}
          onClick={toggleMicrophone}
          disabled={role === "viewer" && !viewerMicAllowed}
          title={
            role === "viewer" && !viewerMicAllowed
              ? "The presenter has disabled viewer microphones"
              : micMuted
                ? "Unmute microphone"
                : "Mute microphone"
          }
          aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
        >
          {micMuted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        {role === "creator" && (
          <button
            className="dock-button"
            onClick={() => setSettingsOpen(true)}
            title="Session settings"
            aria-label="Session settings"
          >
            <SlidersHorizontal size={18} />
          </button>
        )}
        <button className="dock-button danger" onClick={() => stopSession(true)} title="Leave session" aria-label="Leave session">
          <X size={18} />
        </button>
      </div>

      {error && status !== "error" && (
        <div className="session-error" role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button>
        </div>
      )}

      <ChatPane
        open={chatOpen}
        messages={messages}
        clientId={clientId}
        onClose={() => setChatOpen(false)}
        onSend={(text) => sendSocket({ type: "chat", text })}
      />

      <SettingsDialog
        open={settingsOpen}
        options={options}
        sessionActive
        onClose={() => setSettingsOpen(false)}
        onSave={saveOptions}
      />
    </main>
  );
}
