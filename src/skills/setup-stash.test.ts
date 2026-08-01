import test from "node:test";
import assert from "node:assert/strict";
import { stashPlacementOffsets } from "./setup-stash.js";

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
