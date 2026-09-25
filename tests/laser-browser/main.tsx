import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import AnnotationLayer from "../../app/AnnotationLayer";
import { parseDrawingInstruction, type DrawingInstruction } from "../../lib/annotations";
import { appendLaserMark, type LaserMark } from "../../lib/laser";
import "../../app/globals.css";
import "./style.css";

type Size = { width: number; height: number };
const sizes: Record<string, Size> = {
  "1920 × 1080 · landscape": { width: 1920, height: 1080 },
  "1024 × 768 · 4:3": { width: 1024, height: 768 },
  "390 × 844 · portrait": { width: 390, height: 844 },
  "2560 × 1080 · ultrawide": { width: 2560, height: 1080 },
};
const sources: Record<string, Size> = {
  "1920 × 1080 · 16:9": { width: 1920, height: 1080 },
  "1024 × 768 · 4:3": { width: 1024, height: 768 },
  "1080 × 1920 · portrait": { width: 1080, height: 1920 },
  "3440 × 1440 · ultrawide": { width: 3440, height: 1440 },
};

function grid({ width, height }: Size) {
  const lines = Array.from({ length: 11 }, (_, i) =>
    `<path d="M ${i * 100} 0 V 1000 M 0 ${i * 100} H 1000" stroke="#39615c" stroke-width="2"/>`,
  ).join("");
  const targets = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) =>
    `<circle cx="${x * 1000}" cy="${y * 1000}" r="12" fill="none" stroke="#fdcd78" stroke-width="3"/>
     <text x="${x * 1000 + 20}" y="${y * 1000 + 35}" fill="#fff" font-size="25">${x}, ${y}</text>`,
  )).join("");
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none"><path fill="#102923" d="M0 0H1000V1000H0Z"/>${lines}${targets}</svg>`)}`;
}

// A static poster preserves the real video element's intrinsic layout. Only
// decoded metadata is substituted: there is no stream, capture or media request.
function Surface() {
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<Size>(sources[Object.keys(sources)[0]]);
  const [marks, setMarks] = useState<LaserMark[]>([]);
  const [chat, setChat] = useState(false);
  const nextId = useRef(0);
  const [lastPoint, setLastPoint] = useState("");
  const poster = grid(source);

  useEffect(() => {
    const video = videoRef.current!;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, get: () => source.width },
      videoHeight: { configurable: true, get: () => source.height },
    });
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("resize"));
  }, [source]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== parent) return;
      if (event.data?.type === "configure") {
        setSource(event.data.source);
        setChat(event.data.chat);
        return;
      }
      if (event.data?.type !== "instruction") return;
      const instruction = parseDrawingInstruction(event.data.instruction);
      if (instruction?.kind !== "laser-move") return;
      setLastPoint(JSON.stringify(instruction.point));
      setMarks((current) => appendLaserMark(current, {
        id: nextId.current++, senderId: "test-pointer", color: instruction.color,
        point: instruction.point, trailId: instruction.trailId, at: Date.now(),
      }));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const send = (instruction: DrawingInstruction) => {
    parent.postMessage({ type: "instruction", instruction }, location.origin);
    return true;
  };

  return (
    <main className={`session-page ${chat ? "chat-visible" : ""}`}>
      <section ref={stageRef} className="media-stage" aria-label="Fixed grid stage">
        <video ref={videoRef} className="share-video" poster={poster} muted playsInline />
        <AnnotationLayer stageRef={stageRef} videoRef={videoRef} strokes={[]} laserMarks={marks}
          activeTool="laser" color="#ff4d4f" onInstruction={send} />
      </section>
      <output className="surface-readout" data-point={lastPoint}>
        {lastPoint || "Point at a grid target"}
      </output>
    </main>
  );
}

const settle = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
});

function Lab() {
  const [sourceName, setSourceName] = useState(Object.keys(sources)[0]);
  const [senderName, setSenderName] = useState(Object.keys(sizes)[0]);
  const [receiverName, setReceiverName] = useState(Object.keys(sizes)[2]);
  const [chat, setChat] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState("Ready. Move the pointer over either grid, or run the matrix.");
  const sender = useRef<HTMLIFrameElement>(null);
  const receiver = useRef<HTMLIFrameElement>(null);
  const configure = useCallback(() => {
    for (const frame of [sender, receiver]) frame.current?.contentWindow?.postMessage({
      type: "configure", source: sources[sourceName], chat,
    }, location.origin);
  }, [sourceName, chat]);
  useEffect(configure, [configure]);

  useEffect(() => {
    const relay = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== "instruction") return;
      if (![sender.current?.contentWindow, receiver.current?.contentWindow].includes(event.source as Window)) return;
      // Exercise the wire representation and production parser on the recipient.
      const packet = JSON.parse(JSON.stringify(event.data));
      for (const frame of [sender, receiver]) frame.current?.contentWindow?.postMessage(packet, location.origin);
    };
    window.addEventListener("message", relay);
    return () => window.removeEventListener("message", relay);
  }, []);

  async function runMatrix() {
    setRunning(true);
    let checks = 0;
    const failures: string[] = [];
    const original = { sourceName, senderName, receiverName, chat };
    try {
      const names = Object.keys(sizes);
      for (const sourceKey of Object.keys(sources)) {
        setSourceName(sourceKey);
        for (let i = 0; i < names.length; i++) {
          setSenderName(names[i]);
          setReceiverName(names[(i + 1) % names.length]);
          for (const withChat of [false, true]) {
            setChat(withChat);
            // Wait for the production chat transition and ResizeObserver.
            await new Promise((resolve) => setTimeout(resolve, 280));
            await settle();
            const context = `${sourceKey}; ${names[i]} → ${names[(i + 1) % names.length]}; chat=${withChat}`;
            // A stationary mark must follow viewport / sidebar / metadata
            // changes without waiting for another incoming laser instruction.
            for (const ref of [sender, receiver]) {
              const doc = ref.current!.contentDocument!;
              const point = JSON.parse(doc.querySelector("output")!.dataset.point || "null");
              if (point) {
                checks++;
                try { assertDot(doc, point.x, point.y); }
                catch (error) { failures.push(`${context}; stationary resize; ${error}`); }
              }
            }
            for (const direction of [false, true]) {
              const from = (direction ? receiver : sender).current!.contentDocument!;
              const to = (direction ? sender : receiver).current!.contentDocument!;
              let previous: { x: number; y: number } | null = null;
              for (const y of [0.1, 0.5, 0.9]) for (const x of [0.1, 0.5, 0.9]) {
                const frame = visibleContent(from);
                const clientX = frame.left + x * frame.width;
                const clientY = frame.top + y * frame.height;
                // Hit-test the grid, not the overlay's own bounds: a displaced
                // input surface must fail rather than generate a self-consistent test.
                const hit = from.elementFromPoint(clientX, clientY);
                hit?.dispatchEvent(new PointerEvent("pointermove", {
                  bubbles: true, clientX, clientY, pointerId: 1, pointerType: "mouse",
                }));
                await settle();
                checks++;
                try {
                  const point = JSON.parse(to.querySelector("output")!.dataset.point || "null");
                  if (!point || Math.abs(point.x - x) > 0.002 || Math.abs(point.y - y) > 0.002) {
                    throw new Error(`wire point ${JSON.stringify(point)} ≠ (${x}, ${y})`);
                  }
                  assertDot(to, x, y);
                  assertDot(from, x, y);
                  if (previous) {
                    assertTrail(to, previous, { x, y });
                    assertTrail(from, previous, { x, y });
                  }
                } catch (error) {
                  failures.push(`${context}; ${direction ? "reverse" : "forward"}; ${error}`);
                }
                previous = { x, y };
              }
            }
            setReport(`${checks} checks completed; ${failures.length} failures…`);
          }
        }
      }
      setReport(`${checks - failures.length}/${checks} passed.\n${failures.join("\n") || "All grid targets, trails and stationary dots align in both directions, with and without chat."}`);
    } catch (error) {
      setReport(`Harness error: ${error}`);
    } finally {
      setSourceName(original.sourceName);
      setSenderName(original.senderName);
      setReceiverName(original.receiverName);
      setChat(original.chat);
      setRunning(false);
    }
  }

  return (
    <main className="laser-lab">
      <h1>Laser coordinate lab</h1>
      <p>Two browser viewports, one fixed grid. Uses the production video layout, pointer input and laser renderer. No screen capture or backend.</p>
      <p>The last dot stays visible for inspection. Preview panels are scaled; measurements use full viewport pixels.</p>
      <fieldset disabled={running}>
        <label>Shared content<select value={sourceName} onChange={(e) => setSourceName(e.target.value)}>{Object.keys(sources).map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Sender viewport<select value={senderName} onChange={(e) => setSenderName(e.target.value)}>{Object.keys(sizes).map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Recipient viewport<select value={receiverName} onChange={(e) => setReceiverName(e.target.value)}>{Object.keys(sizes).map((name) => <option key={name}>{name}</option>)}</select></label>
        <label><input type="checkbox" checked={chat} onChange={(e) => setChat(e.target.checked)} /> Open chat sidebar</label>
        <button onClick={() => void runMatrix()}>Run regression matrix</button>
      </fieldset>
      <div className="lab-previews">
        {([["Sender", sender, senderName], ["Recipient", receiver, receiverName]] as const).map(([label, ref, sizeName]) => {
          const size = sizes[sizeName];
          const scale = Math.min(480 / size.width, 360 / size.height);
          return <section key={label}>
            <h2>{label} <small>{size.width} × {size.height}</small></h2>
            <div className="lab-preview" style={{ width: size.width * scale, height: size.height * scale }}>
              <iframe ref={ref} title={`${label} grid`} src="?surface=1" onLoad={configure}
                style={{ width: size.width, height: size.height, transform: `scale(${scale})` }} />
            </div>
          </section>;
        })}
      </div>
      <pre role="status" aria-live="polite">{report}</pre>
    </main>
  );
}

// Independent oracle: measure the actual media element, never AnnotationLayer's
// computed frame. Browser object-fit centers the grid inside this element.
function visibleContent(doc: Document) {
  const video = doc.querySelector("video")!;
  const box = video.getBoundingClientRect();
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

function assertDot(doc: Document, x: number, y: number) {
  const frame = visibleContent(doc);
  const dot = doc.querySelector(".laser-dot");
  if (!dot) throw new Error("missing laser dot");
  const box = dot.getBoundingClientRect();
  const error = Math.hypot(box.left + box.width / 2 - (frame.left + x * frame.width),
    box.top + box.height / 2 - (frame.top + y * frame.height));
  if (error > 1) throw new Error(`dot (${x}, ${y}) displaced by ${error.toFixed(2)}px`);
}

function assertTrail(doc: Document, from: { x: number; y: number }, to: { x: number; y: number }) {
  const segment = doc.querySelector<SVGLineElement>(".laser-segment:last-child");
  const matrix = segment?.getScreenCTM();
  if (!segment || !matrix) throw new Error("missing laser trail");
  const frame = visibleContent(doc);
  for (const [point, x, y] of [
    [from, segment.x1.baseVal.value, segment.y1.baseVal.value],
    [to, segment.x2.baseVal.value, segment.y2.baseVal.value],
  ] as const) {
    const actual = new DOMPoint(x, y).matrixTransform(matrix);
    const error = Math.hypot(actual.x - (frame.left + point.x * frame.width),
      actual.y - (frame.top + point.y * frame.height));
    if (error > 1) throw new Error(`trail endpoint displaced by ${error.toFixed(2)}px`);
  }
}

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("surface") ? <Surface /> : <Lab />,
);
