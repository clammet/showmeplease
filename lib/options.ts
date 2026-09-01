// Session options shared by the browser and the hub. The hub validates every
// options object it receives with `parseSessionOptions`, so viewers only ever
// see values from this set.

export const CODECS = ["auto", "AV1", "VP9", "VP8", "H264"] as const;
export type CodecPreference = (typeof CODECS)[number];

export const FRAME_RATES = [15, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const MIN_BITRATE_KBPS = 500;
export const MAX_BITRATE_KBPS = 20000;

export type SessionOptions = {
  codec: CodecPreference;
  maxBitrateKbps: number;
  frameRate: FrameRate;
  includeSystemAudio: boolean;
  allowViewerMic: boolean;
  allowViewerAnnotations: boolean;
};

export const DEFAULT_OPTIONS: SessionOptions = {
  codec: "auto",
  maxBitrateKbps: 6000,
  frameRate: 30,
  includeSystemAudio: true,
  allowViewerMic: false,
  allowViewerAnnotations: false,
};

/** Strict validation: returns null unless every field is present and in range. */
export function parseSessionOptions(value: unknown): SessionOptions | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const codec = candidate.codec;
  const bitrate = candidate.maxBitrateKbps;
  const frameRate = candidate.frameRate;
  if (!CODECS.includes(codec as CodecPreference)) return null;
  if (
    typeof bitrate !== "number" ||
    !Number.isFinite(bitrate) ||
    bitrate < MIN_BITRATE_KBPS ||
    bitrate > MAX_BITRATE_KBPS
  ) {
    return null;
  }
  if (!FRAME_RATES.includes(frameRate as FrameRate)) return null;
  if (typeof candidate.includeSystemAudio !== "boolean") return null;
  if (typeof candidate.allowViewerMic !== "boolean") return null;
  if (typeof candidate.allowViewerAnnotations !== "boolean") return null;
  return {
    codec: codec as CodecPreference,
    maxBitrateKbps: Math.round(bitrate),
    frameRate: frameRate as FrameRate,
    includeSystemAudio: candidate.includeSystemAudio,
    allowViewerMic: candidate.allowViewerMic,
    allowViewerAnnotations: candidate.allowViewerAnnotations,
  };
}

/** Lenient version for local storage: fills gaps and clamps instead of rejecting. */
export function coerceSessionOptions(value: unknown): SessionOptions {
  if (typeof value !== "object" || value === null) return DEFAULT_OPTIONS;
  const candidate = value as Record<string, unknown>;
  const bitrate = Number(candidate.maxBitrateKbps);
  return {
    codec: CODECS.includes(candidate.codec as CodecPreference)
      ? (candidate.codec as CodecPreference)
      : DEFAULT_OPTIONS.codec,
    maxBitrateKbps: Number.isFinite(bitrate)
      ? Math.min(MAX_BITRATE_KBPS, Math.max(MIN_BITRATE_KBPS, Math.round(bitrate)))
      : DEFAULT_OPTIONS.maxBitrateKbps,
    frameRate: FRAME_RATES.includes(candidate.frameRate as FrameRate)
      ? (candidate.frameRate as FrameRate)
      : DEFAULT_OPTIONS.frameRate,
    includeSystemAudio:
      typeof candidate.includeSystemAudio === "boolean"
        ? candidate.includeSystemAudio
        : DEFAULT_OPTIONS.includeSystemAudio,
    allowViewerMic:
      typeof candidate.allowViewerMic === "boolean"
        ? candidate.allowViewerMic
        : DEFAULT_OPTIONS.allowViewerMic,
    allowViewerAnnotations:
      typeof candidate.allowViewerAnnotations === "boolean"
        ? candidate.allowViewerAnnotations
        : DEFAULT_OPTIONS.allowViewerAnnotations,
  };
}

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type SharedTrack = {
  sessionId: string;
  trackName: string;
  kind: "audio" | "video";
  source: "screen" | "presenter-mic" | "viewer-mic";
  ownerId?: string;
};

const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseSharedTrack(value: unknown): SharedTrack | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { sessionId, trackName, kind, source, ownerId } = candidate;
  if (typeof sessionId !== "string" || !TRACK_ID_PATTERN.test(sessionId)) return null;
  if (typeof trackName !== "string" || !TRACK_ID_PATTERN.test(trackName)) return null;
  if (kind !== "audio" && kind !== "video") return null;
  if (source !== "screen" && source !== "presenter-mic" && source !== "viewer-mic") return null;
  if (ownerId !== undefined && (typeof ownerId !== "string" || !CLIENT_ID_PATTERN.test(ownerId))) {
    return null;
  }
  return { sessionId, trackName, kind, source, ...(ownerId !== undefined ? { ownerId } : {}) };
}
