import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import { safeGoto } from "../bot/navigation.js";
import { getBotMemoryStore } from "../bot/memory-registry.js";
const { goals, Movements } = pkg;

export const lightAreaSkill: Skill = {
  name: "light_area",
  description:
    "Place torches in a grid pattern around the bot (every 5 blocks, 15-block radius). Uses torches from inventory.",
  params: {
    x: { type: "number", description: "Optional center X" },
    y: { type: "number", description: "Optional center Y" },
    z: { type: "number", description: "Optional center Z" },
    safetyZone: { type: "string", description: "Optional durable settlement safety-zone identifier" },
  },

  estimateMaterials(_bot, _params) {
    // Uses whatever torches are in inventory, no gathering
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // Capture the work target before a stash visit moves the bot. Hierarchical
    // shelter lighting supplies the recorded house center explicitly.
    const requestedCenter =
      Number.isFinite(params?.x) && Number.isFinite(params?.y) && Number.isFinite(params?.z)
        ? new Vec3(Number(params.x), Number(params.y), Number(params.z))
        : bot.entity.position.floored();
    const countTorches = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "torch")
        .reduce((s, i) => s + i.count, 0);

    // Acquire torches if we have none: withdraw from the shared stash, else
    // CRAFT them from coal + sticks (the team mines coal constantly). Without
    // this, light_area just bailed "No torches" — and dark mining caves (mobs
    // spawn there even in frozen-day) are now the top death cause.
    if (countTorches() === 0 && !signal.aborted) {
      const stashPos = (params as { stashPos?: { x: number; y: number; z: number } } | undefined)?.stashPos;
      if (stashPos) {
        const { withdrawStash } = await import("./stash.js");
        try {
          await withdrawStash(bot, stashPos, "torch", 16);
        } catch {
          /* none in stash — craft below */
        }
      }
      if (countTorches() === 0) await craftTorches(bot);
    }

    if (countTorches() === 0) {
      return { success: false, message: "No torches and couldn't make any — need coal + sticks (planks)." };
    }
    const torchCount = countTorches();

    if (bot.entity.position.distanceTo(requestedCenter) > 6) {
      try {
        await safeGoto(bot, new goals.GoalNear(requestedCenter.x, requestedCenter.y, requestedCenter.z, 4), 35_000);
      } catch {
        return {
          success: false,
          message: `Got torches but could not return to the lighting target at (${requestedCenter.x}, ${requestedCenter.y}, ${requestedCenter.z}).`,
        };
      }
    }

    const center = requestedCenter.floored();
    const SPACING = 5;
    const RADIUS = 15;
    const positions: Vec3[] = [];

    // Generate torch grid positions
    for (let dx = -RADIUS; dx <= RADIUS; dx += SPACING) {
      for (let dz = -RADIUS; dz <= RADIUS; dz += SPACING) {
        if (dx === 0 && dz === 0) continue;
        const x = center.x + dx;
        const z = center.z + dz;

        // Find ground level
        for (let dy = 3; dy >= -3; dy--) {
          const y = center.y + dy;
          const block = bot.blockAt(new Vec3(x, y, z));
          const above = bot.blockAt(new Vec3(x, y + 1, z));
          if (block && block.name !== "air" && block.name !== "water" && above && above.name === "air") {
            positions.push(new Vec3(x, y + 1, z));
            break;
          }
        }
      }
    }

    // Sort by distance — try closest positions first so we can place at least some
    // even if far positions are blocked by water or terrain obstacles
    positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));

    let placed = 0;
    let newlyPlaced = 0;
    const total = Math.min(positions.length, Math.max(4, torchCount));

    for (let i = 0; i < positions.length && placed < total; i++) {
      if (signal.aborted) break;

      const pos = positions[i];

      try {
        const dist = bot.entity.position.distanceTo(pos);
        if (dist > 4.5) {
          const moves = new Movements(bot);
          moves.canDig = false;
          moves.allow1by1towers = false;
          moves.scafoldingBlocks = [];
          bot.pathfinder.setMovements(moves);
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)),
            new Promise<void>((_, rej) =>
              setTimeout(() => {
                bot.pathfinder.stop();
                rej(new Error("nav timeout"));
              }, 8000),
            ),
          ]);
        }

        // Place torch on the block below — re-check after navigation since world may have changed
        const below = bot.blockAt(pos.offset(0, -1, 0));
        const atPos = bot.blockAt(pos);
        if (atPos?.name === "torch" || atPos?.name === "wall_torch") {
          placed++;
          continue;
        }
        const torch = bot.inventory.items().find((it) => it.name === "torch");
        if (!torch) continue;
        // Skip if target spot is already occupied or ground is gone
        if (
          below &&
          below.name !== "air" &&
          below.name !== "water" &&
          atPos &&
          (atPos.name === "air" || atPos.name === "torch")
        ) {
          await bot.equip(torch, "hand");
          await bot.lookAt(below.position.offset(0.5, 1, 0.5));
          const ok = await Promise.race([
            bot
              .placeBlock(below, new Vec3(0, 1, 0))
              .then(() => true)
              .catch(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
          ]);
          if (ok) {
            placed++;
            newlyPlaced++;
          }
        }
      } catch {
        /* skip this position */
      }

      if (i % 3 === 0) {
        onProgress({
          skillName: "light_area",
          phase: "Placing torches",
          progress: placed / total,
          message: `${placed}/${total} torches placed`,
          active: true,
        });
      }
    }

    if (placed < 4) {
      return {
        success: false,
        message: `Couldn't establish a safe lighting grid: only ${placed}/4 minimum positions were verified.`,
        stats: { torchesPlaced: newlyPlaced, lightingPositionsVerified: placed },
      };
    }

    const safetyZone = String(params?.safetyZone ?? "").trim();
    if (safetyZone) {
      getBotMemoryStore(bot)?.recordSafetyZone(
        safetyZone,
        { x: center.x, y: center.y, z: center.z },
        placed,
      );
    }

    return {
      success: true,
      message: `Lit up ${safetyZone || "the area"}! Verified ${placed} grid positions (${newlyPlaced} new torches).`,
      stats: { torchesPlaced: newlyPlaced, lightingPositionsVerified: placed },
    };
  },
};

/** Craft torches from coal/charcoal + sticks (crafting sticks from planks if needed). */
async function craftTorches(bot: Bot): Promise<void> {
  const mcDataMod = await import("minecraft-data");
  const mcData = mcDataMod.default(bot.version);
  const has = (n: string) =>
    bot.inventory
      .items()
      .filter((i) => i.name === n)
      .reduce((s, i) => s + i.count, 0);

  // Need sticks — craft from any planks if short.
  if (has("stick") === 0) {
    const stick = mcData.itemsByName["stick"];
    const planks = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
    if (stick && planks) {
      const recipe = bot.recipesFor(stick.id, null, 1, null)[0];
      if (recipe) {
        try {
          await bot.craft(recipe, 1, undefined);
        } catch {
          /* best effort */
        }
      }
    }
  }

  const hasFuel = has("coal") > 0 || has("charcoal") > 0;
  if (!hasFuel || has("stick") === 0) return; // can't craft torches without both

  const torch = mcData.itemsByName["torch"];
  if (!torch) return;
  const recipe = bot.recipesFor(torch.id, null, 1, null)[0];
  if (recipe) {
    try {
      await bot.craft(recipe, Math.min(has("coal") + has("charcoal"), 4), undefined);
    } catch {
      /* best effort */
    }
  }
}
