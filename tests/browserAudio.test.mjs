import assert from "node:assert/strict";
import test from "node:test";
import { detectSourceAudioSupport } from "../lib/browserAudio.ts";

const nav = (userAgent, extra = {}) => ({ userAgent, platform: "", maxTouchPoints: 0, ...extra });

const CHROME_MAC_141 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHROME_MAC_130 = CHROME_MAC_141.replace("Chrome/141", "Chrome/130");
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/141.0.0.0`;
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";

test("source audio support by browser", () => {
  assert.equal(detectSourceAudioSupport(nav(CHROME_WIN)).level, "full");
  assert.equal(detectSourceAudioSupport(nav(EDGE_WIN)).level, "full");
  assert.equal(detectSourceAudioSupport(nav(CHROME_MAC_141)).level, "conditional");
  assert.equal(detectSourceAudioSupport(nav(CHROME_MAC_130)).level, "tab-only");
  assert.equal(detectSourceAudioSupport(nav(CHROME_LINUX)).level, "tab-only");
  assert.equal(detectSourceAudioSupport(nav(FIREFOX_MAC)).level, "none");
  assert.equal(detectSourceAudioSupport(nav(SAFARI_MAC)).level, "none");
  assert.equal(detectSourceAudioSupport(nav(CHROME_IOS)).level, "none");
  // iPadOS Safari reports itself as a Mac with a touch screen.
  assert.equal(
    detectSourceAudioSupport(nav(SAFARI_MAC, { platform: "MacIntel", maxTouchPoints: 5 })).level,
    "none",
  );
});

test("every verdict carries copy for both surfaces", () => {
  for (const ua of [CHROME_WIN, CHROME_MAC_141, CHROME_MAC_130, FIREFOX_MAC, SAFARI_MAC, "curl/8"]) {
    const support = detectSourceAudioSupport(nav(ua));
    assert.ok(support.summary.length > 20, ua);
    assert.ok(support.captureHint.length > 20, ua);
  }
  assert.equal(detectSourceAudioSupport(nav("curl/8")).level, "unknown");
});
