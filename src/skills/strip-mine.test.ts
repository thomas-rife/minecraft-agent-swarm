import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { mineNotes, parseMineResume, parseMineRuns, shouldResumeFromCurrentPosition } from "./strip-mine.js";

test("partial shared-mine notes preserve both branch count and exact resume point", () => {
  const notes = mineNotes("partial", 3, new Vec3(104.8, 37.9, 221.2));

  assert.equal(parseMineRuns(notes), 3);
  assert.deepEqual(parseMineResume(notes), new Vec3(104, 37, 221));
  assert.match(notes, /status=partial/);
});

test("completed shared-mine notes clear a stale resume point", () => {
  const notes = mineNotes("complete", 4, new Vec3(1, 2, 3));

  assert.equal(parseMineRuns(notes), 4);
  assert.equal(parseMineResume(notes), undefined);
  assert.match(notes, /status=complete/);
});

test("an underground worker resumes in place even after the mine is marked complete", () => {
  const entrance = new Vec3(105, 65, 203);
  assert.equal(shouldResumeFromCurrentPosition(new Vec3(97, 16, 205), entrance), true);
  assert.equal(shouldResumeFromCurrentPosition(new Vec3(105, 64, 203), entrance), false);
  assert.equal(shouldResumeFromCurrentPosition(new Vec3(250, 16, 205), entrance), false);
});
