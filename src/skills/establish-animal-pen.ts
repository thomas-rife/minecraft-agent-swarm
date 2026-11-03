import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { getAllMemoryStores, getBotMemoryStore } from "../bot/memory-registry.js";
import { safeGoto } from "../bot/navigation.js";
import { craftAllLogsToPlanks, findPlacementRef, groundLevel, setMovements } from "./build-house.js";
import { countAllLogs, countAllPlanks, PLANK_TYPES } from "./materials.js";
import type { Skill, SkillResult } from "./types.js";

const { goals } = pkg;
const PEN_SIZE = 7;
const MAX_PEN_BLOCKS_PER_PASS = 32;
const FEED: Record<string, string[]> = {
  cow: ["wheat"],
  sheep: ["wheat"],
  chicken: ["wheat_seeds"],
  pig: ["carrot", "potato", "beetroot"],
};

export const establishAnimalPenSkill: Skill = {
  name: "establish_animal_pen",
  description:
    "Build one deterministic 7x7 animal pen near the farm, lure two selected animals inside, feed them, and persist verified husbandry evidence.",
  params: {
    species: { type: "string", description: "cow, sheep, chicken, or pig" },
    farmLocation: { type: "object", description: "Established farm location" },
    stashPos: { type: "object", description: "Shared stash position" },
  },

  estimateMaterials() {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const species = String(params.species ?? "").toLowerCase();
    if (!FEED[species]) return { success: false, message: `Unsupported husbandry species: ${species}.` };
    const farm = params.farmLocation as { x?: number; y?: number; z?: number } | undefined;
    if (![farm?.x, farm?.y, farm?.z].every(Number.isFinite)) {
      return { success: false, message: "Animal husbandry requires an established farm location." };
    }
    if (!FEED[species].some((name) => itemCount(bot, name) >= 2) && params.stashPos) {
      const { withdrawStash } = await import("./stash.js");
      for (const candidate of FEED[species]) {
        try {
          await withdrawStash(bot, params.stashPos, candidate, 4);
        } catch {
          // Try the next valid feed.
        }
        if (itemCount(bot, candidate) >= 2) break;
      }
    }
    const selectedFeed = FEED[species].find((name) => itemCount(bot, name) >= 2);
    if (!selectedFeed) {
      return {
        success: false,
        message: `Need 2 ${FEED[species].join(" or ")} to establish a ${species} pen.`,
      };
    }

    const rememberedPartial = getAllMemoryStores()
      .flatMap((store) => [...store.getStructures()])
      .find(
        (structure) =>
          structure.type === "animal_pen" &&
          new RegExp(`species=${species}\\b`, "i").test(structure.notes ?? "") &&
          /status=partial/i.test(structure.notes ?? "") &&
          Math.hypot(structure.x - Number(farm!.x), structure.z - Number(farm!.z)) <= 32,
      );
    const site = rememberedPartial
      ? new Vec3(rememberedPartial.x, rememberedPartial.y, rememberedPartial.z)
      : findPenSite(bot, {
          x: Math.round(Number(farm!.x)) + speciesOffset(species).x,
          y: Math.round(Number(farm!.y)),
          z: Math.round(Number(farm!.z)) + speciesOffset(species).z,
        });
    if (!site) return { success: false, message: "No flat 7x7 pen site found within 12 blocks of the farm." };
    getBotMemoryStore(bot)?.addStructure(
      "animal_pen",
      site.x,
      site.y,
      site.z,
      `Animal Pen; species=${species}; status=partial`,
    );

    const gateX = site.x + Math.floor(PEN_SIZE / 2);
    const gateZ = site.z + PEN_SIZE - 1;
    const wallTargets: Vec3[] = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < PEN_SIZE; x++) {
        for (let z = 0; z < PEN_SIZE; z++) {
          if (x !== 0 && x !== PEN_SIZE - 1 && z !== 0 && z !== PEN_SIZE - 1) continue;
          if (site.x + x === gateX && site.z + z === gateZ) continue;
          wallTargets.push(new Vec3(site.x + x, site.y + y, site.z + z));
        }
      }
    }
    const requiredPlanks =
      wallTargets.filter((target) => {
        const block = bot.blockAt(target);
        return !block || !(PLANK_TYPES as readonly string[]).includes(block.name);
      }).length + 2;

    if (params.stashPos && countAllPlanks(bot) + countAllLogs(bot) * 4 < requiredPlanks) {
      const { withdrawStash } = await import("./stash.js");
      for (const name of ["oak_planks", "spruce_planks", "birch_planks", "oak_log", "spruce_log", "birch_log"]) {
        try {
          await withdrawStash(bot, params.stashPos, name, 64);
        } catch {
          // Continue through compatible woods.
        }
        if (countAllPlanks(bot) + countAllLogs(bot) * 4 >= requiredPlanks) break;
      }
    }
    if (countAllPlanks(bot) < requiredPlanks && countAllLogs(bot) > 0) {
      await craftAllLogsToPlanks(bot, signal);
    }
    if (countAllPlanks(bot) < requiredPlanks) {
      return {
        success: false,
        message: `Need ${requiredPlanks} planks to finish the reusable 7x7 ${species} pen; have ${countAllPlanks(bot)}.`,
      };
    }

    let placed = 0;
    // Upper wall blocks sometimes have no placement reference until their
    // neighboring lower blocks exist. Retry the remaining targets after each
    // pass instead of abandoning an otherwise complete pen two blocks short.
    for (let pass = 0; pass < 3; pass++) {
      let progressThisPass = 0;
      for (const target of wallTargets) {
        if (placed >= MAX_PEN_BLOCKS_PER_PASS) break;
        if (signal.aborted) return { success: false, message: "Animal pen construction interrupted." };
        const existing = bot.blockAt(target);
        if (existing && (PLANK_TYPES as readonly string[]).includes(existing.name)) continue;
        if (existing && !["air", "short_grass", "tall_grass", "snow"].includes(existing.name)) continue;
        if (await placePlank(bot, target)) {
          placed++;
          progressThisPass++;
        }
        if (placed > 0 && placed % 8 === 0) {
          onProgress({
            skillName: "establish_animal_pen",
            phase: "Building animal pen",
            progress: Math.min(0.55, placed / Math.max(1, wallTargets.length) / 2),
            message: `${placed} pen blocks placed`,
            active: true,
          });
        }
      }
      if (placed >= MAX_PEN_BLOCKS_PER_PASS) break;
      if (progressThisPass === 0) break;
    }
    const missingWallBlocks = wallTargets.filter((target) => {
      const block = bot.blockAt(target);
      return !block || !(PLANK_TYPES as readonly string[]).includes(block.name);
    }).length;
    if (missingWallBlocks > 0) {
      return {
        success: placed > 0,
        message:
          placed > 0
            ? `Animal pen shell progressed: placed ${placed} blocks; ${missingWallBlocks} wall blocks remain at the remembered site.`
            : `Animal pen remains partial: ${missingWallBlocks} wall blocks could not be verified. Resume the same pen site.`,
        stats: { blocksPlaced: placed, blocksRemaining: missingWallBlocks },
      };
    }

    const center = new Vec3(site.x + 3, site.y, site.z + 3);
    const animals = nearbySpecies(bot, species, center, 64).slice(0, 2);
    if (animals.length < 2) {
      return {
        success: false,
        message: `Pen shell is ready, but only ${animals.length}/2 nearby ${species}s were visible. Find a pair and resume.`,
        stats: { blocksPlaced: placed, animalsContained: animals.length },
      };
    }

    for (const animal of animals) {
      if (signal.aborted) break;
      const feedItem = bot.inventory.items().find((item) => item.name === selectedFeed);
      if (!feedItem) break;
      try {
        await bot.equip(feedItem, "hand");
        await safeGoto(bot, new goals.GoalFollow(animal, 2), 20_000, 5_000);
        await safeGoto(bot, new goals.GoalNear(center.x, center.y, center.z, 1), 25_000, 5_000);
        await bot.waitForTicks(30);
        const neutral = bot.inventory.items().find((item) => item.name !== selectedFeed);
        if (neutral) await bot.equip(neutral, "hand");
        await safeGoto(bot, new goals.GoalNear(gateX, site.y, gateZ + 2, 1), 12_000, 4_000).catch(() => {});
      } catch {
        // The count below is world evidence; failed luring cannot fake success.
      }
    }

    const inside = nearbySpecies(bot, species, center, 12).filter((entity) => insidePen(entity.position, site));
    if (inside.length < 2) {
      return {
        success: false,
        message: `Pen shell is ready, but only ${inside.length}/2 ${species}s are contained. Resume while a pair is nearby.`,
        stats: { blocksPlaced: placed, animalsContained: inside.length },
      };
    }

    const feedItem = bot.inventory.items().find((item) => item.name === selectedFeed);
    let fed = 0;
    if (feedItem) {
      await bot.equip(feedItem, "hand");
      for (const animal of inside.slice(0, 2)) {
        try {
          await safeGoto(bot, new goals.GoalFollow(animal, 2), 10_000, 3_000);
          await bot.activateEntity(animal);
          fed++;
        } catch {
          // Leave the entry open so a later pass can finish husbandry.
        }
      }
    }
    if (fed < 2) {
      return {
        success: false,
        message: `Pen and pair are ready, but only ${fed}/2 ${species}s accepted breeding feed. Resume the same pen.`,
        stats: { blocksPlaced: placed, animalsContained: inside.length, animalsFed: fed },
      };
    }

    const neutral = bot.inventory.items().find((item) => item.name !== selectedFeed);
    if (neutral) await bot.equip(neutral, "hand");
    await safeGoto(bot, new goals.GoalNear(gateX, site.y, gateZ + 2, 1), 12_000, 4_000).catch(() => {});
    const closure = [new Vec3(gateX, site.y, gateZ), new Vec3(gateX, site.y + 1, gateZ)];
    for (const target of closure) await placePlank(bot, target);
    if (
      closure.some((target) => {
        const block = bot.blockAt(target);
        return !block || !(PLANK_TYPES as readonly string[]).includes(block.name);
      })
    ) {
      return {
        success: false,
        message: "Animals were fed, but the pen entrance could not be closed and verified. Resume immediately.",
        stats: { animalsContained: inside.length, animalsFed: fed },
      };
    }

    getBotMemoryStore(bot)?.addStructure(
      "animal_pen",
      site.x,
      site.y,
      site.z,
      `Animal Pen; species=${species}; status=established; population=${inside.length}`,
    );
    return {
      success: true,
      message: `Established a verified ${species} pen near the farm with ${inside.length} animals contained and breeding feed supplied.`,
      stats: { blocksPlaced: placed, animalsContained: inside.length, animalsFed: fed },
    };
  },
};

function speciesOffset(species: string): { x: number; z: number } {
  if (species === "cow") return { x: 12, z: 0 };
  if (species === "sheep") return { x: -12, z: 0 };
  if (species === "chicken") return { x: 0, z: 12 };
  return { x: 0, z: -12 };
}

function findPenSite(bot: Bot, preferred: { x: number; y: number; z: number }): Vec3 | null {
  for (let radius = 0; radius <= 12; radius += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        if (radius && Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
        const x = preferred.x + dx - 3;
        const z = preferred.z + dz - 3;
        const heights: number[] = [];
        let valid = true;
        for (let px = 0; px < PEN_SIZE && valid; px++) {
          for (let pz = 0; pz < PEN_SIZE; pz++) {
            const ground = groundLevel(bot, x + px, z + pz);
            if (ground === null) {
              valid = false;
              break;
            }
            heights.push(ground);
          }
        }
        if (valid && heights.length && Math.max(...heights) === Math.min(...heights)) {
          return new Vec3(x, Math.max(...heights) + 1, z);
        }
      }
    }
  }
  return null;
}

async function placePlank(bot: Bot, target: Vec3): Promise<boolean> {
  const existing = bot.blockAt(target);
  if (existing && (PLANK_TYPES as readonly string[]).includes(existing.name)) return true;
  const item = bot.inventory.items().find((candidate) => (PLANK_TYPES as readonly string[]).includes(candidate.name));
  if (!item) return false;
  if (bot.entity.position.distanceTo(target) > 4.5) {
    setMovements(bot);
    await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), 10_000).catch(() => {});
  }
  const reference = findPlacementRef(bot, target);
  if (!reference) return false;
  try {
    await bot.equip(item, "hand");
    await bot.lookAt(target.offset(0.5, 0.5, 0.5));
    return await Promise.race([
      bot
        .placeBlock(reference.block, reference.face)
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
  } catch {
    return false;
  }
}

function itemCount(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
}

function nearbySpecies(bot: Bot, species: string, center: Vec3, radius: number): any[] {
  return Object.values(bot.entities)
    .filter((entity: any) => {
      const name = String(entity?.name ?? entity?.mobType ?? "").toLowerCase();
      return entity?.position && name === species && center.distanceTo(entity.position) <= radius;
    })
    .sort((a: any, b: any) => center.distanceTo(a.position) - center.distanceTo(b.position));
}

function insidePen(position: Vec3, origin: Vec3): boolean {
  return (
    position.x > origin.x &&
    position.x < origin.x + PEN_SIZE - 1 &&
    position.z > origin.z &&
    position.z < origin.z + PEN_SIZE - 1
  );
}
