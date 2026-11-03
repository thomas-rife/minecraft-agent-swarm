import { test } from "node:test";
import assert from "node:assert/strict";
import { getTechTreeLine } from "./curriculum.js";

function botWith(items: Array<{ name: string; count: number }>, nearbyTable = false) {
  return {
    inventory: { items: () => items },
    findBlock: () => (nearbyTable ? { name: "crafting_table" } : null),
  } as any;
}

test("a crafted wooden tool proves wood and crafting-table milestones", () => {
  const line = getTechTreeLine(botWith([{ name: "wooden_pickaxe", count: 1 }]));
  assert.match(line, /NEXT MILESTONE: stone tools/);
  assert.doesNotMatch(line, /NEXT MILESTONE: (wood|crafting table)/);
});

test("higher-tier tools satisfy lower tool milestones after materials are spent", () => {
  const line = getTechTreeLine(botWith([{ name: "stone_pickaxe", count: 1 }]));
  assert.match(line, /NEXT MILESTONE: furnace/);
});

test("a nearby placed table satisfies the crafting-table milestone", () => {
  const line = getTechTreeLine(botWith([{ name: "oak_planks", count: 1 }], true));
  assert.match(line, /NEXT MILESTONE: wooden tools/);
});

test("Flora's completed hoe prevents regression to gathering hoe wood", () => {
  const line = getTechTreeLine(botWith([{ name: "wooden_hoe", count: 1 }]), "Farmer / Crafter");
  assert.match(line, /NEXT MILESTONE: seeds/);
});
