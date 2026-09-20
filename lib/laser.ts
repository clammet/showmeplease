import type { AnnotationPoint } from "./annotations";

export const LASER_DOT_SIZE_PX = 10;
export const LASER_TRAIL_WIDTH_PX = 5;
export const LASER_TRAIL_HISTORY_MS = 1000;
export const LASER_POINTER_IDLE_DURATION_MS = 1000;
export const LASER_CLOCK_INTERVAL_MS = 33;
export const LASER_SAMPLE_INTERVAL_MS = 16;
export const MAX_LASER_MARKS_PER_SENDER = 512;

export type LaserMark = {
  id: number;
  senderId: string;
  trailId?: string;
  color: string;
  point: AnnotationPoint;
  at: number;
};

export function latestLaserMarks(marks: LaserMark[]) {
  const latest = new Map<string, LaserMark>();
  for (const mark of marks) latest.set(mark.senderId, mark);
  return latest;
}

export function pruneLaserMarks(marks: LaserMark[], now: number) {
  const latest = latestLaserMarks(marks);
  const next = marks.filter((mark) => {
    const lifetime = latest.get(mark.senderId)?.id === mark.id
      ? LASER_POINTER_IDLE_DURATION_MS
      : LASER_TRAIL_HISTORY_MS;
    return now - mark.at < lifetime;
  });
  return next.length === marks.length ? marks : next;
}

export function appendLaserMark(marks: LaserMark[], mark: LaserMark) {
  const next = pruneLaserMarks([...marks, mark], mark.at);
  let excess = next.filter((candidate) => candidate.senderId === mark.senderId).length - MAX_LASER_MARKS_PER_SENDER;
  // Bound each participant independently, retaining their newest samples.
  if (excess <= 0) return next;
  return next.filter((candidate) => candidate.senderId !== mark.senderId || excess-- <= 0);
}

export function laserSegments(marks: LaserMark[]) {
  const previousBySender = new Map<string, LaserMark>();
  const segments: { from: LaserMark; to: LaserMark }[] = [];
  for (const mark of marks) {
    const previous = previousBySender.get(mark.senderId);
    if (previous && mark.trailId && previous.trailId === mark.trailId &&
      previous.color === mark.color && mark.at - previous.at < LASER_TRAIL_HISTORY_MS) {
      segments.push({ from: previous, to: mark });
    }
    previousBySender.set(mark.senderId, mark);
  }
  return segments;
}
