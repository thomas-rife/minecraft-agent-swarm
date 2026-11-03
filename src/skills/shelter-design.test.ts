import assert from "node:assert/strict";
import test from "node:test";
import { decodeShelterDesign, encodeShelterDesign, normalizeShelterDesign, shelterBlueprint } from "./shelter-design.js";

test("shelter design is bounded and survives structure-note encoding", () => {
  const design = normalizeShelterDesign({ name: "Cliff Hut!", width: 20, depth: 2, wallHeight: 8, doorSide: "west", windows: false });
  assert.deepEqual(design, { name: "Cliff Hut", width: 5, depth: 4, wallHeight: 3, doorSide: "west", windows: false });
  assert.deepEqual(decodeShelterDesign(`partial [shelter-design:${encodeShelterDesign(design)}]`), design);
});

test("generated shelter has a full floor and roof with a two-block entrance", () => {
  const design = normalizeShelterDesign({ name: "Test Hut", width: 4, depth: 5, wallHeight: 2, doorSide: "south", windows: true });
  const blueprint = shelterBlueprint(design);
  const positions = new Set(blueprint.blocks.map((block) => block.pos.join(",")));
  for (let x = 0; x < 4; x++) for (let z = 0; z < 5; z++) {
    assert.ok(positions.has(`${x},0,${z}`));
    assert.ok(positions.has(`${x},3,${z}`));
  }
  assert.ok(!positions.has("2,1,4"));
  assert.ok(!positions.has("2,2,4"));
});
