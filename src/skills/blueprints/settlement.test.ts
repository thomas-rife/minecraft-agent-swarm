import assert from "node:assert/strict";
import test from "node:test";
import { SETTLEMENT_BLUEPRINTS } from "./settlement.js";

for (const [name, blueprint] of Object.entries(SETTLEMENT_BLUEPRINTS)) {
  test(`${name} blueprint has unique, in-bounds blocks and accurate materials`, () => {
    const positions = new Set<string>();
    const counted: Record<string, number> = {};

    for (const block of blueprint.blocks) {
      const key = block.pos.join(",");
      assert.equal(positions.has(key), false, `duplicate block at ${key}`);
      positions.add(key);

      assert.ok(block.pos[0] >= 0 && block.pos[0] < blueprint.dimensions[0], `x out of bounds at ${key}`);
      assert.ok(block.pos[1] >= 0 && block.pos[1] < blueprint.dimensions[1], `y out of bounds at ${key}`);
      assert.ok(block.pos[2] >= 0 && block.pos[2] < blueprint.dimensions[2], `z out of bounds at ${key}`);
      counted[block.block] = (counted[block.block] ?? 0) + 1;
    }

    assert.deepEqual(blueprint.materials, counted);
    assert.ok(blueprint.blocks.length < 200, "blueprint should fit the resumable skill budget");
  });
}
