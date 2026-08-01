import test from "node:test";
import assert from "node:assert/strict";
import { snapshotBlockPosition, stashPlacementOffsets } from "./setup-stash.js";

test("stash placement search starts at the canonical anchor and expands by distance", () => {
  const offsets = stashPlacementOffsets(2);
  assert.deepEqual(offsets[0], { dx: 0, dz: 0 });
  assert.equal(offsets.length, 25);
  for (let index = 1; index < offsets.length; index++) {
    const previous = Math.abs(offsets[index - 1].dx) + Math.abs(offsets[index - 1].dz);
    const current = Math.abs(offsets[index].dx) + Math.abs(offsets[index].dz);
    assert.ok(current >= previous);
  }
});

test("stash completion snapshots block coordinates before the container invalidates its block", () => {
  let livePosition: { x: number; y: number; z: number } | null = { x: 116, y: 66, z: 256 };
  const snapshot = snapshotBlockPosition(livePosition, { x: 0, y: 0, z: 0 });
  livePosition = null;
  assert.deepEqual(snapshot, { x: 116, y: 66, z: 256 });
  assert.equal(livePosition, null);
});

test("stash completion falls back to the canonical coordinates for a positionless block", () => {
  assert.deepEqual(snapshotBlockPosition(null, { x: 116, y: 66, z: 256 }), { x: 116, y: 66, z: 256 });
});