import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { getSurfaceState } from "../bot/navigation.js";

export interface FarmSiteCandidate {
  water: Vec3;
  tillable: Vec3[];
  /** Dry feet positions from which the farm can be reached and worked. */
  approaches: Vec3[];
  seedSources: number;
  score: number;
}

export interface FarmSiteSurvey {
  candidate: FarmSiteCandidate | null;
  candidates: FarmSiteCandidate[];
  waterBlocks: number;
  exposedWaterBlocks: number;
  bestTillableCount: number;
}

const REPLACEABLE_ABOVE = new Set(["air", "short_grass", "tall_grass", "snow"]);
const SAFE_TO_CLEAR = new Set(["short_grass", "tall_grass", "snow", "dirt", "grass_block", "sand", "gravel", "clay"]);

export interface FarmShorePreparation {
  target: Vec3;
  kind: "clear_above" | "place_dirt";
  /** Block to clear before the target becomes usable/placeable. */
  clear?: Vec3;
}

/**
 * Find exposed water with hydrated, plantable dirt nearby.
 *
 * Water can hydrate farmland at its own Y or one block below it. The previous
 * search sampled only 40 water blocks and checked one Y level, which made a
 * stepped shore look exactly like "no water".
 */
export function surveyFarmSites(bot: Bot, maxDistance = 96, minimumTillable = 4): FarmSiteSurvey {
  // Search the bot's surface band first. A compact underground aquifer near
  // the base previously filled the old 256-result cap before the surface lake
  // was considered, even though every one of those cave blocks was rejected
  // by the direct-sky check below.
  const surfaceBandFloor = Math.floor(bot.entity.position.y) - 6;
  let waters = bot.findBlocks({
    matching: (b) => b.name === "water" && (!b.position || b.position.y >= surfaceBandFloor),
    maxDistance,
    count: 1024,
  });
  // If the bot itself is below ground or on a steep slope, retain a broader
  // fallback. The larger cap plus column de-duplication prevents one pool from
  // masking every other water source in the loaded area.
  if (waters.length === 0) {
    waters = bot.findBlocks({
      matching: (b) => b.name === "water",
      maxDistance,
      count: 2048,
    });
  }
  const uniqueWaterColumns = new Map<string, Vec3>();
  for (const position of waters) {
    const key = `${position.x},${position.z}`;
    const existing = uniqueWaterColumns.get(key);
    if (!existing || position.y > existing.y) uniqueWaterColumns.set(key, position);
  }
  waters = [...uniqueWaterColumns.values()];
  const seedPositions = bot.findBlocks({
    matching: (b) => b.name === "short_grass" || b.name === "tall_grass",
    maxDistance,
    count: 256,
  });

  let exposedWaterBlocks = 0;
  let bestTillableCount = 0;
  const candidates: FarmSiteCandidate[] = [];

  for (const waterPos of waters) {
    const aboveWater = bot.blockAt(waterPos.offset(0, 1, 0));
    if (!aboveWater || aboveWater.name === "water" || aboveWater.boundingBox === "block") continue;
    // One air block above water does not make it a surface pond. The base had
    // an underground pool at Y62 beneath bots standing at Y70; selecting it
    // produced a dry "approach" inside the cave with no safe route downward.
    const surface = getSurfaceState(bot, waterPos.offset(0, 1, 0));
    if (!surface.skyKnown || !surface.hasDirectSky) continue;
    exposedWaterBlocks++;

    const tillable = hydratedTillableBlocks(bot, waterPos);
    bestTillableCount = Math.max(bestTillableCount, tillable.length);
    if (tillable.length < minimumTillable) continue;
    const approaches = farmWorkPositions(bot, waterPos, tillable);
    if (approaches.length === 0) continue;

    const seedSources = seedPositions.filter(
      (p) => Math.hypot(p.x - waterPos.x, p.z - waterPos.z) <= 24 && Math.abs(p.y - waterPos.y) <= 5,
    ).length;
    const distance = bot.entity.position.distanceTo(waterPos);
    const score = tillable.length * 10 + Math.min(seedSources, 24) * 3 + approaches.length * 2 - distance * 0.1;
    candidates.push({ water: waterPos.clone(), tillable, approaches, seedSources, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  return {
    candidate: candidates[0] ?? null,
    candidates,
    waterBlocks: waters.length,
    exposedWaterBlocks,
    bestTillableCount,
  };
}

/**
 * Re-inspect one remembered water coordinate after its chunk is loaded.
 * This prevents a later global survey from silently switching to another lake.
 */
export function inspectFarmSite(bot: Bot, waterPos: Vec3, minimumTillable = 2): FarmSiteCandidate | null {
  const water = bot.blockAt(waterPos);
  const above = bot.blockAt(waterPos.offset(0, 1, 0));
  if (!water || water.name !== "water" || !above || above.name === "water" || above.boundingBox === "block") {
    return null;
  }
  const surface = getSurfaceState(bot, waterPos.offset(0, 1, 0));
  if (!surface.skyKnown || !surface.hasDirectSky) return null;
  const tillable = hydratedTillableBlocks(bot, waterPos);
  if (tillable.length < minimumTillable) return null;
  const approaches = farmWorkPositions(bot, waterPos, tillable);
  if (approaches.length === 0) return null;
  return {
    water: waterPos.clone(),
    tillable,
    approaches,
    seedSources: 0,
    score: tillable.length * 10 + approaches.length * 2,
  };
}

function isPassable(block: ReturnType<Bot["blockAt"]>): boolean {
  return !!block && (REPLACEABLE_ABOVE.has(block.name) || block.boundingBox === "empty");
}

/**
 * Find dry feet positions around a shore. A target is only useful if the bot
 * can stand somewhere other than on that target and reach its top face.
 */
export function farmWorkPositions(bot: Bot, waterPos: Vec3, tillable: readonly Vec3[]): Vec3[] {
  const positions = new Map<string, Vec3>();
  const anchors = tillable.length > 0 ? tillable : [waterPos];

  for (const target of anchors) {
    for (let radius = 1; radius <= 2; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (const floorDy of [-1, 0, 1]) {
            const floorPos = target.offset(dx, floorDy, dz);
            if (floorPos.equals(target)) continue;
            const floor = bot.blockAt(floorPos);
            const feetPos = floorPos.offset(0, 1, 0);
            const feet = bot.blockAt(feetPos);
            const head = bot.blockAt(feetPos.offset(0, 1, 0));
            if (
              !floor ||
              floor.boundingBox !== "block" ||
              floor.name === "water" ||
              floor.name === "lava" ||
              !isPassable(feet) ||
              !isPassable(head)
            ) {
              continue;
            }
            positions.set(feetPos.toString(), feetPos);
          }
        }
      }
    }
  }

  return [...positions.values()].sort((a, b) => {
    const aDistance = bot.entity.position.distanceTo(a);
    const bDistance = bot.entity.position.distanceTo(b);
    return aDistance - bDistance;
  });
}

/** Work positions close enough to till or plant one exact soil block. */
export function workPositionsForTarget(bot: Bot, target: Vec3): Vec3[] {
  return farmWorkPositions(bot, target, [target]).filter((position) => position.distanceTo(target) <= 3.5);
}

/**
 * Plan conservative terrain preparation around one exposed water source.
 *
 * Existing dirt with a simple obstruction above it can be cleared. Otherwise
 * an empty, supported cell at water level can receive dirt. We deliberately do
 * not excavate stone, fill the water source itself, or alter containers/builds.
 */
export function planFarmShorePreparation(bot: Bot, waterPos: Vec3, desiredTillable = 4): FarmShorePreparation[] {
  const existing = hydratedTillableBlocks(bot, waterPos);
  if (existing.length >= desiredTillable) return [];

  const occupied = new Set(existing.map((pos) => `${pos.x},${pos.y},${pos.z}`));
  const plans: FarmShorePreparation[] = [];
  const candidates: { distance: number; plan: FarmShorePreparation }[] = [];

  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx === 0 && dz === 0) continue;

      // First recover existing soil hidden beneath a simple bank obstruction.
      for (const dy of [0, -1]) {
        const target = waterPos.offset(dx, dy, dz);
        const key = `${target.x},${target.y},${target.z}`;
        if (occupied.has(key)) continue;
        const soil = bot.blockAt(target);
        const above = bot.blockAt(target.offset(0, 1, 0));
        const aboveKey = `${target.x},${target.y + 1},${target.z}`;
        if (
          soil &&
          (soil.name === "dirt" || soil.name === "grass_block") &&
          above &&
          above.boundingBox === "block" &&
          SAFE_TO_CLEAR.has(above.name) &&
          !occupied.has(aboveKey)
        ) {
          candidates.push({
            distance: Math.hypot(dx, dz) + Math.abs(dy) * 0.25,
            plan: { target: target.clone(), kind: "clear_above", clear: target.offset(0, 1, 0) },
          });
        }
      }

      // Create a raised shore cell at water level when solid support exists.
      const target = waterPos.offset(dx, 0, dz);
      const key = `${target.x},${target.y},${target.z}`;
      if (occupied.has(key)) continue;
      const cell = bot.blockAt(target);
      const above = bot.blockAt(target.offset(0, 1, 0));
      const support = bot.blockAt(target.offset(0, -1, 0));
      if (
        cell &&
        REPLACEABLE_ABOVE.has(cell.name) &&
        above &&
        REPLACEABLE_ABOVE.has(above.name) &&
        support &&
        support.boundingBox === "block" &&
        support.name !== "water" &&
        support.name !== "lava"
      ) {
        candidates.push({
          distance: Math.hypot(dx, dz) + 0.5,
          plan: {
            target: target.clone(),
            kind: "place_dirt",
            clear: cell.name === "air" ? undefined : target.clone(),
          },
        });
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance || (a.plan.kind === "clear_above" ? -1 : 1));
  for (const { plan } of candidates) {
    const key = `${plan.target.x},${plan.target.y},${plan.target.z}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    plans.push(plan);
    if (existing.length + plans.length >= desiredTillable) break;
  }

  return plans;
}

/** Return unique dirt/grass blocks that this water source can hydrate. */
export function hydratedTillableBlocks(bot: Bot, waterPos: Vec3): Vec3[] {
  const targets = new Map<string, Vec3>();

  for (const dy of [0, -1]) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const pos = waterPos.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (
          block &&
          (block.name === "dirt" || block.name === "grass_block") &&
          above &&
          REPLACEABLE_ABOVE.has(above.name)
        ) {
          targets.set(`${pos.x},${pos.y},${pos.z}`, pos.clone());
        }
      }
    }
  }

  return [...targets.values()].sort(
    (a, b) => Math.hypot(a.x - waterPos.x, a.z - waterPos.z) - Math.hypot(b.x - waterPos.x, b.z - waterPos.z),
  );
}

export function describeFarmSurveyFailure(survey: FarmSiteSurvey): string {
  if (survey.waterBlocks === 0) {
    return "No water blocks are loaded within 96 blocks. Move toward a river or pond, then retry build_farm.";
  }
  if (survey.exposedWaterBlocks === 0) {
    return `No usable surface water: found ${survey.waterBlocks} water blocks, but none are exposed. Explore for a river or pond.`;
  }
  return `No usable farm shore: found surface water, but its best shore has only ${survey.bestTillableCount}/4 hydrated dirt blocks even after preparation. Explore another shore.`;
}
