"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type {
  AnnotationPoint,
  DrawingInstruction,
  DrawingStroke,
} from "@/lib/annotations";

export type AnnotationTool = "laser" | "pencil" | null;

// Laser tuning: fixed pixel sizes keep the dots circular at every video aspect ratio.
export const LASER_DOT_SIZE_PX = 10;
export const LASER_AFTERIMAGE_SIZE_PX = 6;
export const LASER_TRAIL_HISTORY_MS = 1000;
export const LASER_POINTER_IDLE_DURATION_MS = 1000;
export const LASER_CLOCK_INTERVAL_MS = 33;
export const LASER_SAMPLE_INTERVAL_MS = 16;

export type LaserMark = {
  id: number;
  senderId: string;
  color: string;
  point: AnnotationPoint;
  at: number;
};

type Frame = { left: number; top: number; width: number; height: number };

const SVG_SIZE = 1000;

function videoFrame(stage: HTMLElement, video: HTMLVideoElement): Frame | null {
  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;
  if (!stageWidth || !stageHeight || !video.videoWidth || !video.videoHeight) return null;

  const videoRatio = video.videoWidth / video.videoHeight;
  const stageRatio = stageWidth / stageHeight;
  if (stageRatio > videoRatio) {
    const width = stageHeight * videoRatio;
    return { left: (stageWidth - width) / 2, top: 0, width, height: stageHeight };
  }
  const height = stageWidth / videoRatio;
  return { left: 0, top: (stageHeight - height) / 2, width: stageWidth, height };
}

function eventPoint(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  bounds: DOMRect,
): AnnotationPoint {
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
}

function strokePath(points: AnnotationPoint[]) {
  if (!points.length) return "";
  const values = points.map((point) => `${point.x * SVG_SIZE} ${point.y * SVG_SIZE}`);
  if (values.length === 1) return `M ${values[0]} L ${values[0]}`;
  return `M ${values.join(" L ")}`;
}

export default function AnnotationLayer({
  stageRef,
  videoRef,
  strokes,
  laserMarks,
  activeTool,
  color,
  onInstruction,
}: {
  stageRef: RefObject<HTMLElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  strokes: DrawingStroke[];
  laserMarks: LaserMark[];
  activeTool: AnnotationTool;
  color: string;
  onInstruction: (instruction: DrawingInstruction) => boolean;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const activeStroke = useRef<{ id: string; pointerId: number } | null>(null);
  const lastPencilPoint = useRef<AnnotationPoint | null>(null);
  const lastLaser = useRef<{ point: AnnotationPoint; at: number } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return;
    const update = () => setFrame(videoFrame(stage, video));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
    };
  }, [stageRef, videoRef]);

  useEffect(() => {
    if (activeTool === "pencil" || !activeStroke.current) return;
    onInstruction({ kind: "stroke-end", strokeId: activeStroke.current.id });
    activeStroke.current = null;
    lastPencilPoint.current = null;
  }, [activeTool, onInstruction]);

  const sendLaser = (point: AnnotationPoint) => {
    const now = performance.now();
    const previous = lastLaser.current;
    if (
      previous &&
      now - previous.at < LASER_SAMPLE_INTERVAL_MS &&
      Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < 0.003
    ) {
      return;
    }
    lastLaser.current = { point, at: now };
    onInstruction({ kind: "laser-move", color, point });
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !activeTool) return;
    event.preventDefault();
    const point = eventPoint(event, event.currentTarget.getBoundingClientRect());
    if (activeTool === "laser") {
      sendLaser(point);
      return;
    }
    const id = crypto.randomUUID();
    if (!onInstruction({ kind: "stroke-start", strokeId: id, color, point })) return;
    activeStroke.current = { id, pointerId: event.pointerId };
    lastPencilPoint.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!activeTool) return;
    if (activeTool === "laser") {
      sendLaser(eventPoint(event, event.currentTarget.getBoundingClientRect()));
      return;
    }
    if (activeStroke.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nativeEvents = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const bounds = event.currentTarget.getBoundingClientRect();
    const points: AnnotationPoint[] = [];
    let previous = lastPencilPoint.current;
    for (const nativeEvent of nativeEvents) {
      const point = eventPoint(nativeEvent, bounds);
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.0005) {
        points.push(point);
        previous = point;
      }
    }
    if (!points.length) return;
    lastPencilPoint.current = points[points.length - 1];
    onInstruction({
      kind: "stroke-add",
      strokeId: activeStroke.current.id,
      points: points.slice(-64),
    });
  };

  const finishStroke = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drawing = activeStroke.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    onInstruction({ kind: "stroke-end", strokeId: drawing.id });
    activeStroke.current = null;
    lastPencilPoint.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!frame) return null;

  const latestBySender = new Map<string, LaserMark>();
  for (const mark of laserMarks) {
    const latest = latestBySender.get(mark.senderId);
    if (!latest || mark.at > latest.at || (mark.at === latest.at && mark.id > latest.id)) {
      latestBySender.set(mark.senderId, mark);
    }
  }

  return (
    <>
      <svg
        className={`annotation-layer ${activeTool ? `tool-${activeTool}` : ""}`}
        style={frame}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        preserveAspectRatio="none"
        aria-label={activeTool ? `${activeTool} annotation surface` : "Shared annotations"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      >
        <g className="pencil-strokes">
          {strokes.map((stroke) => (
            <path
              key={stroke.id}
              d={strokePath(stroke.points)}
              fill="none"
              stroke={stroke.color}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      </svg>
      <div className="laser-layer" style={frame} aria-hidden="true">
        {laserMarks.map((mark) => {
          const latest = latestBySender.get(mark.senderId);
          if (!latest) return null;
          const newest = latest.id === mark.id;
          const historyAge = latest.at - mark.at;
          if (historyAge > LASER_TRAIL_HISTORY_MS) return null;
          const size = newest ? LASER_DOT_SIZE_PX : LASER_AFTERIMAGE_SIZE_PX;
          const position = {
            left: `${mark.point.x * 100}%`,
            top: `${mark.point.y * 100}%`,
          };
          return (
            <span
              key={mark.id}
              className={newest ? "laser-dot" : "laser-afterimage"}
              style={{
                ...position,
                width: size,
                height: size,
                color: mark.color,
                backgroundColor: mark.color,
              }}
            />
          );
        })}
      </div>
    </>
  );
}
