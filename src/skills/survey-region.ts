import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { explorerMoves, safeGoto } from "../bot/navigation.js";
import { getAllMemoryStores, getBotMemoryStore } from "../bot/memory-registry.js";
import type { Skill, SkillResult } from "./types.js";

const { goals } = pkg;

const SECTORS = [
  { id: "north", dx: 0, dz: -64 },
  { id: "north_east", dx: 48, dz: -48 },
  { id: "east", dx: 64, dz: 0 },
  { id: "south_east", dx: 48, dz: 48 },
  { id: "south", dx: 0, dz: 64 },
  { id: "south_west", dx: -48, dz: 48 },
  { id: "west", dx: -64, dz: 0 },
  { id: "north_west", dx: -48, dz: -48 },
] as const;

export const surveyRegionSkill: Skill = {
  name: "survey_region",
  description:
    "Survey exactly one bounded settlement sector, persist observed terrain/resources, then return to base. Eight fixed sectors prevent endless wandering.",
  params: {
    settlementAnchor: { type: "object", description: "Shared settlement anchor" },
  },

  estimateMaterials() {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const anchor = params.settlementAnchor as { x?: number; y?: number; z?: number } | undefined;
    if (![anchor?.x, anchor?.y, anchor?.z].every(Number.isFinite)) {
      return { success: false, message: "No valid settlement anchor configured for bounded scouting." };
    }

    const visited = new Set(
      getAllMemoryStores()
        .flatMap((store) => [...store.getScoutSectors()])
        .map((record) => record.id),
    );
    const sector = SECTORS.find((candidate) => !visited.has(candidate.id));
    if (!sector) {
      return { success: true, message: "Regional survey already complete: all 8 bounded sectors are recorded." };
    }

    const waypoint = {
      x: Math.round(Number(anchor!.x) + sector.dx),
      y: Math.round(Number(anchor!.y)),
      z: Math.round(Number(anchor!.z) + sector.dz),
    };
    onProgress({
      skillName: "survey_region",
      phase: "Surveying sector",
      progress: 0.1,
      message: `Traveling to ${sector.id} sector near (${waypoint.x}, ${waypoint.z})`,
      active: true,
    });

    bot.pathfinder.setMovements(explorerMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalNearXZ(waypoint.x, waypoint.z, 10), 55_000, 8_000);
      await bot.waitForChunksToLoad();
    } catch (error) {
      return {
        success: false,
        message: `Could not reach bounded ${sector.id} survey sector: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (signal.aborted) return { success: false, message: "Regional survey interrupted." };

    const observations = observeSector(bot);
    const reached = {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z),
    };
    getBotMemoryStore(bot)?.recordScoutSector(sector.id, waypoint, reached, observations);

    onProgress({
      skillName: "survey_region",
      phase: "Returning to settlement",
      progress: 0.75,
      message: `Recorded ${sector.id}: ${observations.join(", ") || "no notable resources"}`,
      active: true,
    });
    let returned = true;
    try {
      await safeGoto(
        bot,
        new goals.GoalNearXZ(Math.round(Number(anchor!.x)), Math.round(Number(anchor!.z)), 10),
        55_000,
        8_000,
      );
    } catch {
      returned = false;
    }

    return {
      success: true,
      message: `Surveyed and recorded ${sector.id} sector (${visited.size + 1}/8)${
        returned ? " and returned to base" : "; return route was blocked, but the survey evidence was saved"
      }. Observed: ${observations.join(", ") || "ordinary terrain"}.`,
      stats: { sectorsSurveyed: 1, observations: observations.length, returned: returned ? 1 : 0 },
    };
  },
};

function observeSector(bot: Bot): string[] {
  const observations: string[] = [];
  const blockGroups: Record<string, string[]> = {
    trees: ["oak_log", "birch_log", "spruce_log", "dark_oak_log", "acacia_log", "cherry_log"],
    water: ["water"],
    coal: ["coal_ore", "deepslate_coal_ore"],
    iron: ["iron_ore", "deepslate_iron_ore"],
    village: ["bell"],
  };
  for (const [label, names] of Object.entries(blockGroups)) {
    const wanted = new Set(names);
    try {
      if (bot.findBlock({ matching: (block) => wanted.has(block.name), maxDistance: 48 })) observations.push(label);
    } catch {
      // An unloaded edge is simply absent from this bounded observation.
    }
  }
  const animals = new Set<string>();
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || bot.entity.position.distanceTo(entity.position) > 48) continue;
    const name = String((entity as any).name ?? (entity as any).mobType ?? "").toLowerCase();
    if (["cow", "sheep", "pig", "chicken"].includes(name)) animals.add(name);
  }
  observations.push(...[...animals].map((name) => `${name}s`));
  return observations;
}
