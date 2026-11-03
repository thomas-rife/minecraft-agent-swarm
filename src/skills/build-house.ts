import type { Bot } from "mineflayer";
import type { Blueprint, BlueprintBlock, Skill, SkillProgress, SkillResult } from "./types.js";
import {
  createShelterDesign,
  decodeShelterDesign,
  encodeShelterDesign,
  shelterBlueprint,
  type ShelterDesign,
} from "./shelter-design.js";
import { LOG_TYPES, PLANK_TYPES, countAllLogs, countAllPlanks } from "./materials.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { addStructure } from "../bot/memory.js";
import { getBotMemoryStore, getAllMemoryStores } from "../bot/memory-registry.js";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import { HOUSE_WOOD_TARGET } from "../bot/goal-requirements.js";
import { SETTLEMENT_STRUCTURE_RADIUS } from "../bot/role.js";
import { footprintAtCenter, preferredHouseCenter } from "./settlement-layout.js";

/** All door types — any wood's door works interchangeably */
export const DOOR_TYPES = [
  "oak_door",
  "spruce_door",
  "birch_door",
  "jungle_door",
  "acacia_door",
  "dark_oak_door",
  "cherry_door",
  "mangrove_door",
] as const;

const BUILD_BUDGET_MS = 120_000;
const MAX_BLOCKS_PER_PASS = 32;
const REPLACEABLE = new Set(["air", "short_grass", "tall_grass", "snow"]);
const TERRAIN_CLEARABLE = new Set(["short_grass", "tall_grass", "snow", "vine"]);
const MAX_TERRAIN_CHANGES = 48;

export const buildHouseSkill: Skill = {
  name: "build_house",
  description:
    "Ask the local model to design a compact shelter, then build or resume it on a supported floor that adapts to uneven terrain.",
  params: {},

  estimateMaterials(_bot, _params) {
    // All material gathering is handled inside execute().
    // Wood: any log type works, handled internally.
    // Coal: optional (torches are nice-to-have, not required for the house).
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const startedAt = Date.now();
    const settlementAnchor = (
      params as {
        settlementAnchor?: { x: number; y: number; z: number };
        stashPos?: { x: number; y: number; z: number };
      }
    )?.settlementAnchor ?? params?.stashPos;
    if (!settlementAnchor) {
      return {
        success: false,
        message: "No settlement anchor configured for build_house.",
      };
    }

    // --- Step 1: choose a design and establish a supported site ---
    onProgress({
      skillName: "build_house",
      phase: "Finding build site",
      progress: 0,
      message: "Choosing a shelter design and surveying its footprint...",
      active: true,
    });

    // Site selection is TEAM-aware and anchored to the configured settlement.
    // A house built near a distant tree or in an old world is intentionally not
    // allowed to complete the current settlement objective.
    const houses = getAllMemoryStores()
      .flatMap((store) => [...store.getStructures()])
      .filter((structure) => structure.type === "house")
      .filter(
        (structure) =>
          Math.hypot(structure.x - settlementAnchor.x, structure.z - settlementAnchor.z) <=
          SETTLEMENT_STRUCTURE_RADIUS,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - settlementAnchor.x, a.z - settlementAnchor.z) -
          Math.hypot(b.x - settlementAnchor.x, b.z - settlementAnchor.z),
      );
    const completed = houses.find((house) => !(house.notes ?? "").includes("(partial)"));
    if (completed) {
      return {
        success: true,
        message: `House already built at (${completed.x}, ${completed.y}, ${completed.z}). Use go_to ${completed.x} ${completed.y} ${completed.z} to visit the shared home.`,
      };
    }

    const partial = houses.find((house) => (house.notes ?? "").includes("(partial)"));
    const design = decodeShelterDesign(partial?.notes) ?? (await createShelterDesign());
    const bp = shelterBlueprint(design);
    let origin: Vec3 | null = partial ? new Vec3(partial.x, partial.y, partial.z) : null;
    if (origin) {
      console.log(`[Skill] Resuming shared house at ${origin.x}, ${origin.y}, ${origin.z}`);
      await safeGoto(bot, new goals.GoalNear(origin.x, origin.y, origin.z, 4), 35_000).catch(() => {});
    } else {
      const preferred = footprintAtCenter(preferredHouseCenter(settlementAnchor), bp);
      const approach = new Vec3(
        preferred.x + Math.floor(preferred.width / 2),
        settlementAnchor.y,
        preferred.z + preferred.depth,
      );
      try {
        await safeGoto(bot, new goals.GoalNear(approach.x, approach.y, approach.z, 5), 35_000);
        await bot.waitForChunksToLoad();
      } catch {
        return {
          success: false,
          message: `Could not reach the shared house zone near (${approach.x}, ${approach.y}, ${approach.z}).`,
        };
      }
      origin = findAnchoredBuildSite(bot, settlementAnchor, bp);
    }
    if (!origin) {
      return {
        success: false,
        message: "Could not load terrain beneath the compact shelter footprint near the settlement anchor.",
      };
    }

    // Reserve the site before gathering or placing anything. Every bot can
    // now resume this exact origin instead of starting another shell.
    rememberHouse(bot, origin, houseNotes(bp.name, design, true));

    console.log(`[Skill] Build site at ${origin.x}, ${origin.y}, ${origin.z}`);

    // Clear a bounded amount of vegetation before construction. The reserved
    // origin makes this resumable: if a pass is interrupted, the next pass
    // prepares the same footprint rather than searching for a different site.
    const preparation = await prepareHouseSite(bot, origin, bp, signal, onProgress);
    if (!preparation.success) return preparation;

    // --- Step 2: Gather wood (any type) ---
    const totalPlanksNeeded = Object.entries(bp.materials)
      .filter(([name]) => name.endsWith("_planks"))
      .reduce((sum, [, count]) => sum + count, 0);

    const existingPlankBlocks = bp.blocks
      .filter((block) => block.block.endsWith("_planks"))
      .filter((block) => blockMatchesBlueprint(bot, origin, block)).length;
    const remainingPlanksNeeded = Math.max(0, totalPlanksNeeded - existingPlankBlocks);

    // +8 margin for crafting table (4 planks) and sticks (2 planks) and waste
    // +6 for door crafting (6 planks → 3 doors, we need 2)
    const doorsNeeded = bp.materials["oak_door"] || 0;
    const doorAlreadyPlaced = bp.blocks
      .filter((block) => block.block.endsWith("_door"))
      .some((block) => blockMatchesBlueprint(bot, origin, block));
    const tableAlreadyPlaced = bp.blocks
      .filter((block) => block.block === "crafting_table")
      .some((block) => blockMatchesBlueprint(bot, origin, block));
    const setupMargin = tableAlreadyPlaced ? 4 : 8;
    const calculatedPlanksTarget =
      remainingPlanksNeeded + setupMargin + (doorsNeeded > 0 && !doorAlreadyPlaced ? 6 : 0);
    // The lodge remains resumable. Acquire one useful
    // construction batch at a time; persistent partial-site memory makes the
    // next objective pass continue instead of demanding the entire house in
    // one inventory.
    const totalPlanksTarget = Math.min(calculatedPlanksTarget, HOUSE_WOOD_TARGET);

    // Pull building materials from the shared stash before chopping trees. The
    // team gathers wood + cobblestone and deposits it, so the warehouse usually
    // has plenty; chopping enough planks for a whole house from scratch was the
    // blocker ("Not enough planks"). Stash-first, chop only the remainder.
    // Mirrors smelt_ores/craft_gear (the user's deposit+withdraw model).
    const stashPos = (params as { stashPos?: { x: number; y: number; z: number } } | undefined)?.stashPos;
    const haveEnoughWood = () => countAllPlanks(bot) + countAllLogs(bot) * 4 >= totalPlanksTarget;
    if (stashPos && !signal.aborted && !haveEnoughWood()) {
      const { withdrawStash } = await import("./stash.js");
      for (const item of ["oak_planks", "spruce_planks", "birch_planks", "oak_log", "spruce_log", "birch_log"]) {
        if (haveEnoughWood()) break;
        try {
          await withdrawStash(bot, stashPos, item, 64);
        } catch {
          /* none of this type in stash — try next */
        }
      }
    }

    const existingPlanks = countAllPlanks(bot);
    const existingLogs = countAllLogs(bot);
    const planksFromLogs = existingLogs * 4;
    const plankDeficit = Math.max(0, totalPlanksTarget - existingPlanks - planksFromLogs);
    const logsToMine = Math.ceil(plankDeficit / 4);

    if (logsToMine > 0) {
      onProgress({
        skillName: "build_house",
        phase: "Chopping trees",
        progress: 0.02,
        message: `Need ${logsToMine} more logs...`,
        active: true,
      });

      const logBlockNames = [...LOG_TYPES] as string[];
      let mined = 0;
      for (let i = 0; i < logsToMine + 15 && mined < logsToMine && !signal.aborted; i++) {
        const block = bot.findBlock({
          matching: (b) => logBlockNames.includes(b.name),
          maxDistance: 128,
        });
        if (!block) {
          if (mined === 0) {
            return {
              success: false,
              message: "No trees found nearby! Explore to find a forest, then try build_house again.",
            };
          }
          break; // Use what we have
        }

        try {
          setMovements(bot);
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pathfinder timeout")), 15_000)),
          ]);
          await bot.dig(block);
          mined++;
          // Walk over the drop — digging alone leaves the log on the ground
          await collectNearbyDrops(bot, 6, 5000);
          onProgress({
            skillName: "build_house",
            phase: "Chopping trees",
            progress: 0.02 + (mined / logsToMine) * 0.13,
            message: `Chopped ${mined}/${logsToMine} logs`,
            active: true,
          });
        } catch {
          continue;
        }
      }
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while gathering wood!" };
    }

    // --- Step 2.5: Clear inventory junk before crafting ---
    // (Tree chopping generates saplings, sticks, buttons that fill inventory)
    await clearInventoryJunk(bot);

    // --- Step 3: Craft materials ---
    onProgress({
      skillName: "build_house",
      phase: "Crafting materials",
      progress: 0.15,
      message: "Turning logs into planks...",
      active: true,
    });

    // Craft ALL log types into their respective planks
    await craftAllLogsToPlanks(bot, signal);

    // Require a useful batch, but never demand the entire lodge blueprint in
    // one inventory. Later passes recalculate only what is still missing.
    const planksNow = countAllPlanks(bot);
    const minimumUsefulBatch = Math.min(remainingPlanksNeeded, Math.ceil(HOUSE_WOOD_TARGET / 2));
    if (planksNow < minimumUsefulBatch) {
      return {
        success: false,
        message: `Not enough planks for the next house section — need at least ${minimumUsefulBatch}, have ${planksNow}. Gather or withdraw more wood, then resume the same site.`,
      };
    }

    // Craft sticks (just enough for torches — recipe uses any plank type via tags)
    const torchesNeeded = bp.materials["torch"] || 0;
    const sticksNeeded = Math.ceil(torchesNeeded / 4) + 1;
    await craftSome(bot, "stick", sticksNeeded, signal);

    // Craft torches
    if (torchesNeeded > 0) {
      await craftSome(bot, "torch", torchesNeeded, signal);
    }

    // Craft crafting table
    await craftSome(bot, "crafting_table", 1, signal);

    // Place crafting table so we can use it for door recipe (3x3 grid)
    await placeTableIfNeeded(bot);

    // Craft doors (any wood type — 6 planks → 3 doors)
    if (doorsNeeded > 0) {
      await craftDoors(bot, doorsNeeded, signal);
    }

    if (signal.aborted) {
      return { success: false, message: "House building was interrupted during crafting!" };
    }

    const planksReady = countAllPlanks(bot);
    console.log(
      `[Skill] Crafting done. Have ${planksReady} planks for this pass; ${remainingPlanksNeeded}/${totalPlanksNeeded} blueprint planks remain`,
    );

    const foundation = await buildFoundationSupports(bot, origin, bp, signal, onProgress);
    if (!foundation.success) return foundation;

    // --- Step 4: Place blocks from blueprint ---
    const structureBlocks = bp.blocks.filter((b) => b.phase === "structure").sort((a, b) => a.pos[1] - b.pos[1]); // bottom-up

    const interiorBlocks = bp.blocks.filter((b) => b.phase === "interior");
    const allBlocks = [...structureBlocks, ...interiorBlocks];
    const total = allBlocks.length;
    let placed = 0;
    let newlyPlaced = 0;
    let skipped = 0;

    for (let i = 0; i < allBlocks.length; i++) {
      if (signal.aborted || Date.now() - startedAt >= BUILD_BUDGET_MS || newlyPlaced >= MAX_BLOCKS_PER_PASS) break;

      const bpBlock = allBlocks[i];
      const worldPos = new Vec3(origin.x + bpBlock.pos[0], origin.y + bpBlock.pos[1], origin.z + bpBlock.pos[2]);

      // Count only the intended block (with any wood variant), never arbitrary
      // terrain or an overlapping structure.
      const existing = bot.blockAt(worldPos);
      if (existing && blockNameMatches(existing.name, bpBlock.block)) {
        placed++;
        continue;
      }
      if (existing && !REPLACEABLE.has(existing.name)) {
        skipped++;
        continue;
      }

      // Find the item — use ANY wood variant for planks and doors
      const isDoor = bpBlock.block.endsWith("_door");
      const item = isDoor
        ? bot.inventory.items().find((it) => (DOOR_TYPES as readonly string[]).includes(it.name))
        : bpBlock.block.endsWith("_planks")
          ? bot.inventory.items().find((it) => (PLANK_TYPES as readonly string[]).includes(it.name))
          : bot.inventory.items().find((it) => it.name === bpBlock.block);
      if (!item) {
        skipped++;
        continue;
      }

      try {
        // Navigate close enough to place
        const dist = bot.entity.position.distanceTo(worldPos);
        if (dist > 4.5) {
          setMovements(bot);
          await bot.pathfinder.goto(new goals.GoalNear(worldPos.x, worldPos.y, worldPos.z, 3));
        }

        await bot.equip(item, "hand");

        if (isDoor) {
          // Doors must be placed on the floor block below — Minecraft auto-fills top half
          const floorBlock = bot.blockAt(worldPos.offset(0, -1, 0));
          if (floorBlock && floorBlock.name !== "air") {
            await bot.lookAt(worldPos.offset(0.5, 0, 0.5));
            const ok = await Promise.race([
              bot
                .placeBlock(floorBlock, new Vec3(0, 1, 0))
                .then(() => true)
                .catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
            ]);
            if (ok) {
              placed++;
              newlyPlaced++;
            } else skipped++;
          } else {
            skipped++;
          }
        } else {
          // Normal block: find a solid adjacent block to place against
          const ref = findPlacementRef(bot, worldPos);
          if (ref) {
            await bot.lookAt(worldPos.offset(0.5, 0.5, 0.5));
            // Fast placement with 2s timeout
            const ok = await Promise.race([
              bot
                .placeBlock(ref.block, ref.face)
                .then(() => true)
                .catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
            ]);
            if (ok) {
              placed++;
              newlyPlaced++;
            } else skipped++;
          } else {
            skipped++;
          }
        }
      } catch {
        skipped++;
      }

      // Progress update every 5 blocks
      if (i % 5 === 0) {
        onProgress({
          skillName: "build_house",
          phase: bpBlock.phase === "structure" ? "Building walls & roof" : "Decorating interior",
          progress: 0.2 + ((placed + skipped) / total) * 0.75,
          message: `${placed} blocks placed, ${skipped} skipped`,
          active: true,
        });
      }
    }

    // --- Step 5: Navigate to entrance ---
    const entrancePos = new Vec3(
      origin.x + bp.entrance.pos[0],
      origin.y + bp.entrance.pos[1],
      origin.z + bp.entrance.pos[2],
    );
    try {
      setMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(entrancePos.x, entrancePos.y, entrancePos.z, 1));
    } catch {
      /* ok */
    }

    const remaining = bp.blocks.filter((block) => !blockMatchesBlueprint(bot, origin, block));
    // Torches are best-effort decoration. The floor, shell, doors, and table
    // must really exist before the shared objective reports a complete house.
    const complete = remaining.every((block) => block.block === "torch");

    if (complete) {
      rememberHouse(bot, origin, houseNotes(bp.name, design, false));
      return {
        success: true,
        message: `HOUSE BUILT! "${bp.name}" at ${origin.x}, ${origin.y}, ${origin.z}. Placed ${newlyPlaced} blocks this pass (${remaining.length} optional lights remain). It's GORGEOUS. It's HOME.`,
        stats: { blocksPlaced: newlyPlaced, blocksSkipped: skipped, blocksRemaining: remaining.length },
      };
    } else if (newlyPlaced > 0 || placed > 0) {
      rememberHouse(bot, origin, houseNotes(bp.name, design, true));
      return {
        success: true,
        message: `House partially built (${total - remaining.length}/${total} blocks) at (${origin.x}, ${origin.y}, ${origin.z}): placed ${newlyPlaced} this pass; ${remaining.length} remain. Resume build_house at the shared site.`,
        stats: { blocksPlaced: newlyPlaced, blocksSkipped: skipped, blocksRemaining: remaining.length },
      };
    }
    return {
      success: false,
      message: "Couldn't place any blocks. Terrain problems or empty inventory.",
    };
  },
};

// --- Helpers ---

/** Drop junk items to make room for building materials. Keep best tools, food, and building items. */
export async function clearInventoryJunk(bot: Bot) {
  const items = bot.inventory.items();
  const usedSlots = items.length;
  if (usedSlots < 30) return; // Plenty of room

  console.log(`[Skill] Inventory cleanup: ${usedSlots}/36 slots used`);

  // Items worth keeping (one each unless stackable building material)
  const keepBest: Record<string, number> = {}; // track best tool of each type

  // Junk to drop: extra duplicate tools, buttons, saplings, non-essential items
  const JUNK_PATTERNS = ["_button", "_sapling", "dandelion", "poppy", "fern", "dead_bush", "feather"];
  const KEEP_ONE = ["stick", "dirt", "cobblestone", "coal", "crafting_table", "red_bed"];
  const TOOL_TYPES_SET = ["_pickaxe", "_axe", "_sword", "_shovel"];

  // Find best tool of each type (diamond > iron > stone > wood)
  const toolRanks: Record<string, number> = { diamond: 4, iron: 3, stone: 2, wooden: 1 };
  const bestTool: Record<string, { rank: number; slot: number }> = {};

  for (const item of items) {
    for (const toolSuffix of TOOL_TYPES_SET) {
      if (item.name.endsWith(toolSuffix)) {
        const tierName = item.name.replace(toolSuffix, "");
        const rank = toolRanks[tierName] || 0;
        const existing = bestTool[toolSuffix];
        if (!existing || rank > existing.rank) {
          bestTool[toolSuffix] = { rank, slot: item.slot };
        }
      }
    }
  }

  const bestToolSlots = new Set(Object.values(bestTool).map((t) => t.slot));

  for (const item of items) {
    // Keep food
    if (item.name.includes("cooked") || item.name.includes("steak") || item.name === "bread") continue;
    // Keep planks and logs (building materials)
    if (item.name.endsWith("_planks") || item.name.endsWith("_log")) continue;
    // Keep torches
    if (item.name === "torch") continue;
    // Keep the best tool of each type
    if (bestToolSlots.has(item.slot)) continue;
    // Keep one of essential items
    if (KEEP_ONE.includes(item.name)) {
      if (!keepBest[item.name]) {
        keepBest[item.name] = 1;
        continue;
      }
    }

    // Drop junk patterns
    const isJunk = JUNK_PATTERNS.some((p) => item.name.includes(p));
    // Drop duplicate tools (not the best)
    const isDupeTool = TOOL_TYPES_SET.some((t) => item.name.endsWith(t)) && !bestToolSlots.has(item.slot);
    // Drop ALL sticks (we can re-craft if needed, they're cheap)
    const isStick = item.name === "stick";

    if (isJunk || isDupeTool || isStick) {
      try {
        await bot.tossStack(item);
        console.log(`[Skill] Dropped ${item.name}x${item.count}`);
      } catch {
        /* ok */
      }
    }
  }

  console.log(`[Skill] Inventory after cleanup: ${bot.inventory.items().length}/36 slots`);
}

export function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/**
 * Find a surface site near the house's assigned settlement zone. The bot's
 * current position never influences the target, so gathering cannot drag the
 * shared base toward a forest or cave.
 */
function findAnchoredBuildSite(
  bot: Bot,
  anchor: { x: number; y: number; z: number },
  blueprint: Blueprint,
): Vec3 | null {
  const preferred = footprintAtCenter(preferredHouseCenter(anchor), blueprint);
  const offsets: { x: number; z: number }[] = [{ x: 0, z: 0 }];
  for (let radius = 2; radius <= 24; radius += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
        offsets.push({ x: dx, z: dz });
      }
    }
  }

  for (const offset of offsets) {
    const x = preferred.x + offset.x;
    const z = preferred.z + offset.z;
    const centerX = x + Math.floor(blueprint.dimensions[0] / 2);
    const centerZ = z + Math.floor(blueprint.dimensions[2] / 2);
    if (Math.hypot(centerX - anchor.x, centerZ - anchor.z) > 32) continue;
    // Preserve a six-block shared yard between the south wall/entrance and
    // the stash row at the anchor.
    if (z + blueprint.dimensions[2] > anchor.z - 6) continue;

    const heights: number[] = [];
    let usable = true;
    for (let fx = 0; fx < blueprint.dimensions[0] && usable; fx++) {
      for (let fz = 0; fz < blueprint.dimensions[2]; fz++) {
        const ground = groundLevel(bot, x + fx, z + fz);
        if (ground === null) {
          usable = false;
          break;
        }
        heights.push(ground);
      }
    }
    if (!usable || heights.length === 0) continue;

    const floorY = Math.max(...heights) + 1;
    let terrainChanges = 0;
    for (let fx = 0; fx < blueprint.dimensions[0] && usable; fx++) {
      for (let fz = 0; fz < blueprint.dimensions[2] && usable; fz++) {
        for (let fy = 0; fy < blueprint.dimensions[1]; fy++) {
          const block = bot.blockAt(new Vec3(x + fx, floorY + fy, z + fz));
          if (!block) {
            usable = false;
            break;
          }
          if (REPLACEABLE.has(block.name)) continue;
          const naturalVegetation =
            TERRAIN_CLEARABLE.has(block.name) ||
            block.name.includes("leaves") ||
            block.name.endsWith("_log") ||
            block.name.endsWith("_stem");
          if (!naturalVegetation) {
            usable = false;
            break;
          }
          terrainChanges++;
          if (terrainChanges > MAX_TERRAIN_CHANGES) {
            usable = false;
            break;
          }
        }
      }
    }
    if (usable) return new Vec3(x, floorY, z);
  }
  return null;
}

async function prepareHouseSite(
  bot: Bot,
  origin: Vec3,
  blueprint: Blueprint,
  signal: AbortSignal,
  onProgress: (progress: SkillProgress) => void,
): Promise<SkillResult> {
  const obstructions: Vec3[] = [];
  for (let x = 0; x < blueprint.dimensions[0]; x++) {
    for (let z = 0; z < blueprint.dimensions[2]; z++) {
      for (let y = 0; y < blueprint.dimensions[1]; y++) {
        const position = origin.offset(x, y, z);
        const block = bot.blockAt(position);
        if (!block || REPLACEABLE.has(block.name)) continue;
        const clearable =
          TERRAIN_CLEARABLE.has(block.name) ||
          block.name.includes("leaves") ||
          block.name.endsWith("_log") ||
          block.name.endsWith("_stem");
        if (!clearable) continue;
        obstructions.push(position);
      }
    }
  }
  if (obstructions.length > MAX_TERRAIN_CHANGES) {
    return {
      success: false,
      message: `House site needs ${obstructions.length} terrain changes; bounded preparation permits ${MAX_TERRAIN_CHANGES}.`,
    };
  }
  if (obstructions.length === 0) return { success: true, message: "House footprint is prepared." };

  let cleared = 0;
  for (const position of obstructions) {
    if (signal.aborted) return { success: false, message: "Interrupted while preparing the house site." };
    const block = bot.blockAt(position);
    if (!block || REPLACEABLE.has(block.name)) continue;
    try {
      if (bot.entity.position.distanceTo(position) > 4.5) {
        await safeGoto(bot, new goals.GoalNear(position.x, position.y, position.z, 3), 10_000);
      }
      await Promise.race([
        bot.dig(block, true),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("terrain dig timeout")), 5_000)),
      ]);
      cleared++;
    } catch {
      return {
        success: false,
        message: `Terrain preparation stopped after ${cleared}/${obstructions.length} changes at (${position.x}, ${position.y}, ${position.z}); resume the same house site.`,
        stats: { terrainCleared: cleared, terrainRemaining: obstructions.length - cleared },
      };
    }
    if (cleared % 4 === 0) {
      onProgress({
        skillName: "build_house",
        phase: "Preparing lodge site",
        progress: Math.min(0.08, (cleared / obstructions.length) * 0.08),
        message: `Cleared ${cleared}/${obstructions.length} bounded terrain obstructions`,
        active: true,
      });
    }
  }
  return {
    success: true,
    message: `Prepared the reserved lodge footprint with ${cleared} terrain changes.`,
    stats: { terrainCleared: cleared },
  };
}

function blockNameMatches(actual: string, expected: string): boolean {
  if (expected.endsWith("_planks")) return (PLANK_TYPES as readonly string[]).includes(actual);
  if (expected.endsWith("_door")) return (DOOR_TYPES as readonly string[]).includes(actual);
  return actual === expected;
}

export function blockMatchesBlueprint(bot: Bot, origin: Vec3, block: BlueprintBlock): boolean {
  const existing = bot.blockAt(
    new Vec3(origin.x + block.pos[0], origin.y + block.pos[1], origin.z + block.pos[2]),
  );
  return !!existing && blockNameMatches(existing.name, block.block);
}

function rememberHouse(bot: Bot, origin: Vec3, notes: string): void {
  const store = getBotMemoryStore(bot);
  if (store) store.addStructure("house", origin.x, origin.y, origin.z, notes);
  else addStructure("house", origin.x, origin.y, origin.z, notes);
}

function houseNotes(name: string, design: ShelterDesign, partial: boolean): string {
  return `${name}${partial ? " (partial)" : ""} [shelter-design:${encodeShelterDesign(design)}]`;
}

/** Build columns from the terrain up to the raised floor. This lets the bot
 * establish a placement face even when the footprint crosses a slope. */
async function buildFoundationSupports(
  bot: Bot,
  origin: Vec3,
  blueprint: Blueprint,
  signal: AbortSignal,
  onProgress: (progress: SkillProgress) => void,
): Promise<SkillResult> {
  const columns: Array<{ x: number; z: number; ground: number }> = [];
  const supportCells = [
    [0, 0],
    [blueprint.dimensions[0] - 1, 0],
    [0, blueprint.dimensions[2] - 1],
    [blueprint.dimensions[0] - 1, blueprint.dimensions[2] - 1],
  ] as const;
  for (const [x, z] of supportCells) {
      const ground = groundLevel(bot, origin.x + x, origin.z + z);
      if (ground === null) return { success: false, message: "Foundation terrain is not loaded; resume near the reserved shelter." };
      if (ground < origin.y - 1) columns.push({ x, z, ground });
  }
  let placed = 0;
  for (const column of columns) {
    for (let y = column.ground + 1; y < origin.y; y++) {
      if (signal.aborted) return { success: false, message: "Interrupted while building shelter supports." };
      const target = new Vec3(origin.x + column.x, y, origin.z + column.z);
      const existing = bot.blockAt(target);
      if (existing && !REPLACEABLE.has(existing.name)) continue;
      const item = bot.inventory.items().find((entry) => (PLANK_TYPES as readonly string[]).includes(entry.name));
      if (!item) return { success: false, message: `Shelter foundation needs more planks after placing ${placed} supports.` };
      try {
        if (bot.entity.position.distanceTo(target) > 4.5)
          await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), 10_000);
        const ref = findPlacementRef(bot, target);
        if (!ref) return { success: false, message: `No placement face for support at (${target.x}, ${target.y}, ${target.z}).` };
        await bot.equip(item, "hand");
        await bot.placeBlock(ref.block, ref.face);
        placed++;
      } catch {
        return { success: false, message: `Could not place shelter support at (${target.x}, ${target.y}, ${target.z}); resume the reserved site.` };
      }
    }
  }
  if (placed > 0)
    onProgress({ skillName: "build_house", phase: "Building foundation", progress: 0.18, message: `Placed ${placed} terrain supports`, active: true });
  return { success: true, message: `Foundation ready with ${placed} new supports.`, stats: { supportsPlaced: placed } };
}

export function groundLevel(bot: Bot, x: number, z: number): number | null {
  const botY = Math.floor(bot.entity.position.y);
  for (let y = botY + 5; y >= botY - 10; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    const above = bot.blockAt(new Vec3(x, y + 1, z));
    if (
      block &&
      block.name !== "air" &&
      block.name !== "water" &&
      block.name !== "short_grass" &&
      block.name !== "tall_grass" &&
      !block.name.includes("leaves") &&
      above &&
      (above.name === "air" || above.name === "short_grass" || above.name === "tall_grass")
    ) {
      return y;
    }
  }
  return null;
}

/** Find a solid block adjacent to targetPos that we can place against. */
export function findPlacementRef(bot: Bot, targetPos: Vec3): { block: any; face: Vec3 } | null {
  const faces = [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];
  for (const face of faces) {
    const refPos = targetPos.minus(face);
    const refBlock = bot.blockAt(refPos);
    if (refBlock && refBlock.name !== "air" && refBlock.name !== "water" && !refBlock.name.includes("leaves")) {
      return { block: refBlock, face };
    }
  }
  return null;
}

/** Craft each log type into its corresponding planks. */
export async function craftAllLogsToPlanks(bot: Bot, signal: AbortSignal): Promise<void> {
  const mcData = mcDataLoader(bot.version);

  // Also try placing a crafting table for recipes that need one
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });

  for (const logType of LOG_TYPES) {
    if (signal.aborted) break;
    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) {
      console.log(`[Skill] Warning: ${plankName} not found in mcData`);
      continue;
    }

    console.log(`[Skill] Crafting ${logCount}x ${logType} → ${plankName}`);

    // Try without table first, then with table
    let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
    let useTable = false;
    if (!recipe && table) {
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      useTable = true;
    }

    if (!recipe) {
      console.log(`[Skill] No recipe found for ${plankName} — skipping ${logType}`);
      continue;
    }

    // Craft one at a time to avoid mineflayer window timeout issues
    let crafted = 0;
    for (let i = 0; i < logCount && !signal.aborted; i++) {
      try {
        await bot.craft(recipe, 1, useTable ? table || undefined : undefined);
        crafted++;
      } catch {
        // Re-fetch recipe in case inventory state changed
        recipe = bot.recipesFor(mcItem.id, null, 1, useTable ? table || null : null)[0];
        if (!recipe) break;
      }
    }
    console.log(`[Skill] Crafted ${crafted}x ${plankName} (${crafted * 4} planks)`);
  }
}

/** Place a crafting table from inventory if none nearby (needed for door recipe). */
export async function placeTableIfNeeded(bot: Bot): Promise<void> {
  const existing = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (existing) return;

  const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!tableItem) return;

  await bot.equip(tableItem, "hand");
  const pos = bot.entity.position.floored();
  // Try placing on solid ground next to the bot
  for (const offset of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const below = bot.blockAt(new Vec3(pos.x + offset[0], pos.y - 1, pos.z + offset[1]));
    const target = bot.blockAt(new Vec3(pos.x + offset[0], pos.y, pos.z + offset[1]));
    if (below && below.name !== "air" && target && target.name === "air") {
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        console.log("[Skill] Placed crafting table for door crafting");
        return;
      } catch {
        continue;
      }
    }
  }
}

/** Craft doors from whatever planks are available (any wood type works). */
export async function craftDoors(bot: Bot, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);

  // Check if we already have enough doors
  const haveDoors = bot.inventory
    .items()
    .filter((i) => (DOOR_TYPES as readonly string[]).includes(i.name))
    .reduce((s, i) => s + i.count, 0);
  if (haveDoors >= count) return;

  // Need a crafting table for door recipe (3x3 grid)
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    console.log("[Skill] No crafting table found — skipping door crafting");
    return;
  }

  // Navigate to table
  try {
    setMovements(bot);
    await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch {
    /* try anyway */
  }

  // Try each door type — whichever has a valid recipe (meaning we have 6 of its plank type)
  for (const doorType of DOOR_TYPES) {
    const mcItem = mcData.itemsByName[doorType];
    if (!mcItem) continue;
    const recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
    if (!recipe) continue;
    try {
      await bot.craft(recipe, 1, table); // 1 craft = 3 doors, enough for 2
      console.log(`[Skill] Crafted ${doorType}`);
      return;
    } catch {
      continue;
    }
  }
  console.log("[Skill] Couldn't craft any doors (need 6 planks of same wood type)");
}

/** Craft a specific count of an item (uses any valid recipe). */
export async function craftSome(bot: Bot, itemName: string, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const mcItem = mcData.itemsByName[itemName];
  if (!mcItem) return;

  const have = bot.inventory
    .items()
    .filter((i) => i.name === itemName)
    .reduce((s, i) => s + i.count, 0);
  if (have >= count) return;

  // Try hand crafting first (no table needed for planks, sticks)
  let table: ReturnType<Bot["findBlock"]> | null = null;
  let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];

  // If no hand recipe, try with a crafting table
  if (!recipe) {
    table = bot.findBlock({
      matching: (b) => b.name === "crafting_table",
      maxDistance: 32,
    });
    if (table) {
      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      } catch {
        /* try anyway */
      }
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
    }
  }

  if (!recipe) return;
  const needed = Math.ceil(count - have);
  try {
    await bot.craft(recipe, needed, table || undefined);
  } catch {
    /* ok */
  }
}
