import test from "node:test";
import assert from "node:assert/strict";
import { craftGearSkill } from "./craft-gear.js";

function botWith(items: Array<{ name: string; count: number }>, tableNearby = false) {
  return {
    inventory: { items: () => items },
    findBlock: () => (tableNearby ? { name: "crafting_table" } : null),
  } as any;
}

test("craft_gear queues enough generic logs for an empty-inventory wooden pickaxe", () => {
  assert.deepEqual(craftGearSkill.estimateMaterials(botWith([]), {}), { log: 3 });
});

test("craft_gear material target accounts for logs already held", () => {
  assert.deepEqual(craftGearSkill.estimateMaterials(botWith([{ name: "birch_log", count: 1 }]), {}), { log: 3 });
});

test("craft_gear skips gathering when intermediates satisfy the dependency tree", () => {
  assert.deepEqual(
    craftGearSkill.estimateMaterials(
      botWith(
        [
          { name: "spruce_planks", count: 3 },
          { name: "stick", count: 2 },
        ],
        true,
      ),
      {},
    ),
    {},
  );
});

test("craft_gear skips bootstrap gathering when a pickaxe already exists", () => {
  assert.deepEqual(craftGearSkill.estimateMaterials(botWith([{ name: "wooden_pickaxe", count: 1 }]), {}), {});
});
