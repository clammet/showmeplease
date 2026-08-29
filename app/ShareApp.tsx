"use client";

/* eslint-disable jsx-a11y/media-has-caption */

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
  ScreenShare,
  Settings,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  coerceSessionOptions,
  DEFAULT_OPTIONS,
  MAX_BITRATE_KBPS,
  MIN_BITRATE_KBPS,
  type SessionOptions,
} from "@/lib/options";
import {
  SessionClient,
  type ChatMessage,
  type Role,
  type SessionEvent,
  type SessionStatus,
} from "@/lib/session";
import AccountControls from "./AccountControls";

type AppMode = "landing" | "session";

const STORAGE_KEY = "showmeplease.session-options.v1";
const CLIENT_ID_KEY = "showmeplease.client-id";

function parseOptions(value: string | null): SessionOptions {
  if (!value) return DEFAULT_OPTIONS;
  try {
    return coerceSessionOptions(JSON.parse(value));
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
  // The parent remounts this dialog (via `key`) each time it opens, so the
  // draft starts from the current options without an effect.
  const [draft, setDraft] = useState(options);

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
  const [copied, setCopied] = useState(false);
  const [dockPosition, setDockPosition] = useState({ x: 20, y: 20 });
  const [clientId, setClientId] = useState("");
  const [secureContext, setSecureContext] = useState(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const creatorAudioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<SessionClient | null>(null);
  const chatOpenRef = useRef(false);

  useEffect(() => {
    // Browser-only values read once after hydration; reading them during
    // render would differ from the static export and break hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClientId(loadClientId());
    setOptions(parseOptions(localStorage.getItem(STORAGE_KEY)));
    setSecureContext(window.isSecureContext);
    const queryCode = normaliseCode(new URLSearchParams(window.location.search).get("join") || "");
    if (queryCode) setJoinCode(queryCode);
  }, []);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (creatorAudioRef.current) creatorAudioRef.current.srcObject = creatorAudio;
  }, [creatorAudio]);

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
    setUnread(0);
    chatOpenRef.current = false;
    setChatOpen(false);
    setMicMuted(true);
    setViewerCount(0);
    setError("");
    setStatus("waiting");
    setMode("landing");
    setSessionCode("");
    window.history.replaceState({}, "", "/");
  }, []);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          return;
        case "options":
          setOptions(event.options);
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

  const saveOptions = (nextOptions: SessionOptions) => {
    setOptions(nextOptions);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextOptions));
    clientRef.current?.updateOptions(nextOptions);
  };

  const requestCapture = () => {
    if (!window.isSecureContext) {
      throw new Error("Screen sharing needs HTTPS (or localhost). Open this page over https.");
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.frameRate, max: options.frameRate } },
      audio: options.includeSystemAudio,
    });
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
  const terminal = status === "ended" || status === "error";

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
      <section className="media-stage" aria-label={role === "creator" ? "Share preview" : "Shared screen"}>
        {role === "creator" ? (
          <video ref={localVideoRef} autoPlay muted playsInline className="share-video" />
        ) : (
          <video ref={remoteVideoRef} autoPlay playsInline className="share-video" />
        )}

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
