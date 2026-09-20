"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type {
  AnnotationPoint,
  DrawingInstruction,
  DrawingStroke,
} from "@/lib/annotations";

import {
  LASER_DOT_SIZE_PX,
  LASER_TRAIL_WIDTH_PX,
  LASER_TRAIL_HISTORY_MS,
  LASER_SAMPLE_INTERVAL_MS,
  latestLaserMarks,
  laserSegments,
  type LaserMark,
} from "@/lib/laser";

export type AnnotationTool = "laser" | "pencil" | null;

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
  const lastLaser = useRef<{ point: AnnotationPoint; at: number; trailId: string } | null>(null);

  useEffect(() => {
    lastLaser.current = null;
  }, [activeTool, color]);

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
    const trailId = previous && now - previous.at < LASER_TRAIL_HISTORY_MS
      ? previous.trailId
      : crypto.randomUUID();
    if (onInstruction({ kind: "laser-move", trailId, color, point })) {
      lastLaser.current = { point, at: now, trailId };
    }
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

  const latestBySender = latestLaserMarks(laserMarks);

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
        onPointerUp={(event) => {
          finishStroke(event);
          if (event.pointerType !== "mouse") lastLaser.current = null;
        }}
        onPointerLeave={() => { lastLaser.current = null; }}
        onPointerCancel={(event) => {
          finishStroke(event);
          lastLaser.current = null;
        }}
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
        <svg className="laser-trail" viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`} preserveAspectRatio="none">
          {laserSegments(laserMarks).map(({ from, to }) => (
            <line
              key={to.id}
              className="laser-segment"
              x1={from.point.x * SVG_SIZE}
              y1={from.point.y * SVG_SIZE}
              x2={to.point.x * SVG_SIZE}
              y2={to.point.y * SVG_SIZE}
              stroke={to.color}
              strokeWidth={LASER_TRAIL_WIDTH_PX}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              style={{
                animationDuration: `${LASER_TRAIL_HISTORY_MS}ms`,
                // Stable for this segment: rerenders must not restart its fade.
                animationDelay: `${from.at - to.at}ms`,
              }}
            />
          ))}
        </svg>
        {Array.from(latestBySender.values()).map((mark) => {
          const position = {
            left: `${mark.point.x * 100}%`,
            top: `${mark.point.y * 100}%`,
          };
          return (
            <span
              key={mark.id}
              className="laser-dot"
              style={{
                ...position,
                width: LASER_DOT_SIZE_PX,
                height: LASER_DOT_SIZE_PX,
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
