"use client";

/* eslint-disable jsx-a11y/media-has-caption */

import {
  Check,
  ChevronRight,
  CircleAlert,
  Eraser,
  GripVertical,
  Link2,
  LoaderCircle,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  MousePointer2,
  Palette,
  Pencil,
  PenTool,
  ScreenShare,
  Settings,
  SlidersHorizontal,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getSourceAudioSupport, type SourceAudioSupport } from "@/lib/browserAudio";
import {
  coerceSessionOptions,
  DEFAULT_OPTIONS,
  MAX_BITRATE_KBPS,
  MIN_BITRATE_KBPS,
  type SessionOptions,
} from "@/lib/options";
import {
  ANNOTATION_COLORS,
  applyDrawingInstruction,
  type DrawingInstruction,
  type DrawingStroke,
} from "@/lib/annotations";
import {
  SessionClient,
  type ChatMessage,
  type Role,
  type SessionEvent,
  type SessionStatus,
} from "@/lib/session";
import AccountControls from "./AccountControls";
import AnnotationLayer, {
  LASER_CLOCK_INTERVAL_MS,
  LASER_POINTER_IDLE_DURATION_MS,
  LASER_TRAIL_HISTORY_MS,
  type AnnotationTool,
  type LaserMark,
} from "./AnnotationLayer";

type AppMode = "landing" | "session";

const STORAGE_KEY = "showmeplease.session-options.v2";
const LEGACY_STORAGE_KEY = "showmeplease.session-options.v1";
const CLIENT_ID_KEY = "showmeplease.client-id";

function parseOptions(value: string | null): SessionOptions {
  if (!value) return DEFAULT_OPTIONS;
  try {
    return coerceSessionOptions(JSON.parse(value));
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function loadSavedOptions(): SessionOptions {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseOptions(saved);

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return DEFAULT_OPTIONS;

    // The old save flow also persisted live-session permission changes. Keep
    // the user's capture preferences, but reset those accidentally sticky
    // permissions during the one-time migration.
    const migrated = {
      ...parseOptions(legacy),
      allowViewerMic: DEFAULT_OPTIONS.allowViewerMic,
      allowViewerAnnotations: DEFAULT_OPTIONS.allowViewerAnnotations,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/** One id per browser tab, so a reload can reclaim its viewer token. */
function loadClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function normaliseCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

// Browser capability never changes during a page load, so the store has no
// updates to subscribe to; the server snapshot is null until hydration.
const subscribeNever = () => () => {};
const getServerAudioSupport = (): SourceAudioSupport | null => null;

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
  onSave: (options: SessionOptions, scope: "session" | "all") => void;
}) {
  // The parent remounts this dialog (via `key`) each time it opens, so the
  // draft starts from the current options without an effect.
  const [draft, setDraft] = useState(options);
  const audioSupport = useSyncExternalStore(
    subscribeNever,
    getSourceAudioSupport,
    getServerAudioSupport,
  );

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
              min={MIN_BITRATE_KBPS}
              max={MAX_BITRATE_KBPS}
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
                  frameRate: Number(event.target.value) as SessionOptions["frameRate"],
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
              <strong>Include source audio</strong>
              <small>Ask the browser for the audio of the tab, window, or screen you pick.</small>
              {audioSupport && (
                <small className={`support-note ${audioSupport.level}`} role="note">
                  {audioSupport.level === "none" ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  {audioSupport.summary}
                </small>
              )}
            </span>
            <input
              type="checkbox"
              aria-label="Include source audio"
              checked={draft.includeSystemAudio}
              onChange={(event) =>
                setDraft({ ...draft, includeSystemAudio: event.target.checked })
              }
            />
          </label>

          <label className="toggle-row">
            <span>
              <strong>Allow viewer annotations</strong>
              <small>Show laser and drawing tools to everyone watching the share.</small>
            </span>
            <input
              type="checkbox"
              aria-label="Allow viewer annotations"
              checked={draft.allowViewerAnnotations}
              onChange={(event) =>
                setDraft({ ...draft, allowViewerAnnotations: event.target.checked })
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
            Bitrate, viewer mic access, and viewer annotations update now. Codec and capture options
            apply to the next media connection in this session.
          </p>
        )}

        <div className={`dialog-actions ${sessionActive ? "" : "pre-session"}`}>
          <button className="button secondary" onClick={onClose}>Cancel</button>
          <button
            className={sessionActive ? "button primary" : "button secondary"}
            onClick={() => {
              onSave(draft, "session");
              onClose();
            }}
          >
            Save for this session
          </button>
          {!sessionActive && (
            <button
              className="button primary"
              onClick={() => {
                onSave(draft, "all");
                onClose();
              }}
            >
              Save for all sessions
            </button>
          )}
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
  const [savedOptions, setSavedOptions] = useState(DEFAULT_OPTIONS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  const [shareMuted, setShareMuted] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [creatorAudio, setCreatorAudio] = useState<MediaStream | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drawings, setDrawings] = useState<DrawingStroke[]>([]);
  const [laserMarks, setLaserMarks] = useState<LaserMark[]>([]);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>(null);
  const [annotationColor, setAnnotationColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [micMuted, setMicMuted] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dockPosition, setDockPosition] = useState({ x: 20, y: 20 });
  const [clientId, setClientId] = useState("");
  const [secureContext, setSecureContext] = useState(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const mediaStageRef = useRef<HTMLElement>(null);
  const creatorAudioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<SessionClient | null>(null);
  const chatOpenRef = useRef(false);
  const laserMarkIdRef = useRef(0);
  const autoJoinRef = useRef(false);

  useEffect(() => {
    // Browser-only values read once after hydration; reading them during
    // render would differ from the static export and break hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClientId(loadClientId());
    const storedOptions = loadSavedOptions();
    setSavedOptions(storedOptions);
    setOptions(storedOptions);
    setSecureContext(window.isSecureContext);
    const queryCode = normaliseCode(new URLSearchParams(window.location.search).get("join") || "");
    if (queryCode) {
      setJoinCode(queryCode);
      autoJoinRef.current = queryCode.length === 6;
    }
  }, []);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.muted = shareMuted;
  }, [shareMuted, remoteStream]);

  useEffect(() => {
    if (creatorAudioRef.current) creatorAudioRef.current.srcObject = creatorAudio;
  }, [creatorAudio]);

  const hasLaserMarks = laserMarks.length > 0;
  useEffect(() => {
    if (!hasLaserMarks) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setLaserMarks((current) => {
        const latestBySender = new Map<string, LaserMark>();
        for (const mark of current) {
          const latest = latestBySender.get(mark.senderId);
          if (!latest || mark.at > latest.at || (mark.at === latest.at && mark.id > latest.id)) {
            latestBySender.set(mark.senderId, mark);
          }
        }
        const next = current.filter((mark) => {
          const latest = latestBySender.get(mark.senderId);
          const lifetime = latest?.id === mark.id
            ? LASER_POINTER_IDLE_DURATION_MS
            : LASER_TRAIL_HISTORY_MS;
          return now - mark.at < lifetime;
        });
        return next.length === current.length ? current : next;
      });
    }, LASER_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasLaserMarks]);

  const toggleChat = (open: boolean) => {
    chatOpenRef.current = open;
    setChatOpen(open);
    if (open) setUnread(0);
  };

  // Tear the session down if the component goes away mid-share.
  useEffect(
    () => () => {
      clientRef.current?.stop(true);
      clientRef.current = null;
    },
    [],
  );

  const leaveSession = useCallback((notify: boolean) => {
    clientRef.current?.stop(notify);
    clientRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setCreatorAudio(null);
    setMessages([]);
    setDrawings([]);
    setLaserMarks([]);
    setAnnotationOpen(false);
    setAnnotationTool(null);
    setUnread(0);
    chatOpenRef.current = false;
    setChatOpen(false);
    setMicMuted(true);
    setViewerCount(0);
    setError("");
    setNotice("");
    setShareMuted(false);
    setStatus("waiting");
    setMode("landing");
    setSessionCode("");
    setOptions(savedOptions);
    window.history.replaceState({}, "", "/");
  }, [savedOptions]);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          return;
        case "options":
          setOptions(event.options);
          if (clientRef.current?.role === "viewer" && !event.options.allowViewerAnnotations) {
            setAnnotationOpen(false);
            setAnnotationTool(null);
          }
          return;
        case "viewer-count":
          setViewerCount(event.viewerCount);
          return;
        case "chat":
          setMessages((current) =>
            [...current, event.message].sort((a, b) => a.timestamp - b.timestamp).slice(-100),
          );
          if (!chatOpenRef.current && event.message.senderId !== clientRef.current?.clientId) {
            setUnread((count) => count + 1);
          }
          return;
        case "drawing-snapshot":
          setDrawings(event.strokes);
          return;
        case "drawing-instruction":
          if (event.instruction.kind === "laser-move") {
            const nextMark: LaserMark = {
              id: laserMarkIdRef.current++,
              senderId: event.senderId,
              color: event.instruction.color,
              point: event.instruction.point,
              at: Date.now(),
            };
            setLaserMarks((current) => [...current.slice(-239), nextMark]);
            return;
          }
          if (event.instruction.kind === "clear") setLaserMarks([]);
          setDrawings((current) =>
            applyDrawingInstruction(current, event.instruction, event.senderId),
          );
          return;
        case "remote-stream":
          setRemoteStream(event.stream);
          return;
        case "creator-audio":
          setCreatorAudio(event.stream);
          return;
        case "mic":
          setMicMuted(event.muted);
          return;
        case "error":
          setError(event.message);
          return;
        case "ended":
          if (event.reason === "presenter" && clientRef.current?.role === "creator") {
            // Screen capture ended from the browser's own "Stop sharing" control.
            leaveSession(false);
            return;
          }
          if (event.reason === "terminated") setError("An administrator ended this session.");
          if (event.reason === "unauthorized") setError("This session is no longer available.");
          if (event.reason === "gave-up") setError("Lost the connection to the server.");
          return;
        default:
          return;
      }
    },
    [leaveSession],
  );

  const startSession = (
    nextRole: Role,
    code: string,
    token: string,
    sessionOptions: SessionOptions,
    capture: MediaStream | null,
  ) => {
    const client = new SessionClient({
      role: nextRole,
      code,
      token,
      clientId,
      options: sessionOptions,
      localStream: capture ?? undefined,
      onEvent: handleEvent,
    });
    clientRef.current = client;
    setRole(nextRole);
    setSessionCode(code);
    setOptions(sessionOptions);
    setLocalStream(capture);
    setDockPosition({ x: 20, y: Math.max(20, window.innerHeight - 82) });
    setMode("session");
    setStatus("waiting");
    window.history.replaceState({}, "", nextRole === "creator" ? `/?host=${code}` : `/?join=${code}`);
    client.start();
  };

  const saveOptions = (nextOptions: SessionOptions, scope: "session" | "all") => {
    setOptions(nextOptions);
    if (scope === "all") {
      setSavedOptions(nextOptions);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextOptions));
    }
    clientRef.current?.updateOptions(nextOptions);
  };

  const sendDrawingInstruction = useCallback((instruction: DrawingInstruction) => {
    return clientRef.current?.sendDrawingInstruction(instruction) ?? false;
  }, []);

  const requestCapture = () => {
    if (!window.isSecureContext) {
      throw new Error("Screen sharing needs HTTPS (or localhost). Open this page over https.");
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }
    // systemAudio and windowAudio are Chrome hints (Chrome 105 and 141) that
    // make the picker offer an audio switch for screens and windows, not just
    // tabs. Other browsers ignore them. Processing is off so music and app
    // sound reach viewers unaltered.
    const request: DisplayMediaStreamOptions & {
      systemAudio?: "include" | "exclude";
      windowAudio?: "system" | "window" | "exclude";
    } = {
      video: { frameRate: { ideal: options.frameRate, max: options.frameRate } },
      audio: options.includeSystemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    };
    if (options.includeSystemAudio) {
      request.systemAudio = "include";
      request.windowAudio = "system";
    }
    return navigator.mediaDevices.getDisplayMedia(request);
  };

  /** Tell the presenter when they asked for audio but the browser gave none. */
  const reportCaptureAudio = (capture: MediaStream) => {
    if (!options.includeSystemAudio || capture.getAudioTracks().length) {
      setNotice("");
      return;
    }
    setNotice(getSourceAudioSupport().captureHint);
  };

  const changeSource = async () => {
    const client = clientRef.current;
    if (!client || client.role !== "creator" || busy) return;
    setBusy(true);
    setError("");
    let capture: MediaStream | null = null;
    try {
      capture = await requestCapture();
      await client.replaceCapture(capture);
      setLocalStream(capture);
      reportCaptureAudio(capture);
    } catch (changeError) {
      capture?.getTracks().forEach((track) => track.stop());
      // The user cancelling the picker is not an error worth surfacing.
      if (!(changeError instanceof DOMException && changeError.name === "NotAllowedError")) {
        setError(
          changeError instanceof Error ? changeError.message : "Could not change the capture source",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const createShare = async () => {
    if (!clientId || busy) return;
    setBusy(true);
    setError("");
    let capture: MediaStream | null = null;
    try {
      capture = await requestCapture();
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ options, clientId }),
      });
      const payload = (await response.json()) as {
        code?: string;
        token?: string;
        error?: string;
      };
      if (!response.ok || !payload.code || !payload.token) {
        throw new Error(payload.error || "Could not create the share");
      }
      startSession("creator", payload.code, payload.token, options, capture);
      reportCaptureAudio(capture);
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
      startSession("viewer", code, payload.token, payload.options, null);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Could not join the share");
    } finally {
      setBusy(false);
    }
  };

  // A join link should drop the visitor straight into the share; wait for
  // the client id and code to land after hydration, then join once.
  useEffect(() => {
    if (!autoJoinRef.current || !clientId || joinCode.length !== 6) return;
    autoJoinRef.current = false;
    void joinShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, joinCode]);

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

  const viewerMicAllowed = options.allowViewerMic;
  const captureHasAudio = (localStream?.getAudioTracks().length ?? 0) > 0;
  const terminal = status === "ended" || status === "error";
  const annotationsAvailable = role === "creator" || options.allowViewerAnnotations;
  const activeAnnotationTool = terminal || !annotationsAvailable ? null : annotationTool;

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
          <span className="brand-bar-spacer" />
          <AccountControls />
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

          <form className="join-row" onSubmit={joinShare} autoComplete="off">
            <input
              className="code-input"
              type="text"
              name="share-code"
              inputMode="text"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
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

          {!secureContext && (
            <div className="inline-error" role="alert">
              <CircleAlert size={16} />
              <span>This page is not served over HTTPS, so browsers will refuse screen capture.</span>
            </div>
          )}

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
          key={settingsOpen ? "open" : "closed"}
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
      <section
        ref={mediaStageRef}
        className="media-stage"
        aria-label={role === "creator" ? "Share preview" : "Shared screen"}
      >
        {role === "creator" ? (
          <video ref={localVideoRef} autoPlay muted playsInline className="share-video" />
        ) : (
          <video ref={remoteVideoRef} autoPlay playsInline className="share-video" />
        )}

        <AnnotationLayer
          stageRef={mediaStageRef}
          videoRef={role === "creator" ? localVideoRef : remoteVideoRef}
          strokes={drawings}
          laserMarks={laserMarks}
          activeTool={activeAnnotationTool}
          color={annotationColor}
          onInstruction={sendDrawingInstruction}
        />

        {(role === "viewer" ? status !== "live" : terminal) && (
          <div className="stage-state">
            <div className={`state-orb ${status}`}>
              {terminal ? (
                <MonitorUp size={27} />
              ) : (
                <LoaderCircle className="spin" size={25} />
              )}
            </div>
            <h1>{statusCopy}</h1>
            <p>
              {status === "reconnecting"
                ? "We\u2019ll keep trying automatically."
                : status === "ended"
                  ? "The presenter stopped this session."
                  : status === "error"
                    ? error
                    : `Share code ${sessionCode}`}
            </p>
            {terminal && (
              <button className="button stage-button" onClick={() => leaveSession(false)}>
                Return home
              </button>
            )}
          </div>
        )}

        {role === "creator" && !terminal && (
          <div className="preview-label">
            <span className={`status-dot ${status}`} />
            {statusCopy}
            <span
              className={`audio-flag ${captureHasAudio ? "on" : ""}`}
              title={captureHasAudio ? "Sending source audio" : "No source audio in this capture"}
              aria-label={captureHasAudio ? "Sending source audio" : "No source audio in this capture"}
            >
              {captureHasAudio ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </span>
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
          onClick={() => toggleChat(!chatOpen)}
          title="Toggle chat"
          aria-label="Toggle chat"
        >
          <MessageCircle size={18} />
          {unread > 0 && <span className="unread-badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
        {annotationsAvailable && (
          <div className="annotation-controls">
            <button
              className={`dock-button ${annotationOpen ? "active" : ""}`}
              onClick={() => {
                const nextOpen = !annotationOpen;
                setAnnotationOpen(nextOpen);
                if (!nextOpen) setAnnotationTool(null);
              }}
              disabled={terminal}
              title="Toggle annotation tools"
              aria-label="Toggle annotation tools"
              aria-expanded={annotationOpen}
            >
              <PenTool size={18} />
            </button>
            {annotationOpen && (
              <div className="annotation-tool-shelf" role="toolbar" aria-label="Annotation tools">
                {annotationTool && (
                  <div className="annotation-color-row" role="group" aria-label="Annotation color">
                    {ANNOTATION_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-choice ${annotationColor === color ? "selected" : ""}`}
                        style={{ backgroundColor: color }}
                        onClick={() => setAnnotationColor(color)}
                        title={`Use ${color}`}
                        aria-label={`Use color ${color}`}
                        aria-pressed={annotationColor === color}
                      />
                    ))}
                    <label className="color-picker-choice" title="Choose a custom color">
                      <Palette size={16} />
                      <input
                        type="color"
                        value={annotationColor}
                        onChange={(event) => setAnnotationColor(event.target.value)}
                        aria-label="Choose a custom annotation color"
                      />
                    </label>
                  </div>
                )}
                <button
                  className={`dock-button ${annotationTool === "laser" ? "active" : ""}`}
                  onClick={() =>
                    setAnnotationTool((current) => (current === "laser" ? null : "laser"))
                  }
                  title="Laser pointer"
                  aria-label="Laser pointer"
                  aria-pressed={annotationTool === "laser"}
                >
                  <MousePointer2 size={18} />
                </button>
                <button
                  className={`dock-button ${annotationTool === "pencil" ? "active" : ""}`}
                  onClick={() =>
                    setAnnotationTool((current) => (current === "pencil" ? null : "pencil"))
                  }
                  title="Pencil"
                  aria-label="Pencil"
                  aria-pressed={annotationTool === "pencil"}
                >
                  <Pencil size={18} />
                </button>
                <button
                  className="dock-button"
                  onClick={() => sendDrawingInstruction({ kind: "clear" })}
                  title="Erase all annotations"
                  aria-label="Erase all annotations"
                >
                  <Eraser size={18} />
                </button>
              </div>
            )}
          </div>
        )}
        {role === "viewer" && (
          <button
            className="dock-button"
            onClick={() => setShareMuted((muted) => !muted)}
            disabled={terminal}
            title={shareMuted ? "Unmute the share" : "Mute the share"}
            aria-label={shareMuted ? "Unmute the share" : "Mute the share"}
            aria-pressed={shareMuted}
          >
            {shareMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
        )}
        <button
          className={`dock-button ${!micMuted ? "active" : ""}`}
          onClick={() => void clientRef.current?.toggleMicrophone()}
          disabled={terminal || (role === "viewer" && !viewerMicAllowed)}
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
            onClick={changeSource}
            disabled={busy}
            title="Change capture source"
            aria-label="Change capture source"
          >
            <ScreenShare size={18} />
          </button>
        )}
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
        <button className="dock-button danger" onClick={() => leaveSession(true)} title="Leave session" aria-label="Leave session">
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

      {notice && !error && !terminal && (
        <div className="session-error session-notice" role="status">
          <VolumeX size={16} />
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={15} /></button>
        </div>
      )}

      <ChatPane
        open={chatOpen}
        messages={messages}
        clientId={clientId}
        onClose={() => toggleChat(false)}
        onSend={(text) => clientRef.current?.sendChat(text)}
      />

      <SettingsDialog
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        options={options}
        sessionActive
        onClose={() => setSettingsOpen(false)}
        onSave={saveOptions}
      />
    </main>
  );
}
