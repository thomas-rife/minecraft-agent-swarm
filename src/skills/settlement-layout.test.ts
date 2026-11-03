import assert from "node:assert/strict";
import test from "node:test";
import { warehouseBlueprint } from "./blueprints/warehouse.js";
import { workshopBlueprint } from "./blueprints/workshop.js";
import {
  footprintAtCenter,
  footprintsOverlap,
  preferredCenter,
  preferredHouseCenter,
  preferredMineEntrance,
} from "./settlement-layout.js";

const house = { x: 181, z: 170 };

test("house zone is derived from the shared settlement anchor", () => {
  assert.deepEqual(preferredHouseCenter({ x: 132, z: 179 }), { x: 132, z: 167 });
});

test("settlement structures are centered twenty blocks on opposite sides of the house", () => {
  const warehouse = preferredCenter("warehouse", house);
  const workshop = preferredCenter("workshop", house);

  assert.deepEqual(warehouse, { x: 165, z: 174 });
  assert.deepEqual(workshop, { x: 205, z: 174 });
});

test("relative warehouse and workshop footprints do not overlap the 9x9 lodge", () => {
  const houseFootprint = { x: house.x, z: house.z, width: 9, depth: 9 };
  const warehouse = footprintAtCenter(preferredCenter("warehouse", house), warehouseBlueprint);
  const workshop = footprintAtCenter(preferredCenter("workshop", house), workshopBlueprint);

  assert.equal(footprintsOverlap(houseFootprint, warehouse), false);
  assert.equal(footprintsOverlap(houseFootprint, workshop), false);
  assert.equal(footprintsOverlap(warehouse, workshop), false);
});

test("shared mine entrance is derived from the anchor outside the building yard", () => {
  const mine = preferredMineEntrance({ x: 132, z: 179 });
  assert.deepEqual(mine, { x: 104, z: 203 });
  assert.ok(Math.hypot(mine.x - 132, mine.z - 179) < 48);
});
