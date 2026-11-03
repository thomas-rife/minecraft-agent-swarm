// src/skills/setup-stash.ts
// Bootstraps the shared stash — crafts & places a double chest at the stash position.

import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { LOG_TYPES, countAllLogs, countAllPlanks } from "./materials.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { safeGoto } from "../bot/actions.js";
import { snapshotChest } from "./stash-ledger.js";

export const setupStashSkill: Skill = {
  name: "setup_stash",
  description:
    "Bootstrap or deliberately expand the shared stash. mode=ensure creates the initial double chest; mode=expand adds verified new capacity instead of accepting an existing chest as success.",
  params: {
    x: { type: "number", description: "Stash X coordinate" },
    y: { type: "number", description: "Stash Y coordinate" },
    z: { type: "number", description: "Stash Z coordinate" },
    mode: { type: "string", description: "ensure (default) or expand" },
  },

  estimateMaterials(_bot, _params) {
    // 2 chests = 16 planks = 4 logs. Gathering is handled inside execute().
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const stashX = Number(params.x);
    const stashY = Number(params.y);
    const stashZ = Number(params.z);
    const expanding = String(params.mode ?? "ensure").toLowerCase() === "expand";
    const requiredChests = expanding ? 1 : 2;

    if (isNaN(stashX) || isNaN(stashY) || isNaN(stashZ)) {
      return { success: false, message: "Invalid stash position — x, y, z must be numbers." };
    }

    const stashPos = new Vec3(stashX, stashY, stashZ);

    // --- Step 1: Walk to the stash position ---
    onProgress({
      skillName: "setup_stash",
      phase: "Navigating to stash",
      progress: 0.0,
      message: `Walking to stash at ${stashX}, ${stashY}, ${stashZ}...`,
      active: true,
    });

    try {
      await safeGoto(bot, new goals.GoalNear(stashX, stashY, stashZ, 3), 30000);
    } catch {
      return { success: false, message: "Could not navigate to stash position." };
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while navigating to stash." };
    }

    // Ground-snap Y: the configured stash Y is approximate — find the actual
    // surface at (x, z) so chest placement doesn't end up floating or buried.
    for (let y = stashY + 20; y >= stashY - 20; y--) {
      const block = bot.blockAt(new Vec3(stashX, y, stashZ));
      const above = bot.blockAt(new Vec3(stashX, y + 1, stashZ));
      if (
        block &&
        block.name !== "air" &&
        block.name !== "cave_air" &&
        block.name !== "water" &&
        !["chest", "trapped_chest", "crafting_table", "furnace"].includes(block.name) &&
        !block.name.includes("leaves") &&
        above &&
        (above.name === "air" || above.name === "short_grass" || above.name === "tall_grass")
      ) {
        stashPos.y = y + 1;
        break;
      }
    }

    // --- Step 2: Check if chests already exist nearby ---
    onProgress({
      skillName: "setup_stash",
      phase: "Checking for existing chests",
      progress: 0.15,
      message: "Scanning for nearby chests...",
      active: true,
    });

    const existingChestPositions = bot.findBlocks({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 10,
      count: 32,
    });
    const existingChest = existingChestPositions
      .map((position) => bot.blockAt(position))
      .find((block): block is NonNullable<typeof block> => !!block);
    const beforeChestKeys = new Set(
      existingChestPositions.map((position) => `${position.x},${position.y},${position.z}`),
    );

    if (existingChest && !expanding) {
      // A stash exists — check whether it still has room. If it's full,
      // fall through and place an additional chest (stash expansion).
      let hasRoom = true;
      try {
        const chest = await bot.openContainer(existingChest);
        const containerSlots = chest.inventoryStart;
        const used = chest.containerItems().length;
        hasRoom = used < containerSlots;
        chest.close();
      } catch {
        /* can't open — assume it has room to avoid pointless expansion */
      }

      if (hasRoom) {
        onProgress({
          skillName: "setup_stash",
          phase: "Done",
          progress: 1.0,
          message: "Stash already set up!",
          active: false,
        });
        return {
          success: true,
          message: `Stash already exists — chest found at ${existingChest.position.x}, ${existingChest.position.y}, ${existingChest.position.z}.`,
        };
      }
      onProgress({
        skillName: "setup_stash",
        phase: "Expanding stash",
        progress: 0.2,
        message: "Stash is full — placing an additional chest...",
        active: true,
      });
    } else if (existingChest && expanding) {
      onProgress({
        skillName: "setup_stash",
        phase: "Expanding stash",
        progress: 0.2,
        message: `Existing stash has ${beforeChestKeys.size} chest block(s); adding new capacity...`,
        active: true,
      });
    }

    // --- Step 3: Ensure we have the required chest items ---
    onProgress({
      skillName: "setup_stash",
      phase: "Preparing chests",
      progress: 0.25,
      message: "Checking inventory for chests...",
      active: true,
    });

    let chestCount = bot.inventory
      .items()
      .filter((i) => i.name === "chest")
      .reduce((sum, i) => sum + i.count, 0);

    if (chestCount < requiredChests) {
      // Need to craft chests — check for planks
      const planksHave = countAllPlanks(bot);
      const planksNeeded = (requiredChests - chestCount) * 8; // 8 planks per chest

      if (planksHave < planksNeeded) {
        // Try crafting planks from logs
        const logsHave = countAllLogs(bot);
        const plankDeficit = planksNeeded - planksHave;
        const logsNeeded = Math.ceil(plankDeficit / 4);

        if (logsHave < logsNeeded) {
          return {
            success: false,
            message: `Not enough materials for chests. Need ${planksNeeded} planks (have ${planksHave}) or ${logsNeeded} logs (have ${logsHave}). Gather wood first!`,
          };
        }

        // Craft logs into planks
        onProgress({
          skillName: "setup_stash",
          phase: "Crafting planks",
          progress: 0.35,
          message: "Turning logs into planks...",
          active: true,
        });

        await craftAllLogsToPlanks(bot, signal, logsNeeded);
      }

      if (signal.aborted) {
        return { success: false, message: "Interrupted while crafting planks." };
      }

      // Now craft chests — requires a crafting table (3x3 recipe)
      onProgress({
        skillName: "setup_stash",
        phase: "Crafting chests",
        progress: 0.5,
        message: "Crafting chests...",
        active: true,
      });

      // Ensure we have a crafting table
      await ensureCraftingTable(bot, signal);

      const chestsToMake = requiredChests - chestCount;
      const mcData = mcDataLoader(bot.version);
      const chestMcItem = mcData.itemsByName["chest"];

      if (!chestMcItem) {
        return { success: false, message: "Chest item not found in game data." };
      }

      const table = bot.findBlock({
        matching: (b) => b.name === "crafting_table",
        maxDistance: 32,
      });

      if (table) {
        // Navigate to crafting table
        try {
          setMovements(bot);
          await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15_000);
        } catch {
          /* try anyway */
        }

        for (let i = 0; i < chestsToMake && !signal.aborted; i++) {
          const recipe = bot.recipesFor(chestMcItem.id, null, 1, table)[0];
          if (!recipe) {
            return {
              success: false,
              message: `Can't find chest recipe. Have ${countAllPlanks(bot)} planks — need 8 per chest.`,
            };
          }
          try {
            await bot.craft(recipe, 1, table);
          } catch (e) {
            return { success: false, message: `Failed to craft chest: ${e}` };
          }
        }
      } else {
        // No table — try hand-crafting (unlikely to work for chests but try)
        for (let i = 0; i < chestsToMake && !signal.aborted; i++) {
          const recipe = bot.recipesFor(chestMcItem.id, null, 1, null)[0];
          if (!recipe) {
            return {
              success: false,
              message: "Need a crafting table to craft chests (3x3 recipe). Place one nearby.",
            };
          }
          try {
            await bot.craft(recipe, 1, undefined);
          } catch (e) {
            return { success: false, message: `Failed to craft chest: ${e}` };
          }
        }
      }

      // Verify we now have enough chests
      chestCount = bot.inventory
        .items()
        .filter((i) => i.name === "chest")
        .reduce((sum, i) => sum + i.count, 0);

      if (chestCount < requiredChests) {
        return {
          success: false,
          message: `Only crafted ${chestCount} chests — needed ${requiredChests}. Not enough planks.`,
        };
      }
    }

    if (signal.aborted) {
      return { success: false, message: "Interrupted while crafting chests." };
    }

    // --- Step 4: Place and verify new storage capacity ---
    onProgress({
      skillName: "setup_stash",
      phase: "Placing chests",
      progress: 0.7,
      message: expanding ? "Placing a separate expansion chest..." : "Placing double chest at stash...",
      active: true,
    });

    // Navigate back to stash pos if we wandered to find a crafting table
    try {
      await safeGoto(bot, new goals.GoalNear(stashX, stashY, stashZ, 3), 15000);
    } catch {
      /* close enough */
    }

    const firstPos = expanding ? findExpansionPosition(bot, stashPos, beforeChestKeys) : stashPos;
    if (!firstPos) {
      return {
        success: false,
        message: "No safe empty position for an expansion chest within the shared stash area.",
      };
    }

    // Place first chest at the selected position.
    const placed1 = await placeChestAt(bot, firstPos);
    if (!placed1) {
      return {
        success: false,
        message: expanding
          ? "Failed to place the expansion chest. Check the stash terrain."
          : "Failed to place first chest at stash position. Check terrain.",
      };
    }
    const verifiedFirst = bot.blockAt(firstPos);
    if (!verifiedFirst || (verifiedFirst.name !== "chest" && verifiedFirst.name !== "trapped_chest")) {
      return { success: false, message: "Chest placement returned without a chest block appearing in the world." };
    }

    if (expanding) {
      snapshotChest(firstPos, [], 27);
      const afterPositions = bot.findBlocks({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 10,
        count: 32,
      });
      const afterKeys = new Set(afterPositions.map((position) => `${position.x},${position.y},${position.z}`));
      const gained = [...afterKeys].filter((key) => !beforeChestKeys.has(key)).length;
      if (gained < 1) {
        return {
          success: false,
          message: "Expansion chest could not be distinguished from the existing stash; capacity was not verified.",
        };
      }
      onProgress({
        skillName: "setup_stash",
        phase: "Done",
        progress: 1,
        message: "Shared stash capacity expanded.",
        active: false,
      });
      return {
        success: true,
        message: `Placed and verified 1 expansion chest at (${firstPos.x}, ${firstPos.y}, ${firstPos.z}); shared capacity increased by 27 slots.`,
        stats: { chestsPlaced: 1, slotsAdded: 27 },
      };
    }

    onProgress({
      skillName: "setup_stash",
      phase: "Placing chests",
      progress: 0.85,
      message: "Placing second chest for double chest...",
      active: true,
    });

    // Place second chest adjacent (+1 on X axis) for double chest
    const secondPos = stashPos.offset(1, 0, 0);
    const placed2 = await placeChestAt(bot, secondPos);
    if (!placed2) {
      // Try other adjacent positions if +1 X didn't work
      const alternatives = [stashPos.offset(-1, 0, 0), stashPos.offset(0, 0, 1), stashPos.offset(0, 0, -1)];
      let placedAlt = false;
      for (const altPos of alternatives) {
        if (await placeChestAt(bot, altPos)) {
          placedAlt = true;
          break;
        }
      }
      if (!placedAlt) {
        snapshotChest(firstPos, [], 27);
        return {
          success: true, // one chest is better than none
          message: `Placed 1 chest at stash (${stashX}, ${stashY}, ${stashZ}) but couldn't place second for double chest. Terrain issue.`,
          stats: { chestsPlaced: 1 },
        };
      }
    }
    // One logical double-chest snapshot. Recording both physical halves would
    // later double-count capacity when Mineflayer opens either half as a
    // single 54-slot container.
    snapshotChest(firstPos, [], 54);

    onProgress({
      skillName: "setup_stash",
      phase: "Done",
      progress: 1.0,
      message: "Stash set up!",
      active: false,
    });

    return {
      success: true,
      message: `Stash bootstrapped! Double chest placed at (${stashX}, ${stashY}, ${stashZ}). Ready for deposits.`,
      stats: { chestsPlaced: 2 },
    };
  },
};

// --- Helpers ---

/**
 * Expansion chests are deliberately separated from existing chest blocks.
 * That avoids accidentally targeting an occupied half of a double chest and
 * makes the capacity increase observable as a new ledger entry.
 */
function findExpansionPosition(bot: Bot, stashPos: Vec3, occupied: ReadonlySet<string>): Vec3 | null {
  const offsets = [
    [0, 3],
    [3, 0],
    [-3, 0],
    [0, -3],
    [3, 3],
    [-3, 3],
    [3, -3],
    [-3, -3],
    [0, 6],
    [6, 0],
    [-6, 0],
    [0, -6],
  ] as const;
  for (const [dx, dz] of offsets) {
    let position: Vec3 | null = null;
    // Existing chests may sit several blocks above the surrounding terrain
    // (the current base chest is at Y=78 while nearby ground falls toward
    // Y=70). Search far enough downward to find real supported ground.
    for (let y = stashPos.y + 4; y >= stashPos.y - 16; y--) {
      const candidate = new Vec3(stashPos.x + dx, y, stashPos.z + dz);
      const target = bot.blockAt(candidate);
      const below = bot.blockAt(candidate.offset(0, -1, 0));
      if (
        target &&
        (target.name === "air" || target.name === "short_grass" || target.name === "tall_grass") &&
        below &&
        below.name !== "air" &&
        below.name !== "water" &&
        !below.name.includes("leaves")
      ) {
        position = candidate;
        break;
      }
    }
    if (!position) continue;
    if (occupied.has(`${position.x},${position.y},${position.z}`)) continue;
    return position;
  }
  return null;
}

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

/**
 * Craft logs into planks. Converts up to `maxLogs` logs of any type.
 */
async function craftAllLogsToPlanks(bot: Bot, signal: AbortSignal, maxLogs: number): Promise<void> {
  const mcData = mcDataLoader(bot.version);
  let converted = 0;

  for (const logType of LOG_TYPES) {
    if (signal.aborted || converted >= maxLogs) break;

    const logCount = bot.inventory
      .items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) continue;

    const toCraft = Math.min(logCount, maxLogs - converted);

    for (let i = 0; i < toCraft && !signal.aborted; i++) {
      const recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
      if (!recipe) break;
      try {
        await bot.craft(recipe, 1, undefined);
        converted++;
      } catch {
        break;
      }
    }
  }
}

/**
 * Ensure a crafting table is placed nearby. Crafts one from planks if needed.
 */
async function ensureCraftingTable(bot: Bot, signal: AbortSignal): Promise<void> {
  // Already placed nearby?
  const existing = bot.findBlock({
    matching: (b) => b.name === "crafting_table",
    maxDistance: 32,
  });
  if (existing) return;

  const mcData = mcDataLoader(bot.version);

  // Do we have one in inventory?
  let ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  if (!ctItem) {
    // Craft from planks
    const ctMcItem = mcData.itemsByName["crafting_table"];
    if (!ctMcItem) return;
    const recipe = bot.recipesFor(ctMcItem.id, null, 1, null)[0];
    if (recipe) {
      try {
        await bot.craft(recipe, 1, undefined);
      } catch {
        /* ok */
      }
    }
    ctItem = bot.inventory.items().find((i) => i.name === "crafting_table");
  }

  if (!ctItem || signal.aborted) return;

  // Place it on solid ground near the bot
  await bot.equip(ctItem, "hand");
  const pos = bot.entity.position.floored();
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  for (const [dx, dz] of offsets) {
    const below = bot.blockAt(new Vec3(pos.x + dx, pos.y - 1, pos.z + dz));
    const target = bot.blockAt(new Vec3(pos.x + dx, pos.y, pos.z + dz));
    if (below && below.name !== "air" && target && target.name === "air") {
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        console.log("[setup_stash] Placed crafting table");
        return;
      } catch {
        continue;
      }
    }
  }
}

/**
 * Place a chest from inventory at the given world position.
 * Returns true on success.
 */
async function placeChestAt(bot: Bot, targetPos: Vec3): Promise<boolean> {
  const chestItem = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestItem) return false;

  // Navigate close enough
  const dist = bot.entity.position.distanceTo(targetPos);
  if (dist > 4) {
    try {
      setMovements(bot);
      await safeGoto(bot, new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2), 12_000);
    } catch {
      /* try anyway */
    }
  }

  // Check if position is already occupied
  const blockAtTarget = bot.blockAt(targetPos);
  if (
    blockAtTarget &&
    blockAtTarget.name !== "air" &&
    blockAtTarget.name !== "short_grass" &&
    blockAtTarget.name !== "tall_grass"
  ) {
    // Already something there — check if it's already a chest
    if (blockAtTarget.name === "chest" || blockAtTarget.name === "trapped_chest") return true;
    return false;
  }

  await bot.equip(chestItem, "hand");

  // Find a solid reference block to place against
  const ref = findPlacementRef(bot, targetPos);
  if (!ref) return false;

  try {
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
    const ok = await Promise.race([
      bot
        .placeBlock(ref.block, ref.face)
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    return ok;
  } catch {
    return false;
  }
}

/** Find a solid block adjacent to targetPos that we can place against. */
function findPlacementRef(bot: Bot, targetPos: Vec3): { block: any; face: Vec3 } | null {
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
