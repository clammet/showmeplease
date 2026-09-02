// Which browsers can hand getDisplayMedia an audio track. Chromium is the
// only engine that implements it; Firefox and WebKit silently return video
// only. Copy lives here so the settings dialog and the post-capture notice
// tell the same story.

export type SourceAudioSupport = {
  level: "full" | "conditional" | "tab-only" | "none" | "unknown";
  /** Shown under the audio setting before the presenter picks a source. */
  summary: string;
  /** Shown after a capture that was meant to carry audio came back silent. */
  captureHint: string;
};

const NO_AUDIO_HINT = "This browser cannot capture source audio, so viewers get video only.";

export function detectSourceAudioSupport(nav: Navigator): SourceAudioSupport {
  const ua = nav.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const chromium = ua.match(/Chrom(?:e|ium)\/(\d+)/);
  const firefox = /Firefox\/|FxiOS\//.test(ua);
  const safari = /Safari\//.test(ua) && !chromium && !firefox;

  if (ios) {
    return {
      level: "none",
      summary:
        "Browsers on iPhone and iPad cannot capture source audio, so viewers get video only.",
      captureHint: NO_AUDIO_HINT,
    };
  }
  if (firefox) {
    return {
      level: "none",
      summary:
        "Firefox cannot capture audio from a tab, window, or screen, so viewers get video only.",
      captureHint: NO_AUDIO_HINT,
    };
  }
  if (safari) {
    return {
      level: "none",
      summary:
        "Safari cannot capture audio from a tab, window, or screen, so viewers get video only.",
      captureHint: NO_AUDIO_HINT,
    };
  }
  if (!chromium) {
    return {
      level: "unknown",
      summary:
        "Source audio depends on the browser. Chromium browsers can send it; Firefox and Safari cannot.",
      captureHint: "This capture has no audio. Turn on the audio switch in the share picker if it offers one.",
    };
  }

  const version = Number(chromium[1]);
  if (/Windows|CrOS/.test(ua)) {
    return {
      level: "full",
      summary:
        "This browser can send audio from a tab, window, or screen. Keep the audio switch on in the share picker.",
      captureHint: "This capture has no audio. Turn on the audio switch in the share picker.",
    };
  }
  if (/Mac/.test(ua)) {
    if (version >= 141) {
      return {
        level: "conditional",
        summary:
          "This browser can send tab audio, and window or screen audio on macOS 14.2 or newer. Keep the audio switch on in the share picker.",
        captureHint:
          "This capture has no audio. Turn on the audio switch in the share picker. Window and screen audio needs macOS 14.2 or newer.",
      };
    }
    return {
      level: "tab-only",
      summary: `This browser (Chromium ${version}) can send tab audio only. Window and screen audio needs Chrome 141 or newer on macOS 14.2 or newer.`,
      captureHint:
        "This capture has no audio. Pick a browser tab, or update to Chrome 141 or newer on macOS 14.2 or newer for window and screen audio.",
    };
  }
  return {
    level: "tab-only",
    summary:
      "This browser can send tab audio only on this platform. Window and screen shares are video only.",
    captureHint:
      "This capture has no audio. Only browser tabs carry audio on this platform; pick a tab and turn on the audio switch.",
  };
}

let cached: SourceAudioSupport | null = null;

/** Stable per page load, so it is safe to read from useSyncExternalStore. */
export function getSourceAudioSupport(): SourceAudioSupport {
  if (!cached) cached = detectSourceAudioSupport(navigator);
  return cached;
}
