import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import type { Blueprint, BlueprintBlock, Skill, SkillResult } from "./types.js";
import {
  SETTLEMENT_BLUEPRINTS,
  isSettlementStructureName,
  type SettlementStructureName,
} from "./blueprints/settlement.js";
import {
  footprintAtCenter,
  footprintsOverlap,
  preferredCenter,
  structureFootprint,
  type Footprint,
} from "./settlement-layout.js";
import {
  craftAllLogsToPlanks,
  craftDoors,
  craftSome,
  DOOR_TYPES,
  findPlacementRef,
  groundLevel,
  placeTableIfNeeded,
  setMovements,
} from "./build-house.js";
import { LOG_TYPES, PLANK_TYPES, countAllLogs, countAllPlanks } from "./materials.js";
import { collectNearbyDrops } from "../bot/navigation.js";
import { getAllMemoryStores, getBotMemoryStore } from "../bot/memory-registry.js";
import type { Structure } from "../bot/memory.js";
import { SETTLEMENT_STRUCTURE_RADIUS } from "../bot/role.js";

const { goals } = pkg;
const BUILD_BUDGET_MS = 120_000;
const MAX_BLOCKS_PER_PASS = 32;
const MATERIAL_GATHER_BUDGET_MS = 75_000;
const REPLACEABLE = new Set(["air", "short_grass", "tall_grass", "snow"]);

export const buildStructureSkill: Skill = {
  name: "build_structure",
  description:
    'Build or resume a deterministic settlement building. structure must be "warehouse" or "workshop". Warehouse comes after the house; workshop comes after warehouse/mining. Sites are placed about 20 blocks on opposite sides of the recorded house, with terrain and overlap checks.',
  params: {
    structure: {
      type: "string",
      description: '"warehouse" or "workshop"',
    },
  },

  estimateMaterials() {
    // Stash withdrawal, wood gathering, and crafting happen after the exact
    // site is known, so partial builds only acquire their remaining materials.
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const started = Date.now();
    const requested = params?.structure;
    if (!isSettlementStructureName(requested)) {
      return {
        success: false,
        message: 'build_structure needs structure: "warehouse" or "workshop".',
      };
    }

    const blueprint = SETTLEMENT_BLUEPRINTS[requested];
    const allStructures = teamStructures();
    const anchor = params?.stashPos as { x: number; y: number; z: number } | undefined;
    const anchoredStructures = anchor
      ? allStructures.filter(
          (structure) =>
            !["house", "warehouse", "workshop"].includes(structure.type) ||
            Math.hypot(structure.x - anchor.x, structure.z - anchor.z) <= SETTLEMENT_STRUCTURE_RADIUS,
        )
      : allStructures;
    const house = nearestStructure(
      anchoredStructures,
      "house",
      anchor?.x ?? bot.entity.position.x,
      anchor?.z ?? bot.entity.position.z,
    );
    if (!house || (house.notes ?? "").includes("(partial)")) {
      return {
        success: false,
        message: `No completed house is recorded yet. Finish build_house before starting the ${requested}.`,
      };
    }

    const existingCandidate = nearestStructure(anchoredStructures, requested, house.x, house.z);
    const existing =
      existingCandidate && Math.hypot(existingCandidate.x - house.x, existingCandidate.z - house.z) <= 80
        ? existingCandidate
        : null;
    if (existing && !(existing.notes ?? "").includes("(partial)")) {
      return {
        success: true,
        message: `${title(requested)} already complete at (${existing.x}, ${existing.y}, ${existing.z}).`,
      };
    }

    if (requested === "workshop") {
      const warehouse = nearestStructure(anchoredStructures, "warehouse", house.x, house.z);
      if (!warehouse || (warehouse.notes ?? "").includes("(partial)")) {
        return {
          success: false,
          message: "Warehouse is not complete yet. Finish the warehouse before starting the workshop.",
        };
      }
    }

    onProgress({
      skillName: "build_structure",
      phase: "Choosing site",
      progress: 0,
      message: existing ? `Resuming the ${requested}...` : `Surveying the ${requested} site...`,
      active: true,
    });

    try {
      const destination = existing ?? house;
      await gotoWithTimeout(bot, new goals.GoalNear(destination.x, destination.y, destination.z, 5), 35_000);
      await bot.waitForChunksToLoad();
    } catch {
      return {
        success: false,
        message: `Could not reach the shared settlement before surveying the ${requested}.`,
      };
    }

    const origin = existing
      ? new Vec3(existing.x, existing.y, existing.z)
      : findSettlementSite(bot, requested, blueprint, house, anchoredStructures);
    if (!origin) {
      return {
        success: false,
        message: `Could not find clear, nearly-flat terrain for the ${requested} near its preferred side of the house.`,
      };
    }

    const missing = missingBlueprintBlocks(bot, blueprint, origin);
    if (missing.length === 0) {
      rememberStructure(bot, requested, origin, blueprint.name);
      return {
        success: true,
        message: `${title(requested)} already complete at (${origin.x}, ${origin.y}, ${origin.z}).`,
      };
    }

    onProgress({
      skillName: "build_structure",
      phase: "Preparing materials",
      progress: 0.03,
      message: `${missing.length}/${blueprint.blocks.length} blocks remain`,
      active: true,
    });
    await prepareMaterials(bot, missing, params?.stashPos, signal, requested, onProgress);

    if (signal.aborted) return { success: false, message: `${title(requested)} build interrupted.` };

    const ordered = [
      ...missing.filter((b) => b.phase === "structure").sort((a, b) => a.pos[1] - b.pos[1]),
      ...missing.filter((b) => b.phase === "interior"),
    ];
    let newlyPlaced = 0;
    let blocked = 0;

    for (let i = 0; i < ordered.length; i++) {
      if (signal.aborted || Date.now() - started >= BUILD_BUDGET_MS || newlyPlaced >= MAX_BLOCKS_PER_PASS) break;
      const block = ordered[i];
      const worldPos = offset(origin, block.pos);
      const existingBlock = bot.blockAt(worldPos);
      if (existingBlock && blockMatches(existingBlock.name, block.block)) continue;
      if (existingBlock && !REPLACEABLE.has(existingBlock.name)) {
        blocked++;
        continue;
      }
      if (existingBlock && existingBlock.name !== "air" && existingBlock.name !== "water") {
        await digWithTimeout(bot, existingBlock).catch(() => {});
      }

      const item = itemForBlueprintBlock(bot, block.block);
      if (!item) {
        blocked++;
        continue;
      }

      try {
        if (bot.entity.position.distanceTo(worldPos) > 4.5) {
          setMovements(bot);
          await gotoWithTimeout(bot, new goals.GoalNear(worldPos.x, worldPos.y, worldPos.z, 3), 12_000);
        }
        await bot.equip(item, "hand");
        const placed = block.block.endsWith("_door")
          ? await placeDoor(bot, worldPos)
          : await placeOrdinaryBlock(bot, worldPos);
        if (placed) newlyPlaced++;
        else blocked++;
      } catch {
        blocked++;
      }

      if (i % 5 === 0) {
        const completed = blueprint.blocks.length - missing.length + newlyPlaced;
        onProgress({
          skillName: "build_structure",
          phase: block.phase === "structure" ? "Building shell" : "Furnishing",
          progress: 0.12 + (completed / blueprint.blocks.length) * 0.83,
          message: `${completed}/${blueprint.blocks.length} blocks complete`,
          active: true,
        });
      }
    }

    const remaining = missingBlueprintBlocks(bot, blueprint, origin);
    // Torches are best-effort decoration; every structural and functional
    // block must really exist before the building is marked complete.
    const complete = remaining.every((block) => block.block === "torch");
    rememberStructure(bot, requested, origin, `${blueprint.name}${complete ? "" : " (partial)"}`);

    if (complete) {
      return {
        success: true,
        message: `${title(requested)} complete at (${origin.x}, ${origin.y}, ${origin.z})! Placed ${newlyPlaced} blocks this pass.`,
        stats: { blocksPlaced: newlyPlaced, blocksRemaining: remaining.length },
      };
    }
    if (newlyPlaced > 0) {
      return {
        success: true,
        message: `${title(requested)} partially built at (${origin.x}, ${origin.y}, ${origin.z}): placed ${newlyPlaced}, ${remaining.length} blocks remain. Resume build_structure with structure "${requested}".`,
        stats: { blocksPlaced: newlyPlaced, blocksRemaining: remaining.length, blocksBlocked: blocked },
      };
    }
    return {
      success: false,
      message: `${title(requested)} made no progress: ${remaining.length} blocks remain. Supply the missing building materials or clear the site.`,
    };
  },
};

function findSettlementSite(
  bot: Bot,
  structure: SettlementStructureName,
  blueprint: Blueprint,
  house: Structure,
  structures: Structure[],
): Vec3 | null {
  const preferred = footprintAtCenter(preferredCenter(structure, house), blueprint);
  const occupied = structures.map(structureFootprint).filter((f): f is Footprint => f !== null);

  for (let radius = 0; radius <= 10; radius += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        if (radius > 0 && Math.abs(dx) < radius && Math.abs(dz) < radius) continue;
        const footprint = { ...preferred, x: preferred.x + dx, z: preferred.z + dz };
        if (occupied.some((other) => footprintsOverlap(footprint, other, 3))) continue;
        const y = suitableFloorY(bot, footprint, blueprint.dimensions[1]);
        if (y !== null) return new Vec3(footprint.x, y, footprint.z);
      }
    }
  }
  return null;
}

function suitableFloorY(bot: Bot, footprint: Footprint, height: number): number | null {
  const heights: number[] = [];
  for (let x = footprint.x; x < footprint.x + footprint.width; x += 2) {
    for (let z = footprint.z; z < footprint.z + footprint.depth; z += 2) {
      const y = groundLevel(bot, x, z);
      if (y === null) return null;
      heights.push(y);
    }
  }
  if (Math.max(...heights) - Math.min(...heights) > 1) return null;

  // Raise the blueprint floor one block above the highest sampled terrain.
  // This preserves the ground and avoids treating dirt as an already-built floor.
  const floorY = Math.max(...heights) + 1;
  for (let x = footprint.x; x < footprint.x + footprint.width; x++) {
    for (let z = footprint.z; z < footprint.z + footprint.depth; z++) {
      for (let y = floorY; y < floorY + height; y++) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block || !REPLACEABLE.has(block.name)) return null;
      }
    }
  }
  return floorY;
}

function teamStructures(): Structure[] {
  const found = new Map<string, Structure>();
  for (const store of getAllMemoryStores()) {
    for (const structure of store.getStructures()) {
      found.set(`${structure.type}:${structure.x}:${structure.y}:${structure.z}`, { ...structure });
    }
  }
  return [...found.values()];
}

function nearestStructure(structures: Structure[], type: Structure["type"], x: number, z: number): Structure | null {
  return (
    structures
      .filter((structure) => structure.type === type)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0] ?? null
  );
}

function rememberStructure(bot: Bot, type: "warehouse" | "workshop", origin: Vec3, notes: string): void {
  const store = getBotMemoryStore(bot);
  store?.addStructure(type, origin.x, origin.y, origin.z, notes);
}

function missingBlueprintBlocks(bot: Bot, blueprint: Blueprint, origin: Vec3): BlueprintBlock[] {
  return blueprint.blocks.filter((block) => {
    const existing = bot.blockAt(offset(origin, block.pos));
    return !existing || !blockMatches(existing.name, block.block);
  });
}

function blockMatches(actual: string, expected: string): boolean {
  if (expected.endsWith("_planks")) return (PLANK_TYPES as readonly string[]).includes(actual);
  if (expected.endsWith("_door")) return (DOOR_TYPES as readonly string[]).includes(actual);
  return actual === expected;
}

function itemForBlueprintBlock(bot: Bot, expected: string) {
  if (expected.endsWith("_planks")) {
    return bot.inventory.items().find((item) => (PLANK_TYPES as readonly string[]).includes(item.name));
  }
  if (expected.endsWith("_door")) {
    return bot.inventory.items().find((item) => (DOOR_TYPES as readonly string[]).includes(item.name));
  }
  return bot.inventory.items().find((item) => item.name === expected);
}

async function prepareMaterials(
  bot: Bot,
  missing: BlueprintBlock[],
  stashPos: { x: number; y: number; z: number } | undefined,
  signal: AbortSignal,
  structure: SettlementStructureName,
  onProgress: Parameters<Skill["execute"]>[3],
): Promise<void> {
  const needed = countBlocks(missing);
  if (stashPos) {
    const { withdrawStash } = await import("./stash.js");
    const withdraw = async (item: string, count: number) => {
      if (count <= 0 || signal.aborted) return;
      try {
        await withdrawStash(bot, stashPos, item, count);
      } catch {
        /* another material source or crafting may cover it */
      }
    };

    for (const item of ["chest", "furnace", "crafting_table", "torch"]) {
      await withdraw(item, Math.min(64, needed[item] ?? 0));
    }
    const furnaceDeficit = Math.max(0, (needed.furnace ?? 0) - countExact(bot, "furnace"));
    const cobbleTarget = (needed.cobblestone ?? 0) + furnaceDeficit * 8;
    await withdraw("cobblestone", Math.min(128, cobbleTarget));

    const plankTarget = woodPlankTarget(needed, bot);
    for (const item of PLANK_TYPES) {
      if (countAllPlanks(bot) + countAllLogs(bot) * 4 >= plankTarget) break;
      await withdraw(item, 64);
    }
    for (const item of LOG_TYPES) {
      if (countAllPlanks(bot) + countAllLogs(bot) * 4 >= plankTarget) break;
      await withdraw(item, 64);
    }
  }

  const plankTarget = woodPlankTarget(needed, bot);
  const woodEquivalent = () => countAllPlanks(bot) + countAllLogs(bot) * 4;
  const logsNeeded = Math.ceil(Math.max(0, plankTarget - woodEquivalent()) / 4);
  if (logsNeeded > 0) {
    onProgress({
      skillName: "build_structure",
      phase: "Gathering wood",
      progress: 0.05,
      message: `Need up to ${logsNeeded} more logs for the ${structure}`,
      active: true,
    });
    let gathered = 0;
    const gatherStarted = Date.now();
    for (
      let attempt = 0;
      attempt < logsNeeded + 12 &&
      gathered < logsNeeded &&
      !signal.aborted &&
      Date.now() - gatherStarted < MATERIAL_GATHER_BUDGET_MS;
      attempt++
    ) {
      const log = bot.findBlock({
        matching: (block) => (LOG_TYPES as readonly string[]).includes(block.name),
        maxDistance: 96,
      });
      if (!log) break;
      try {
        setMovements(bot);
        await gotoWithTimeout(bot, new goals.GoalNear(log.position.x, log.position.y, log.position.z, 2), 15_000);
        await digWithTimeout(bot, log);
        await collectNearbyDrops(bot, 6, 5_000);
        gathered++;
      } catch {
        continue;
      }
    }
  }

  await craftAllLogsToPlanks(bot, signal);
  await craftSome(bot, "crafting_table", needed.crafting_table ?? 0, signal);
  await placeTableIfNeeded(bot);
  await craftDoors(bot, needed.oak_door ?? 0, signal);
  await craftSome(bot, "chest", needed.chest ?? 0, signal);
  await craftSome(bot, "furnace", needed.furnace ?? 0, signal);
  await craftSome(bot, "stick", Math.ceil((needed.torch ?? 0) / 4), signal);
  await craftSome(bot, "torch", needed.torch ?? 0, signal);
}

function countBlocks(blocks: BlueprintBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of blocks) counts[block.block] = (counts[block.block] ?? 0) + 1;
  return counts;
}

function woodPlankTarget(needed: Record<string, number>, bot: Bot): number {
  const craftingTablesToMake = Math.max(0, (needed.crafting_table ?? 0) - countExact(bot, "crafting_table"));
  const chestsToMake = Math.max(0, (needed.chest ?? 0) - countExact(bot, "chest"));
  const doorsToMake = Math.max(
    0,
    (needed.oak_door ?? 0) -
      bot.inventory
        .items()
        .filter((item) => (DOOR_TYPES as readonly string[]).includes(item.name))
        .reduce((sum, item) => sum + item.count, 0),
  );
  return (
    Object.entries(needed)
      .filter(([name]) => name.endsWith("_planks"))
      .reduce((sum, [, count]) => sum + count, 0) +
    craftingTablesToMake * 4 +
    chestsToMake * 8 +
    Math.ceil(doorsToMake / 3) * 6 +
    Math.ceil((needed.torch ?? 0) / 4) * 2
  );
}

function countExact(bot: Bot, itemName: string): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

async function placeDoor(bot: Bot, worldPos: Vec3): Promise<boolean> {
  const floor = bot.blockAt(worldPos.offset(0, -1, 0));
  if (!floor || REPLACEABLE.has(floor.name)) return false;
  await bot.lookAt(worldPos.offset(0.5, 0.5, 0.5));
  return placeWithTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)));
}

async function placeOrdinaryBlock(bot: Bot, worldPos: Vec3): Promise<boolean> {
  const ref = findPlacementRef(bot, worldPos);
  if (!ref) return false;
  await bot.lookAt(worldPos.offset(0.5, 0.5, 0.5));
  return placeWithTimeout(bot.placeBlock(ref.block, ref.face));
}

async function placeWithTimeout(promise: Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500)),
  ]);
}

async function gotoWithTimeout(bot: Bot, goal: InstanceType<typeof goals.GoalNear>, timeoutMs: number): Promise<void> {
  await Promise.race([
    bot.pathfinder.goto(goal),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        bot.pathfinder.stop();
        reject(new Error("pathfinder timeout"));
      }, timeoutMs),
    ),
  ]);
}

async function digWithTimeout(bot: Bot, block: NonNullable<ReturnType<Bot["blockAt"]>>): Promise<void> {
  await Promise.race([
    bot.dig(block),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* best effort */
        }
        reject(new Error("dig timeout"));
      }, 10_000),
    ),
  ]);
}

function offset(origin: Vec3, pos: BlueprintBlock["pos"]): Vec3 {
  return new Vec3(origin.x + pos[0], origin.y + pos[1], origin.z + pos[2]);
}

function title(structure: SettlementStructureName): string {
  return structure[0].toUpperCase() + structure.slice(1);
}
