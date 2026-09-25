# Laser coordinate lab

Run `pnpm test:laser`, open <http://127.0.0.1:4174>, and click **Run regression matrix**.
If the package-manager launcher is unavailable, the equivalent command is:

```sh
node node_modules/vite/bin/vite.js --config tests/laser-browser/vite.config.ts
```

This is a standalone, browser-run regression suite, separate from `pnpm test`.
It uses the installed Vite/React dependencies and needs no backend, credentials,
capture permissions, WebRTC connection, or visual datastream. It is not a
production app route.

## Interactive inspection

Choose the shared content's aspect ratio and independent sender/recipient
viewport sizes. Move over either fixed grid to send a laser point to both
panels. Toggle chat to exercise the production sidebar layout and its resize
transition. The panels scale down for convenience; their iframe viewports and
assertions retain the stated CSS pixel dimensions. The last dot stays visible
for inspection; normal idle expiry is deliberately omitted here (covered in
`tests/laser.test.mjs`).

## What the matrix tests

- Four content sizes: 1920×1080, 1024×768, 1080×1920, and 3440×1440.
- Four viewport sizes: 1920×1080, 1024×768, 390×844, and 2560×1080.
- Adjacent viewport pairs in that list, including the last → first pair, each
  tested in both directions with chat open and closed.
- Nine grid targets per direction, checking normalized wire coordinates and
  both participants' dot centers within **1 CSS pixel** of the actual content.
- Both endpoints of the latest trail segment, including SVG transformations.
- Stationary dots after source aspect ratio, viewport, and sidebar changes.

The fixture renders the real `AnnotationLayer`, `.media-stage`, and
`.share-video` styles. A static SVG grid is the video element's **poster**;
only `videoWidth`/`videoHeight` and metadata events are substituted in the
fixture. Keeping the real video element matters: replacing it with a div would
hide intrinsic media sizing bugs. JSON messages pass through `postMessage` and
the production instruction parser; the network transport is intentionally not
under test.

Expected positions come from the **actual media element's rendered box**, not
the annotation layer's frame. Pointer events hit-test those grid positions, so
a shifted input surface cannot make an incorrect renderer pass. The suite
changes existing frames instead of remounting them, exercising ResizeObserver
and metadata updates. Keep the tab foreground while the matrix runs.

## Reproduced regression

Before the CSS fix, the original 576-point matrix failed 324 checks. For 16:9
content inside a 2560×1080 viewport, the implicit grid row expanded the video
to 2560×1440. The overlay correctly calculated a 1920×1080 content rectangle
from the stage, but that no longer matched the oversized video.

Explicit `minmax(0, 1fr)` grid tracks plus zero media minimum sizes keep the
video box inside the stage, so `object-fit: contain` and the annotation frame
use the same rectangle. Removing those constraints should make this suite fail.
