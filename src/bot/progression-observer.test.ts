import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { BotMemoryStore } from "./memory.js";
import { registerBotMemory, unregisterBotMemory } from "./memory-registry.js";
import { observeProgression } from "./progression-observer.js";
import { encodeShelterDesign, shelterBlueprint, type ShelterDesign } from "../skills/shelter-design.js";

test("crafting tables count at remote work sites while settlement stations stay local", () => {
  const origin = { x: 0, y: 70, z: 0 };
  const workSite = { x: 100, y: 70, z: 100 };
  let stationPosition: { x: number; y: number; z: number } | null = { ...origin };
  const bot = {
    health: 20,
    entity: { position: { ...origin } },
    inventory: { items: () => [] },
    findBlock: (options: {
      matching: (block: unknown) => boolean;
      useExtraInfo: (block: unknown) => boolean;
      maxDistance: number;
    }) => {
      // Mineflayer checks its section palette before examining positioned blocks.
      for (const name of ["crafting_table", "furnace"]) {
        if (!options.matching({ name, position: null })) continue;
        const block = { name, position: stationPosition };
        if (!options.useExtraInfo(block) || !stationPosition) continue;
        const position = bot.entity.position;
        if (
          Math.hypot(
            stationPosition.x - position.x,
            stationPosition.y - position.y,
            stationPosition.z - position.z,
          ) <= options.maxDistance
        )
          return block;
      }
      return null;
    },
  } as unknown as Bot;
  const store = {
    getStructures: () => [],
    getSkillHistory: () => [{ skill: "smelt_ores", success: true, notes: "Smelting done! Got: iron_ingot" }],
    getProgressionStorage: () => ({ deposited: false, retrieved: false }),
  } as unknown as BotMemoryStore;
  registerBotMemory(bot, store);
  try {
    assert.equal(observeProgression(bot, origin).craftingStation, true);
    assert.equal(observeProgression(bot, origin).operatedFurnace, true);
    stationPosition = { ...workSite };
    assert.equal(observeProgression(bot, origin).craftingStation, false);
    Object.assign(bot.entity.position, workSite);
    assert.equal(observeProgression(bot, origin).craftingStation, true);
    assert.equal(observeProgression(bot, origin).operatedFurnace, false);
    stationPosition = null;
    assert.equal(observeProgression(bot, origin).craftingStation, false);
  } finally {
    unregisterBotMemory(bot);
  }
});

test("shelter verification inspects live blocks, rejects missing roof, unloaded chunks, and blocked interior", () => {
  const origin = { x: 0, y: 70, z: 0 };
  const design: ShelterDesign = { name: "Test Cabin", width: 4, depth: 5, wallHeight: 2, doorSide: "south", windows: true };
  const houseBlueprint = shelterBlueprint(design);
  const world = new Map(houseBlueprint.blocks.map((block) => [block.pos.join(","), block.block]));
  let loaded = true;
  const bot = {
    health: 20,
    entity: { position: origin },
    inventory: { items: () => [] },
    findBlock: () => null,
    blockAt: (position: { x: number; y: number; z: number }) =>
      loaded ? { name: world.get(`${position.x},${position.y - 70},${position.z}`) ?? "air" } : null,
  } as unknown as Bot;
  const store = {
    getStructures: () => [{ type: "house", ...origin, notes: `Claimed complete [shelter-design:${encodeShelterDesign(design)}]` }],
    getSkillHistory: () => [],
    getProgressionStorage: () => ({ deposited: false, retrieved: false }),
  } as unknown as BotMemoryStore;
  registerBotMemory(bot, store);
  try {
    assert.equal(observeProgression(bot, origin).shelter, true);
    world.delete("3,3,3");
    assert.equal(observeProgression(bot, origin).shelter, false);
    world.set("3,3,3", "oak_planks");
    world.set("1,1,2", "stone");
    assert.equal(observeProgression(bot, origin).shelter, false);
    world.delete("1,1,2");
    loaded = false;
    assert.equal(observeProgression(bot, origin).shelter, false);
  } finally {
    unregisterBotMemory(bot);
  }
});
