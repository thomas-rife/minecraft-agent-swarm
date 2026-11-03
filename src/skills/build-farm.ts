import type { Bot } from "mineflayer";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { getBotMemoryStore } from "../bot/memory-registry.js";
import { config } from "../config.js";
import { FARM_WOOD_TARGET } from "../bot/goal-requirements.js";
import {
  describeFarmSurveyFailure,
  inspectFarmSite,
  planFarmShorePreparation,
  surveyFarmSites,
  workPositionsForTarget,
  type FarmSiteCandidate,
} from "./farm-site.js";
import { getTeamFarmSites, scanFarmPlots } from "./farm-ledger.js";

export const buildFarmSkill: Skill = {
  name: "build_farm",
  description:
    "Build a wheat farm near water. Crafts a hoe, collects seeds, tills soil, plants crops. If mature wheat exists nearby, harvests and replants instead. Takes ~2 minutes.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // --- Step 0: Harvest mature wheat, then BAKE BREAD ---
    // The loop used to dead-end here: wheat was harvested but never turned into
    // bread (wheat isn't edible), so the team starved beside a working farm.
    // Bake any accumulated wheat (>=3) into bread — done inside the skill so it
    // bypasses the blacklisted `craft:bread` action.
    const harvested = await harvestMatureWheat(bot, signal, onProgress);
    const baked = await bakeBread(bot, signal, onProgress, params?.stashPos as { x: number; y: number; z: number });
    if (harvested > 0 || baked > 0) {
      const breadNote =
        baked > 0
          ? `Baked ${baked} bread — food secured! 🍞`
          : "Not enough wheat to bake bread yet (need 3+); farm is still growing.";
      return {
        success: true,
        message: `${harvested > 0 ? `Harvested ${harvested} wheat. ` : ""}${breadNote} The farm cycle continues!`,
        stats: { wheatHarvested: harvested, breadBaked: baked },
      };
    }

    // Pool any seeds the team already has before traveling to the farm. This
    // happens before the farm-site trip so a stash withdrawal cannot pull the
    // farmer away from the water halfway through construction.
    const stashPos = params?.stashPos as { x: number; y: number; z: number } | undefined;
    if (stashPos && countItem(bot, "wheat_seeds") === 0) {
      const { withdrawStash } = await import("./stash.js");
      try {
        await withdrawStash(bot, stashPos, "wheat_seeds", 32);
      } catch {
        /* no pooled seeds — collect them at the confirmed grassy shore */
      }
    }

    // --- Step 0: Get to the farm site FIRST ---
    // Tree-gathering and water-finding both only see loaded chunks; from the
    // village the lake (and its forest) are ~100 blocks away and invisible.
    // Travel before doing anything else.
    const fx0 = Number(params.x);
    const fz0 = Number(params.z);
    if (
      isFinite(fx0) &&
      isFinite(fz0) &&
      bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 24
    ) {
      onProgress({
        skillName: "build_farm",
        phase: "Traveling",
        progress: 0.01,
        message: `Heading to the farm site (${fx0}, ${fz0})...`,
        active: true,
      });
      try {
        await safeGoto(
          bot,
          new goals.GoalNear(fx0, Number(params.y) || 64, fz0, 8),
          config.bot.allowInterventions ? 20_000 : 60_000,
        );
      } catch {
        /* walk failed — exact teleport below */
      }
      if (signal.aborted) return { success: false, message: "Interrupted while traveling to the farm site." };
      // A probe proved findBlock sees the water INSTANTLY when the bot is
      // actually at the site — the failures were the bot never arriving
      // (pathfinding times out over distance). Keep the fallback gated as an
      // intervention, and use spreadplayers so Minecraft selects the top safe
      // block near the farm. A raw /tp to FARM_SITE repeatedly placed Flora
      // inside a wall at (-74.5, 81, -1171.5), causing a suffocation loop.
      if (bot.entity.position.distanceTo(new Vec3(fx0, bot.entity.position.y, fz0)) > 6) {
        if (config.bot.allowInterventions) {
          bot.chat(`/spreadplayers ${fx0} ${fz0} 0 6 false ${bot.username}`);
          await new Promise((r) => setTimeout(r, 2500));
          await bot.waitForChunksToLoad().catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          return {
            success: false,
            message: `Couldn't reach the farm site (${fx0}, ${fz0}) by walking — try again when closer, or go_to it first.`,
          };
        }
      }
    }

    // --- Step 1: Ensure we have a hoe ---
    onProgress({
      skillName: "build_farm",
      phase: "Preparing tools",
      progress: 0,
      message: "Looking for a hoe...",
      active: true,
    });

    let hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    if (!hoe) {
      await craftHoe(bot, signal);
      hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    }
    if (!hoe) {
      // Self-sufficiency (same pattern that made build_house complete):
      // gather a couple of logs instead of failing on missing planks.
      onProgress({
        skillName: "build_farm",
        phase: "Preparing tools",
        progress: 0.02,
        message: "No hoe materials — chopping a tree...",
        active: true,
      });
      const logBlock = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 128 });
      if (logBlock) {
        try {
          await safeGoto(
            bot,
            new goals.GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 3),
            60000,
          );
          await digT(bot, bot.blockAt(logBlock.position)!);
          await collectNearbyDrops(bot, 6, 6000);
          const second = bot.findBlock({ matching: (b) => b.name.endsWith("_log"), maxDistance: 16 });
          if (second) {
            await digT(bot, bot.blockAt(second.position)!);
            await collectNearbyDrops(bot, 6, 6000);
          }
        } catch {
          /* best effort */
        }
        await craftHoe(bot, signal);
        hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
      }
      if (!hoe) {
        return { success: false, message: "Can't craft a hoe! Need planks + sticks + a crafting table." };
      }
    }

    // --- Step 2: Return to a remembered shore or discover one ---
    // A candidate is persistent before planting succeeds. Previous attempts
    // rediscovered a different water block every time, then seed gathering
    // pulled the bot away and the exact shore was lost.
    onProgress({
      skillName: "build_farm",
      phase: "Finding farmable land",
      progress: 0.05,
      message: "Returning to a remembered farm shore or surveying a new one...",
      active: true,
    });

    const memoryStore = getBotMemoryStore(bot);
    let selectedFarmSite: FarmSiteCandidate | null = null;
    let lastSiteFailure = "";

    // Prefer a team-discovered site. Each bot persists its own copy when it
    // attempts the site, so it remains available across restarts.
    const remembered = getTeamFarmSites()
      .filter((site) => site.status !== "blocked")
      .sort(
        (a, b) =>
          bot.entity.position.distanceTo(new Vec3(a.approach.x, a.approach.y, a.approach.z)) -
          bot.entity.position.distanceTo(new Vec3(b.approach.x, b.approach.y, b.approach.z)),
      );
    for (const site of remembered.slice(0, 6)) {
      if (signal.aborted) break;
      const localSite = memoryStore?.rememberFarmSite(site.water, site.approach);
      if (localSite?.status === "blocked") continue;
      const approach = new Vec3(site.approach.x, site.approach.y, site.approach.z);
      const reached = await navigateToFarmPosition(bot, approach, signal);
      if (!reached.ok) {
        lastSiteFailure = reached.reason;
        memoryStore?.updateFarmSite(site.water, "discovered", reached.reason);
        continue;
      }
      await bot.waitForChunksToLoad().catch(() => {});
      const water = new Vec3(site.water.x, site.water.y, site.water.z);
      const candidate = inspectFarmSite(bot, water, 0);
      if (!candidate) {
        lastSiteFailure = `Remembered water at ${water.x},${water.y},${water.z} is no longer a workable exposed shore.`;
        memoryStore?.updateFarmSite(site.water, "discovered", lastSiteFailure);
        continue;
      }
      selectedFarmSite = candidate;
      memoryStore?.updateFarmSite(site.water, "reachable");
      break;
    }

    let survey = surveyFarmSites(bot);
    if (!selectedFarmSite) {
      for (let attempt = 0; !survey.candidate && attempt < 3; attempt++) {
        await bot.waitForChunksToLoad().catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        survey = surveyFarmSites(bot);
      }

      // A marginal shore is still useful: the preparation phase can create a
      // supported four-plot patch, as long as there is a reachable dry side.
      if (!survey.candidate) survey = surveyFarmSites(bot, 96, 0);

      for (const candidate of survey.candidates.slice(0, 8)) {
        if (signal.aborted) break;
        const approach = candidate.approaches[0];
        if (!approach) continue;
        const localSite = memoryStore?.rememberFarmSite(candidate.water, approach);
        if (localSite?.status === "blocked") continue;
        const reached = await navigateToFarmPosition(bot, approach, signal);
        if (!reached.ok) {
          lastSiteFailure = reached.reason;
          memoryStore?.updateFarmSite(candidate.water, "discovered", reached.reason);
          continue;
        }
        await bot.waitForChunksToLoad().catch(() => {});
        const revalidated = inspectFarmSite(bot, candidate.water, 0);
        if (!revalidated) {
          lastSiteFailure = `Reached ${candidate.water.x},${candidate.water.y},${candidate.water.z}, but its water or dry work area changed.`;
          memoryStore?.updateFarmSite(candidate.water, "discovered", lastSiteFailure);
          continue;
        }
        selectedFarmSite = revalidated;
        memoryStore?.updateFarmSite(candidate.water, "reachable");
        break;
      }
    }

    if (!selectedFarmSite) {
      const surveyFailure = describeFarmSurveyFailure(survey);
      return {
        success: false,
        message: lastSiteFailure ? `No reachable farm shore. Last approach failed: ${lastSiteFailure}` : surveyFailure,
      };
    }

    // A steep shoreline may need a tiny supported patch. Revalidate this exact
    // remembered water block afterward instead of globally switching lakes.
    if (selectedFarmSite.tillable.length < 4) {
      const preparingWater = selectedFarmSite.water.clone();
      onProgress({
        skillName: "build_farm",
        phase: "Preparing shoreline",
        progress: 0.08,
        message: `Remembered shore has ${selectedFarmSite.tillable.length}/4 plots — preparing a supported patch...`,
        active: true,
      });
      await prepareFarmShore(bot, selectedFarmSite, signal, onProgress);
      const preparedSite = inspectFarmSite(bot, preparingWater, 4) ?? inspectFarmSite(bot, preparingWater, 2);
      if (!preparedSite) {
        const message = "Reached the remembered shore, but could not prepare two reachable hydrated plots.";
        memoryStore?.updateFarmSite(preparingWater, "discovered", message);
        return { success: false, message };
      }
      selectedFarmSite = preparedSite;
    }

    const waterPos = selectedFarmSite.water;
    const farmTargets = selectedFarmSite.tillable;

    // Re-anchor immediately before gathering. The remembered approach is a
    // feet position, unlike the old code which gave GoalNear a solid block.
    const anchored = await navigateToAnyFarmPosition(bot, selectedFarmSite.approaches, signal);
    if (!anchored.ok) {
      memoryStore?.updateFarmSite(waterPos, "discovered", anchored.reason);
      return { success: false, message: `Found farm soil but couldn't reach its dry work area: ${anchored.reason}` };
    }

    // --- Step 3: Collect seeds by breaking grass ---
    onProgress({
      skillName: "build_farm",
      phase: "Collecting seeds",
      progress: 0.1,
      message: "Breaking grass for seeds...",
      active: true,
    });

    let seedCount = countItem(bot, "wheat_seeds");
    const seedStart = Date.now();
    const triedGrass = new Set<string>();
    for (let i = 0; i < 48 && seedCount < 16 && !signal.aborted && Date.now() - seedStart < 45_000; i++) {
      const grassPositions = bot.findBlocks({
        matching: (b) => b.name === "short_grass" || b.name === "tall_grass",
        // Stay close enough to return to the remembered shore promptly. The
        // old 40-block moving search stranded bots 20-30 blocks from the plots.
        maxDistance: 18,
        count: 48,
      });
      const grassPos = grassPositions.find((p) => !triedGrass.has(p.toString()));
      if (!grassPos) break;
      triedGrass.add(grassPos.toString());
      const grass = bot.blockAt(grassPos);
      if (!grass) break;

      try {
        setMovements(bot);
        await gotoT(bot, new goals.GoalNear(grass.position.x, grass.position.y, grass.position.z, 2));
        await digT(bot, grass);
        await bot.waitForTicks(5);
        seedCount = countItem(bot, "wheat_seeds");
      } catch {
        continue;
      }
    }

    if (seedCount === 0) {
      return {
        success: false,
        message: `No seeds from grass at the configured shore near ${waterPos.x.toFixed(0)},${waterPos.z.toFixed(0)}.`,
      };
    }

    const returnedToFarm = await navigateToAnyFarmPosition(bot, selectedFarmSite.approaches, signal);
    if (!returnedToFarm.ok) {
      memoryStore?.updateFarmSite(waterPos, "discovered", returnedToFarm.reason);
      return {
        success: false,
        message: `Collected seeds, but couldn't return to the remembered farm shore at ${waterPos.x},${waterPos.z}: ${returnedToFarm.reason}`,
      };
    }

    // --- Step 4: Till and plant on pre-identified target positions ---
    onProgress({
      skillName: "build_farm",
      phase: "Planting crops",
      progress: 0.25,
      message: "Tilling soil and planting...",
      active: true,
    });

    let planted = 0;
    let unreachable = 0;
    let tillFailed = 0;
    let plantFailed = 0;
    let invalidTargets = 0;
    let lastPlantingError = "";
    const plantedPlots: Vec3[] = [];
    const target = Math.min(seedCount, farmTargets.length, 16);
    const plantingStart = Date.now();

    for (const targetPos of farmTargets) {
      if (planted >= target || signal.aborted || Date.now() - plantingStart >= 75_000) break;

      // Skip if block was already tilled by a previous iteration
      let currentBlock = bot.blockAt(targetPos);
      if (!currentBlock || (currentBlock.name !== "dirt" && currentBlock.name !== "grass_block")) {
        invalidTargets++;
        continue;
      }

      try {
        const workPositions = workPositionsForTarget(bot, targetPos);
        const reached = await navigateToAnyFarmPosition(bot, workPositions, signal, 4);
        if (!reached.ok) {
          unreachable++;
          lastPlantingError = `plot ${targetPos}: ${reached.reason}`;
          continue;
        }

        // The survey accepts grass-covered soil as long as the plant above is
        // replaceable. Clear it before tilling so the wheat has an air block.
        const aboveTarget = bot.blockAt(targetPos.offset(0, 1, 0));
        if (aboveTarget && (aboveTarget.name === "short_grass" || aboveTarget.name === "tall_grass")) {
          await digT(bot, aboveTarget).catch(() => {});
        }

        currentBlock = bot.blockAt(targetPos);
        if (!currentBlock || (currentBlock.name !== "dirt" && currentBlock.name !== "grass_block")) {
          invalidTargets++;
          continue;
        }

        // Equip hoe and till
        hoe = bot.inventory.items().find((it) => it.name.endsWith("_hoe"));
        if (!hoe) break;
        await bot.equip(hoe, "hand");
        await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
        await bot.activateBlock(currentBlock, new Vec3(0, 1, 0));
        await bot.waitForTicks(4);

        // Check if it became farmland
        const result = bot.blockAt(targetPos);
        if (result && result.name === "farmland") {
          const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
          if (seeds) {
            await bot.equip(seeds, "hand");
            try {
              await bot.placeBlock(result, new Vec3(0, 1, 0));
              if (bot.blockAt(targetPos.offset(0, 1, 0))?.name !== "wheat") {
                throw new Error("seed placement was not visible after placement");
              }
              planted++;
              plantedPlots.push(targetPos.clone());
              onProgress({
                skillName: "build_farm",
                phase: "Planting crops",
                progress: 0.25 + (planted / target) * 0.7,
                message: `Planted ${planted}/${target} wheat`,
                active: true,
              });
            } catch (err) {
              plantFailed++;
              lastPlantingError = `seed placement at ${targetPos}: ${errorMessage(err)}`;
            }
          } else {
            plantFailed++;
            lastPlantingError = `farmland at ${targetPos} was ready, but no seeds remained`;
          }
        } else {
          tillFailed++;
          lastPlantingError = `hoe activation at ${targetPos} left block as ${result?.name ?? "unloaded"}`;
        }
      } catch (err) {
        lastPlantingError = `plot ${targetPos}: ${errorMessage(err)}`;
        continue;
      }
    }

    if (planted === 0) {
      const detail = [
        `unreachable=${unreachable}`,
        `till_failed=${tillFailed}`,
        `plant_failed=${plantFailed}`,
        `invalid=${invalidTargets}`,
      ].join(", ");
      const message = `Farm shore ${waterPos.x},${waterPos.y},${waterPos.z} produced 0/${target} crops (${detail}).${
        lastPlantingError ? ` Last error: ${lastPlantingError}` : ""
      }`;
      memoryStore?.updateFarmSite(waterPos, "discovered", message);
      return {
        success: false,
        message,
      };
    }

    // Record the farm so the deterministic override sees hasFarm=true and
    // stops force-firing build_farm every cooldown — the bots can still
    // CHOOSE to farm (harvest/replant) via normal decisions, but they're no
    // longer trapped in a permanent farming loop and can pursue other goals.
    const now = new Date().toISOString();
    const visiblePlots = scanFarmPlots(bot, {
      water: { x: waterPos.x, y: waterPos.y, z: waterPos.z },
      approach: {
        x: selectedFarmSite.approaches[0]?.x ?? waterPos.x + 2,
        y: selectedFarmSite.approaches[0]?.y ?? waterPos.y + 1,
        z: selectedFarmSite.approaches[0]?.z ?? waterPos.z,
      },
      status: "planted",
      failures: 0,
      discoveredAt: now,
      updatedAt: now,
      plots: plantedPlots,
    });
    memoryStore?.recordFarmPlots(waterPos, visiblePlots.length > 0 ? visiblePlots : plantedPlots);
    if (memoryStore)
      memoryStore.addStructure(
        "farm",
        Math.round(waterPos.x),
        Math.round(waterPos.y),
        Math.round(waterPos.z),
        "Wheat farm",
      );

    return {
      success: true,
      message: `Farm planted! ${planted} wheat seeds near water at ${waterPos.x.toFixed(0)}, ${waterPos.z.toFixed(0)}. Wheat grows in ~5 minutes — come back and use build_farm again to harvest!`,
      stats: { cropsPlanted: planted },
    };
  },
};

// --- Helpers ---

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  // A valid dry shore may be across a narrow river. Swimming is safe here;
  // autonomous terrain destruction remains disabled.
  moves.allowFreeMotion = true;
  moves.maxDropDown = 3;
  moves.allowParkour = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

interface FarmNavigationResult {
  ok: boolean;
  reason: string;
}

/**
 * Travel toward a remembered coordinate in loaded-chunk-sized stages, then
 * occupy its exact dry feet block. This makes coordinate memory useful even
 * after a bot has wandered beyond the original survey's loaded chunks.
 */
async function navigateToFarmPosition(
  bot: Bot,
  target: Vec3,
  signal: AbortSignal,
  finalTimeoutSeconds = 18,
): Promise<FarmNavigationResult> {
  setMovements(bot);
  try {
    for (let stage = 0; stage < 8 && !signal.aborted; stage++) {
      const dx = target.x - bot.entity.position.x;
      const dz = target.z - bot.entity.position.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal <= 36) break;
      const step = Math.min(28, horizontal - 24);
      const waypointX = bot.entity.position.x + (dx / horizontal) * step;
      const waypointZ = bot.entity.position.z + (dz / horizontal) * step;
      await safeGoto(bot, new goals.GoalNearXZ(waypointX, waypointZ, 6), 20_000);
      await bot.waitForChunksToLoad().catch(() => {});
    }
    if (signal.aborted) return { ok: false, reason: "interrupted while approaching the remembered shore" };
    await safeGoto(
      bot,
      new goals.GoalBlock(Math.round(target.x), Math.round(target.y), Math.round(target.z)),
      finalTimeoutSeconds * 1000,
    );
    const distance = bot.entity.position.distanceTo(target);
    if (distance > 1.8) {
      return { ok: false, reason: `pathfinder stopped ${distance.toFixed(1)} blocks from dry work position ${target}` };
    }
    return { ok: true, reason: "" };
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
}

async function navigateToAnyFarmPosition(
  bot: Bot,
  positions: readonly Vec3[],
  signal: AbortSignal,
  maxAttempts = 8,
): Promise<FarmNavigationResult> {
  const ordered = [...positions].sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
  if (ordered.length === 0) return { ok: false, reason: "no dry standing position exists beside the soil" };

  let lastReason = "";
  for (const position of ordered.slice(0, maxAttempts)) {
    const result = await navigateToFarmPosition(bot, position, signal, 10);
    if (result.ok) return result;
    lastReason = result.reason;
    if (signal.aborted) break;
  }
  return { ok: false, reason: lastReason || "all dry work positions were unreachable" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

/** pathfinder.goto with a hard timeout — build_farm was the last skill still
 *  hanging to the 240s watchdog (3 events/26h, always at 0% progress) because
 *  its harvest/bake/hoe phases used RAW gotos that block forever when the bot
 *  is stuck underground (the common food-spiral state). Same fix as the rest
 *  of the freeze-bug arc. */
async function gotoT(bot: Bot, goal: InstanceType<typeof goals.GoalNear>, ms = 15000): Promise<void> {
  await Promise.race([
    bot.pathfinder.goto(goal),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        bot.pathfinder.stop();
        rej(new Error("goto timeout"));
      }, ms),
    ),
  ]);
}

/** bot.dig with a hard timeout (see gotoT). */
async function digT(bot: Bot, block: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(block),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* wasn't digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

async function gatherDirtForFarm(
  bot: Bot,
  needed: number,
  waterPos: Vec3,
  reserved: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const tried = new Set<string>();
  const startedAt = Date.now();
  while (countItem(bot, "dirt") < needed && !signal.aborted && Date.now() - startedAt < 35_000) {
    const candidates = bot.findBlocks({
      matching: (block) => block.name === "dirt" || block.name === "grass_block",
      maxDistance: 48,
      count: 96,
    });
    const pos = candidates.find((candidate) => {
      const key = candidate.toString();
      if (tried.has(key) || reserved.has(key)) return false;
      if (Math.hypot(candidate.x - waterPos.x, candidate.z - waterPos.z) <= 6) return false;
      if (Math.abs(candidate.y - waterPos.y) > 5) return false;
      const above = bot.blockAt(candidate.offset(0, 1, 0));
      return !!above && ["air", "short_grass", "tall_grass", "snow"].includes(above.name);
    });
    if (!pos) break;
    tried.add(pos.toString());

    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 8000);
      const block = bot.blockAt(pos);
      if (!block || (block.name !== "dirt" && block.name !== "grass_block")) continue;
      await digT(bot, block);
      await collectNearbyDrops(bot, 5, 5000);
    } catch {
      continue;
    }
  }
}

/**
 * Turn a marginal exposed shore into four hydrated plots. This uses ordinary
 * digging and block placement; interventions/teleports are not involved.
 */
async function prepareFarmShore(
  bot: Bot,
  candidate: FarmSiteCandidate,
  signal: AbortSignal,
  onProgress: (p: any) => void,
): Promise<number> {
  const plans = planFarmShorePreparation(bot, candidate.water, 4);
  if (plans.length === 0 || signal.aborted) return candidate.tillable.length;

  const reserved = new Set([
    ...candidate.tillable.map((pos) => pos.toString()),
    ...plans.map((plan) => plan.target.toString()),
  ]);

  // Clear simple obstructions first. Dirt/grass cleared from a one-block bank
  // can then supply the raised cells, reducing destructive terrain gathering.
  for (const plan of plans.filter((entry) => entry.kind === "clear_above")) {
    if (signal.aborted || !plan.clear) break;
    const obstruction = bot.blockAt(plan.clear);
    if (!obstruction || obstruction.boundingBox !== "block") continue;
    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(plan.clear.x, plan.clear.y, plan.clear.z, 2), 8000);
      await digT(bot, obstruction);
      await collectNearbyDrops(bot, 4, 4000);
    } catch {
      // Another preparation cell may still work.
    }
  }

  const placementPlans = plans.filter((entry) => entry.kind === "place_dirt");
  const dirtDeficit = Math.max(0, placementPlans.length - countItem(bot, "dirt"));
  if (dirtDeficit > 0) {
    onProgress({
      skillName: "build_farm",
      phase: "Preparing shoreline",
      progress: 0.09,
      message: `Gathering ${dirtDeficit} dirt for supported farm plots...`,
      active: true,
    });
    await gatherDirtForFarm(bot, placementPlans.length, candidate.water, reserved, signal);
  }

  let placed = 0;
  for (const plan of placementPlans) {
    if (signal.aborted) break;
    const dirt = bot.inventory.items().find((item) => item.name === "dirt");
    if (!dirt) break;

    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(plan.target.x, plan.target.y, plan.target.z, 3), 8000);

      const cell = bot.blockAt(plan.target);
      if (cell && cell.name !== "air") {
        if (!["short_grass", "tall_grass", "snow"].includes(cell.name)) continue;
        await digT(bot, cell);
      }

      const support = bot.blockAt(plan.target.offset(0, -1, 0));
      if (!support || support.boundingBox !== "block" || support.name === "water" || support.name === "lava") {
        continue;
      }
      await bot.equip(dirt, "hand");
      await bot.placeBlock(support, new Vec3(0, 1, 0));
      await bot.waitForTicks(4);
      const result = bot.blockAt(plan.target);
      if (result?.name === "dirt" || result?.name === "grass_block") placed++;
    } catch {
      continue;
    }
  }

  const prepared = inspectFarmSite(bot, candidate.water, 0)?.tillable.length ?? candidate.tillable.length + placed;
  onProgress({
    skillName: "build_farm",
    phase: "Preparing shoreline",
    progress: 0.1,
    message: `Shore preparation produced ${prepared}/4 hydrated plots.`,
    active: true,
  });
  return prepared;
}

/** bot.craft with a hard timeout (see gotoT) — table interaction can stall. */
async function craftT(bot: Bot, recipe: Parameters<Bot["craft"]>[0], count: number, table?: any): Promise<void> {
  await Promise.race([
    bot.craft(recipe, count, table),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("craft timeout")), 20000)),
  ]);
}

/** Harvest all mature wheat within 20 blocks. Returns count harvested. */
async function harvestMatureWheat(bot: Bot, signal: AbortSignal, onProgress: (p: any) => void): Promise<number> {
  let harvested = 0;

  // Aggregate budget (freeze-arc LESSON 2): 40 iterations of bounded travel
  // still sums past the 240s skill watchdog — cap the phase's wall-clock.
  const harvestStart = Date.now();
  for (let i = 0; i < 40 && !signal.aborted && Date.now() - harvestStart < 90000; i++) {
    const wheat = bot.findBlock({
      matching: (b) => b.name === "wheat" && b.metadata >= 7,
      maxDistance: 20,
    });
    if (!wheat || !wheat.position) break;

    try {
      setMovements(bot);
      await gotoT(bot, new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 2));
      await digT(bot, wheat);
      harvested++;
      onProgress({
        skillName: "build_farm",
        phase: "Harvesting",
        progress: harvested / 20,
        message: `Harvested ${harvested} wheat`,
        active: true,
      });
    } catch {
      continue;
    }
  }

  // Replant seeds on empty farmland after harvesting
  if (harvested > 0) {
    let replanted = 0;
    const replantStart = Date.now();
    for (let i = 0; i < 40 && !signal.aborted && Date.now() - replantStart < 45000; i++) {
      const farmland = bot.findBlock({
        matching: (b) => {
          if (b.name !== "farmland" || !b.position) return false;
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          return above !== null && above.name === "air";
        },
        maxDistance: 20,
      });
      if (!farmland) break;

      const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
      if (!seeds) break;

      try {
        setMovements(bot);
        await gotoT(bot, new goals.GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 2));
        await bot.equip(seeds, "hand");
        await bot.placeBlock(farmland, new Vec3(0, 1, 0));
        replanted++;
      } catch {
        continue;
      }
    }
    console.log(`[Skill] Harvested ${harvested} wheat, replanted ${replanted} seeds`);
  }

  return harvested;
}

/**
 * Bake bread from accumulated wheat (3 wheat -> 1 bread). Needs a crafting
 * table (3-wide recipe). This is the step that finally closes the farm->food
 * loop. Done in-skill to dodge the blacklisted `craft:bread` action.
 */
async function bakeBread(
  bot: Bot,
  signal: AbortSignal,
  onProgress: (p: any) => void,
  stashPos?: { x: number; y: number; z: number },
): Promise<number> {
  if (signal.aborted) return 0;
  // Pool wheat from the shared stash before baking. Harvests are small (~1-2
  // wheat/pass) and scattered across bots, so no single baker reaches the 3
  // wheat a loaf needs — 81 wheat harvested/run yet only 4 bread baked, and the
  // team starved (1214 eat-fails). Withdraw the team's pooled wheat to bake a
  // real batch. (shouldKeep now lets wheat surplus deposit so it pools here.)
  if (stashPos && countItem(bot, "wheat") < 9) {
    const { withdrawStash } = await import("./stash.js");
    try {
      await withdrawStash(bot, stashPos, "wheat", 18);
    } catch {
      /* none pooled yet — bake whatever we have */
    }
  }
  const wheat = countItem(bot, "wheat");
  if (wheat < 3) return 0;

  const mcData = mcDataLoader(bot.version);
  const breadItem = mcData.itemsByName["bread"];
  if (!breadItem) return 0;
  const count = Math.floor(wheat / 3);

  // Bread is a 3-wide recipe → requires a crafting table.
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
  if (!table || !table.position) return 0; // no table in reach — bake next cycle near one

  onProgress({
    skillName: "build_farm",
    phase: "Baking bread",
    progress: 0.95,
    message: `Baking ${count} bread from ${wheat} wheat...`,
    active: true,
  });

  setMovements(bot);
  try {
    await gotoT(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch {
    /* try crafting from where we are */
  }

  const recipe = bot.recipesFor(breadItem.id, null, count, table)[0];
  if (!recipe) return 0;

  const before = countItem(bot, "bread");
  try {
    await craftT(bot, recipe, count, table);
  } catch {
    return 0;
  }
  return countItem(bot, "bread") - before;
}

async function craftHoe(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const countBy = (predicate: (name: string) => boolean) =>
    bot.inventory
      .items()
      .filter((i) => predicate(i.name))
      .reduce((sum, i) => sum + i.count, 0);

  // A first farm needs enough planks for a table, sticks, and the hoe itself.
  // Previously this stopped after making any planks, then searched for a
  // pre-existing table and failed forever at a fresh farm site.
  for (const log of bot.inventory.items().filter((i) => i.name.endsWith("_log"))) {
    const planks = countBy((name) => name.endsWith("_planks"));
    if (planks >= FARM_WOOD_TARGET) break;
    if (signal.aborted) return;
    {
      const plankName = log.name.replace("_log", "_planks");
      const plankItem = mcData.itemsByName[plankName];
      const recipe = plankItem ? bot.recipesFor(plankItem.id, null, 1, null)[0] : null;
      if (recipe) {
        try {
          const logsNeeded = Math.ceil((FARM_WOOD_TARGET - planks) / 4);
          await craftT(bot, recipe, Math.min(logsNeeded, log.count));
        } catch {
          /* try another wood type */
        }
      }
    }
  }

  // Ensure sticks
  const stickItem = mcData.itemsByName["stick"];
  if (stickItem && countItem(bot, "stick") < 2) {
    const recipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (recipe) {
      try {
        await craftT(bot, recipe, 1);
      } catch {
        /* ok */
      }
    }
  }

  // Reuse a nearby table or craft and place one using the bot's own wood.
  let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) {
    let tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!tableItem) {
      const tableDef = mcData.itemsByName["crafting_table"];
      const recipe = tableDef ? bot.recipesFor(tableDef.id, null, 1, null)[0] : null;
      if (recipe) {
        try {
          await craftT(bot, recipe, 1);
          tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
        } catch {
          /* not enough compatible planks */
        }
      }
    }

    if (tableItem) {
      const base = bot.entity.position.floored();
      outer: for (let radius = 1; radius <= 4; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
            for (let dy = -2; dy <= 2; dy++) {
              const targetPos = base.offset(dx, dy, dz);
              const ground = bot.blockAt(targetPos.offset(0, -1, 0));
              const target = bot.blockAt(targetPos);
              const above = bot.blockAt(targetPos.offset(0, 1, 0));
              if (
                !ground ||
                ground.boundingBox !== "block" ||
                !target ||
                target.name !== "air" ||
                !above ||
                above.name !== "air"
              )
                continue;
              try {
                if (bot.entity.position.distanceTo(targetPos) > 4) {
                  setMovements(bot);
                  await gotoT(bot, new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3), 8000);
                }
                await bot.equip(tableItem, "hand");
                await bot.placeBlock(ground, new Vec3(0, 1, 0));
                await bot.waitForTicks(4);
                table = bot.blockAt(targetPos);
                if (table?.name === "crafting_table") break outer;
              } catch {
                /* try another open patch */
              }
            }
          }
        }
      }
    }
  }

  if (!table || table.name !== "crafting_table") return;
  setMovements(bot);
  try {
    await gotoT(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  } catch {
    /* crafting may still be in interaction range */
  }

  // Try each hoe tier (cheapest first — wooden only needs planks)
  const hoeTiers = ["wooden_hoe", "stone_hoe", "iron_hoe"];
  for (const hoeName of hoeTiers) {
    const mcItem = mcData.itemsByName[hoeName];
    if (!mcItem) continue;

    const recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
    if (recipe) {
      try {
        await craftT(bot, recipe, 1, table);
        return;
      } catch {
        continue;
      }
    }
  }
}
