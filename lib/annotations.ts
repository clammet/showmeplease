export const ANNOTATION_COLORS = ["#ff4d4f", "#f6c344", "#34c759", "#3b82f6"] as const;

export const MAX_DRAWING_STROKES = 300;
export const MAX_POINTS_PER_STROKE = 2048;
export const MAX_POINTS_PER_APPEND = 64;
export const MAX_TOTAL_DRAWING_POINTS = 20_000;

export type AnnotationPoint = {
  x: number;
  y: number;
};

export type DrawingStroke = {
  id: string;
  ownerId: string;
  color: string;
  points: AnnotationPoint[];
  complete: boolean;
};

export type DrawingInstruction =
  | {
      kind: "stroke-start";
      strokeId: string;
      color: string;
      point: AnnotationPoint;
    }
  | {
      kind: "stroke-add";
      strokeId: string;
      points: AnnotationPoint[];
    }
  | {
      kind: "stroke-end";
      strokeId: string;
    }
  | {
      kind: "laser-move";
      color: string;
      point: AnnotationPoint;
    }
  | {
      kind: "clear";
    };

const STROKE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function isAnnotationColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

export function parseAnnotationPoint(value: unknown): AnnotationPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.x !== "number" ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.x) ||
    !Number.isFinite(candidate.y) ||
    candidate.x < 0 ||
    candidate.x > 1 ||
    candidate.y < 0 ||
    candidate.y > 1
  ) {
    return null;
  }
  return { x: candidate.x, y: candidate.y };
}

/** Strict parser for the only vector instructions clients may send. */
export function parseDrawingInstruction(value: unknown): DrawingInstruction | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.kind === "clear") return { kind: "clear" };

  if (candidate.kind === "laser-move") {
    const point = parseAnnotationPoint(candidate.point);
    if (!point || !isAnnotationColor(candidate.color)) return null;
    return { kind: "laser-move", color: candidate.color, point };
  }

  if (typeof candidate.strokeId !== "string" || !STROKE_ID_PATTERN.test(candidate.strokeId)) {
    return null;
  }

  if (candidate.kind === "stroke-start") {
    const point = parseAnnotationPoint(candidate.point);
    if (!point || !isAnnotationColor(candidate.color)) return null;
    return {
      kind: "stroke-start",
      strokeId: candidate.strokeId,
      color: candidate.color,
      point,
    };
  }

  if (candidate.kind === "stroke-add") {
    if (!Array.isArray(candidate.points) || candidate.points.length > MAX_POINTS_PER_APPEND) {
      return null;
    }
    const points: AnnotationPoint[] = [];
    for (const valuePoint of candidate.points) {
      const point = parseAnnotationPoint(valuePoint);
      if (!point) return null;
      points.push(point);
    }
    if (!points.length) return null;
    return { kind: "stroke-add", strokeId: candidate.strokeId, points };
  }

  if (candidate.kind === "stroke-end") {
    return { kind: "stroke-end", strokeId: candidate.strokeId };
  }

  return null;
}

/** Apply one instruction to a client-side vector snapshot. */
export function applyDrawingInstruction(
  strokes: DrawingStroke[],
  instruction: DrawingInstruction,
  ownerId: string,
): DrawingStroke[] {
  if (instruction.kind === "clear") return [];
  if (instruction.kind === "laser-move") return strokes;

  if (instruction.kind === "stroke-start") {
    if (strokes.some((stroke) => stroke.id === instruction.strokeId)) return strokes;
    const room = Math.max(0, MAX_DRAWING_STROKES - 1);
    return [
      ...strokes.slice(-room),
      {
        id: instruction.strokeId,
        ownerId,
        color: instruction.color,
        points: [instruction.point],
        complete: false,
      },
    ];
  }

  const index = strokes.findIndex((stroke) => stroke.id === instruction.strokeId);
  if (index === -1) return strokes;
  const stroke = strokes[index];
  if (stroke.ownerId !== ownerId || stroke.complete) return strokes;

  const updated = [...strokes];
  if (instruction.kind === "stroke-add") {
    const available = Math.max(0, MAX_POINTS_PER_STROKE - stroke.points.length);
    if (!available) return strokes;
    updated[index] = {
      ...stroke,
      points: [...stroke.points, ...instruction.points.slice(0, available)],
    };
  } else {
    updated[index] = { ...stroke, complete: true };
  }
  return updated;
}
