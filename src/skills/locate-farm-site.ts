import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { explorerMoves, safeGoto } from "../bot/navigation.js";
import { getBotMemoryStore } from "../bot/memory-registry.js";
import type { Skill, SkillResult } from "./types.js";
import { inspectFarmSite, surveyFarmSites, type FarmSiteCandidate } from "./farm-site.js";

const { goals } = pkg;

type Point = { x: number; y?: number; z: number };

/**
 * Deterministically survey a few settlement sectors and persist one reachable
 * exposed-water shore. The LLM chooses the sub-objective; Mineflayer performs
 * the search and records exact coordinates for build_farm.
 */
export const locateFarmSiteSkill: Skill = {
  name: "locate_farm_site",
  description:
    "Survey bounded settlement sectors for exposed surface water with a reachable dry shore, then remember the exact farm coordinates.",
  params: {},

  estimateMaterials() {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    const anchor = (params?.settlementAnchor as Point | undefined) ?? bot.entity.position;
    const waypoints = searchWaypoints(anchor, bot.entity.position);
    let sectorsVisited = 0;
    let lastFailure = "";

    for (const waypoint of waypoints) {
      if (signal.aborted) {
        return { success: false, message: "Farm-site survey was aborted before finding a usable shore." };
      }

      const horizontal = Math.hypot(
        bot.entity.position.x - waypoint.x,
        bot.entity.position.z - waypoint.z,
      );
      if (horizontal > 18) {
        onProgress({
          skillName: "locate_farm_site",
          phase: "Surveying settlement",
          progress: Math.min(0.85, sectorsVisited / waypoints.length),
          message: `Checking the sector near (${Math.round(waypoint.x)}, ${Math.round(waypoint.z)})...`,
          active: true,
        });
        bot.pathfinder.setMovements(explorerMoves(bot));
        try {
          await safeGoto(bot, new goals.GoalNearXZ(waypoint.x, waypoint.z, 10), 25_000);
        } catch (err) {
          lastFailure = errorMessage(err);
          continue;
        }
      }

      sectorsVisited++;
      await bot.waitForChunksToLoad().catch(() => {});
      const survey = surveyFarmSites(bot, 64, 2);
      for (const candidate of survey.candidates.slice(0, 8)) {
        const reached = await reachCandidate(bot, candidate, signal);
        if (!reached) continue;
        const confirmed = inspectFarmSite(bot, candidate.water, 2);
        if (!confirmed?.approaches[0]) continue;

        const store = getBotMemoryStore(bot);
        store?.rememberFarmSite(confirmed.water, confirmed.approaches[0]);
        store?.updateFarmSite(confirmed.water, "reachable");
        return {
          success: true,
          message: `Usable farm shore confirmed at (${confirmed.water.x}, ${confirmed.water.y}, ${confirmed.water.z}) with ${confirmed.tillable.length} hydrated plots and a reachable dry approach. The coordinates are remembered for build_farm.`,
          stats: { sectorsVisited, tillablePlots: confirmed.tillable.length },
        };
      }
    }

    return {
      success: false,
      message: `No usable surface water after surveying ${sectorsVisited} reachable settlement sectors.${
        lastFailure ? ` Last navigation problem: ${lastFailure}` : ""
      }`,
      stats: { sectorsVisited },
    };
  },
};

function searchWaypoints(anchor: Point, current: Point): Point[] {
  const offsets = [
    [0, 0],
    [48, 0],
    [-48, 0],
    [0, 48],
    [0, -48],
    [48, 48],
    [-48, 48],
    [48, -48],
    [-48, -48],
  ] as const;
  return offsets
    .map(([dx, dz]) => ({ x: Math.round(anchor.x + dx), z: Math.round(anchor.z + dz) }))
    .sort(
      (a, b) =>
        Math.hypot(a.x - current.x, a.z - current.z) -
        Math.hypot(b.x - current.x, b.z - current.z),
    )
    .slice(0, 5);
}

async function reachCandidate(bot: Bot, candidate: FarmSiteCandidate, signal: AbortSignal): Promise<boolean> {
  const approaches = [...candidate.approaches]
    .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
    .slice(0, 4);
  for (const approach of approaches) {
    if (signal.aborted) return false;
    bot.pathfinder.setMovements(explorerMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalNear(approach.x, approach.y, approach.z, 2), 25_000);
      if (bot.entity.position.distanceTo(new Vec3(approach.x, approach.y, approach.z)) <= 4) return true;
    } catch {
      // Try another dry work position around the same water source.
    }
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
