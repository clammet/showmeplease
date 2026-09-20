import assert from "node:assert/strict";
import test from "node:test";
import { parseDrawingInstruction } from "../lib/annotations.ts";
import {
  appendLaserMark,
  laserSegments,
  MAX_LASER_MARKS_PER_SENDER,
  pruneLaserMarks,
} from "../lib/laser.ts";

const mark = (id, overrides = {}) => ({
  id, senderId: "alice", trailId: "trail-1", color: "#ff4d4f",
  point: { x: id / 1000, y: 0.5 }, at: id,
  ...overrides,
});

test("laser trail IDs survive parsing and reject malformed values", () => {
  const instruction = {
    kind: "laser-move", trailId: "trail-1", color: "#ff4d4f", point: { x: 0.2, y: 0.4 },
  };
  assert.deepEqual(parseDrawingInstruction(instruction), instruction);
  for (const trailId of [null, 123, "", "x".repeat(81), "bad id"]) {
    assert.equal(parseDrawingInstruction({ ...instruction, trailId }), null);
  }
  const { trailId, ...legacy } = instruction;
  assert.ok(trailId);
  assert.deepEqual(parseDrawingInstruction(legacy), legacy);
});

test("segments connect only consecutive samples in the same participant's trail", () => {
  const marks = [
    mark(1), mark(2, { senderId: "bob" }), mark(3),
    mark(4, { trailId: "trail-2" }), mark(5, { trailId: "trail-2" }),
    mark(6, { trailId: "trail-2", color: "#34c759" }),
    mark(7, { trailId: "trail-2", color: "#34c759", at: 1006 }),
    mark(8, { trailId: undefined }), mark(9, { trailId: undefined }),
  ];
  assert.deepEqual(laserSegments(marks).map(({ from, to }) => [from.id, to.id]), [[1, 3], [4, 5]]);
});

test("laser history and stationary heads expire after 1000 ms", () => {
  const marks = [mark(0), mark(16), mark(32, { senderId: "bob" })];
  assert.equal(pruneLaserMarks(marks, 999), marks);
  assert.deepEqual(pruneLaserMarks(marks, 1000).map((entry) => entry.id), [16, 32]);
  assert.deepEqual(pruneLaserMarks(marks, 1032), []);
  assert.deepEqual(appendLaserMark(marks, mark(1050)), [mark(1050)]);
});

test("one participant reaching the point cap does not evict another's trail", () => {
  const bob = mark(0, { senderId: "bob" });
  let marks = [bob];
  for (let id = 1; id <= MAX_LASER_MARKS_PER_SENDER + 1; id++) {
    marks = appendLaserMark(marks, mark(id));
  }
  assert.equal(marks.length, MAX_LASER_MARKS_PER_SENDER + 1);
  assert.equal(marks[0], bob);
  assert.equal(marks[1].id, 2);
  assert.equal(marks.at(-1).id, MAX_LASER_MARKS_PER_SENDER + 1);
});
