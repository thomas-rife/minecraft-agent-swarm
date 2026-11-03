import assert from "node:assert/strict";
import test from "node:test";
import { houseBlueprint } from "./house.js";

test("shared starter lodge is a valid 9x9 resumable blueprint", () => {
  assert.deepEqual(houseBlueprint.dimensions, [9, 5, 9]);
  assert.match(houseBlueprint.name, /Settlement Starter Lodge/);

  const positions = new Set<string>();
  const counted: Record<string, number> = {};
  for (const block of houseBlueprint.blocks) {
    const key = block.pos.join(",");
    assert.equal(positions.has(key), false, `duplicate block at ${key}`);
    positions.add(key);
    assert.ok(block.pos[0] >= 0 && block.pos[0] < 9, `x out of bounds at ${key}`);
    assert.ok(block.pos[1] >= 0 && block.pos[1] < 5, `y out of bounds at ${key}`);
    assert.ok(block.pos[2] >= 0 && block.pos[2] < 9, `z out of bounds at ${key}`);
    counted[block.block] = (counted[block.block] ?? 0) + 1;
  }

  assert.deepEqual(houseBlueprint.materials, counted);
  assert.ok(houseBlueprint.blocks.length > 200, "lodge should still be a substantial shared starter building");
  assert.deepEqual(houseBlueprint.entrance, { pos: [4, 1, 9], facing: "south" });
});
