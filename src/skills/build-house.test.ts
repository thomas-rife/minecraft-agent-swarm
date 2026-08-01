import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { houseBlueprint } from "./blueprints/house.js";
import { missingHouseBlueprintBlocks, verifyHouseBlueprint } from "./build-house.js";

function blueprintBot(overrides = new Map<string, string>()) {
  return {
    blockAt(position: Vec3) {
      const key = `${position.x},${position.y},${position.z}`;
      const name = overrides.get(key) ?? "air";
      return { name, position };
    },
  } as any;
}

test("house entrance verification checks blueprint door blocks, not the outside navigation point", () => {
  const origin = new Vec3(10, 64, 20);
  const blocks = new Map<string, string>();
  for (const block of houseBlueprint.blocks) {
    const position = origin.offset(block.pos[0], block.pos[1], block.pos[2]);
    blocks.set(`${position.x},${position.y},${position.z}`, block.block);
  }
  const result = verifyHouseBlueprint(blueprintBot(blocks), origin);
  assert.equal(result.find((condition) => condition.name === "house_entrance_present")?.satisfied, true);
});

test("house repair derives only missing blueprint blocks", () => {
  const origin = new Vec3(0, 64, 0);
  const blocks = new Map<string, string>();
  for (const block of houseBlueprint.blocks) {
    const position = origin.offset(block.pos[0], block.pos[1], block.pos[2]);
    blocks.set(`${position.x},${position.y},${position.z}`, block.block);
  }
  blocks.delete("2,65,0");
  const missing = missingHouseBlueprintBlocks(blueprintBot(blocks), origin);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].block, "oak_door");
});
