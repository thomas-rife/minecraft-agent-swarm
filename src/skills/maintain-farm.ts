import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import { getAllMemoryStores, getBotMemoryStore } from "../bot/memory-registry.js";
import type { FarmPlotRecord, FarmSiteRecord } from "../bot/memory.js";
import type { Skill, SkillResult } from "./types.js";
import {
  getTeamEstablishedFarmSites,
  inspectFarmLedger,
  scanFarmPlots,
  wheatIsMature,
} from "./farm-ledger.js";

const { goals } = pkg;
const MAX_PLOTS_PER_PASS = 16;

export const maintainFarmSkill: Skill = {
  name: "maintain_farm",
  description:
    "Reconcile every established farm against its persistent plot ledger, then harvest, repair trampled soil, and replant exact plots.",
  params: {
    farmLocation: { type: "object", description: "Legacy fallback farm location" },
    stashPos: { type: "object", description: "Optional shared seed storage" },
  },

  estimateMaterials() {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    let sites = getTeamEstablishedFarmSites();
    if (sites.length === 0) {
      const fallback = legacyFarmSite(params.farmLocation ?? params);
      if (fallback) sites = [fallback];
    }
    if (sites.length === 0) {
      return { success: false, message: "Farm maintenance requires a remembered established farm." };
    }

    const store = getBotMemoryStore(bot);
    let visitedSites = 0;
    let bootstrappedPlots = 0;
    let harvested = 0;
    let retiled = 0;
    let planted = 0;
    let unreachable = 0;
    let blocked = 0;
    let retiredPlots = 0;
    const failures: string[] = [];
    const processed = new Set<string>();
    const markInvalidPlot = (site: FarmSiteRecord, plot: FarmPlotRecord): boolean => {
      const invalidChecks = store?.recordFarmPlotInvalid(site.water, plot) ?? 0;
      if (invalidChecks < 3) return false;
      for (const memory of getAllMemoryStores()) memory.removeFarmPlot(site.water, plot);
      retiredPlots++;
      return true;
    };

    // Prefer the closest site, but reconcile every established farm instead of
    // letting mature crops from one farm repeatedly trigger work at another.
    sites = [...sites].sort(
      (a, b) =>
        bot.entity.position.distanceTo(new Vec3(a.approach.x, a.approach.y, a.approach.z)) -
        bot.entity.position.distanceTo(new Vec3(b.approach.x, b.approach.y, b.approach.z)),
    );

    for (let siteIndex = 0; siteIndex < sites.length && processed.size < MAX_PLOTS_PER_PASS; siteIndex++) {
      if (signal.aborted) break;
      const site = sites[siteIndex]!;
      onProgress({
        skillName: "maintain_farm",
        phase: "Reconciling farm ledger",
        progress: Math.min(0.2, siteIndex / Math.max(1, sites.length) / 5),
        message: `Checking established farm ${siteIndex + 1}/${sites.length} at ${site.water.x}, ${site.water.z}`,
        active: true,
      });

      try {
        await safeGoto(
          bot,
          new goals.GoalNear(site.approach.x, site.approach.y, site.approach.z, 2),
          25_000,
          5_000,
        );
      } catch (error) {
        unreachable++;
        failures.push(`farm ${site.water.x},${site.water.z}: ${errorMessage(error)}`);
        continue;
      }
      if (signal.aborted) break;
      visitedSites++;
      await bot.waitForChunksToLoad().catch(() => {});

      let plots = [...(site.plots ?? [])];
      if (plots.length === 0) {
        plots = scanFarmPlots(bot, site);
        if (plots.length === 0) {
          failures.push(`farm ${site.water.x},${site.water.z}: no farmland plots were visible`);
          continue;
        }
        bootstrappedPlots += plots.length;
      }

      // Give this bot a durable copy of team knowledge. recordFarmPlots merges,
      // so discovering a legacy farm can never erase coordinates learned by a
      // teammate or by a newer construction pass.
      store?.rememberFarmSite(site.water, site.approach);
      store?.recordFarmPlots(site.water, plots);

      const mature: FarmPlotRecord[] = [];
      const repair: FarmPlotRecord[] = [];
      for (const plot of plots) {
        const key = plotKey(plot);
        if (processed.has(key) || processed.size >= MAX_PLOTS_PER_PASS) continue;
        const soil = bot.blockAt(new Vec3(plot.x, plot.y, plot.z));
        const crop = bot.blockAt(new Vec3(plot.x, plot.y + 1, plot.z));
        if (!soil || !crop) continue;
        if (soil.name === "farmland" && crop.name === "wheat") {
          for (const memory of getAllMemoryStores()) memory.clearFarmPlotInvalid(site.water, plot);
          if (wheatIsMature(crop)) {
            mature.push(plot);
            processed.add(key);
          }
        } else {
          repair.push(plot);
          processed.add(key);
        }
      }

      for (const plot of mature) {
        if (signal.aborted) break;
        const cropPos = new Vec3(plot.x, plot.y + 1, plot.z);
        const crop = bot.blockAt(cropPos);
        if (!crop || !wheatIsMature(crop)) continue;
        try {
          await approachPlot(bot, plot);
          await boundedDig(bot, crop, 10_000);
          harvested++;
        } catch (error) {
          unreachable++;
          failures.push(`crop ${plot.x},${plot.y},${plot.z}: ${errorMessage(error)}`);
        }
        onProgress({
          skillName: "maintain_farm",
          phase: "Harvesting",
          progress: 0.2 + processed.size / MAX_PLOTS_PER_PASS / 3,
          message: `${harvested} mature crops harvested from the farm ledger`,
          active: true,
        });
      }

      if (mature.length > 0) await collectNearbyDrops(bot, 14, 6_000).catch(() => {});

      const plotsToPlant = uniquePlots([...mature, ...repair]);
      if (plotsToPlant.length > 0 && countItem(bot, "wheat_seeds") === 0) {
        await withdrawSeeds(bot, params.stashPos).catch(() => {});
      }

      for (const plot of plotsToPlant) {
        if (signal.aborted) break;
        try {
          await approachPlot(bot, plot);
          const repaired = await preparePlot(bot, plot);
          if (repaired === "retiled") retiled++;
          if (repaired !== "ready" && repaired !== "retiled") {
            if (repaired === "invalid_soil") {
              if (markInvalidPlot(site, plot)) continue;
            }
            blocked++;
            failures.push(`plot ${plot.x},${plot.y},${plot.z}: ${repaired.replaceAll("_", " ")}`);
            continue;
          }

          const cropPos = new Vec3(plot.x, plot.y + 1, plot.z);
          if (bot.blockAt(cropPos)?.name === "wheat") {
            for (const memory of getAllMemoryStores()) memory.clearFarmPlotInvalid(site.water, plot);
            continue;
          }
          const seed = bot.inventory.items().find((item) => item.name === "wheat_seeds");
          const farmland = bot.blockAt(new Vec3(plot.x, plot.y, plot.z));
          const above = bot.blockAt(cropPos);
          if (!seed || !farmland || farmland.name !== "farmland" || !above || above.name !== "air") {
            if (seed && markInvalidPlot(site, plot)) continue;
            blocked++;
            failures.push(
              `plot ${plot.x},${plot.y},${plot.z}: ${
                !seed
                  ? "no wheat seeds available"
                  : `expected empty farmland, found ${farmland?.name ?? "unloaded"}/${above?.name ?? "unloaded"}`
              }`,
            );
            continue;
          }
          await bot.equip(seed, "hand");
          await bot.placeBlock(farmland, new Vec3(0, 1, 0));
          await bot.waitForTicks(2);
          if (bot.blockAt(cropPos)?.name === "wheat") {
            planted++;
            for (const memory of getAllMemoryStores()) memory.clearFarmPlotInvalid(site.water, plot);
          }
          else {
            if (markInvalidPlot(site, plot)) continue;
            blocked++;
            failures.push(`plot ${plot.x},${plot.y},${plot.z}: seed placement was not verified`);
          }
        } catch (error) {
          unreachable++;
          failures.push(`plot ${plot.x},${plot.y},${plot.z}: ${errorMessage(error)}`);
        }
        onProgress({
          skillName: "maintain_farm",
          phase: "Repairing and replanting",
          progress: 0.55 + processed.size / MAX_PLOTS_PER_PASS * 0.4,
          message: `${planted} plots replanted; ${retiled} trampled plots restored`,
          active: true,
        });
      }
    }

    if (signal.aborted) return { success: false, message: "Farm maintenance interrupted." };
    const refreshedSites = getTeamEstablishedFarmSites();
    const inspection = inspectFarmLedger(bot, refreshedSites);
    const progress = harvested + retiled + planted + bootstrappedPlots + retiredPlots;
    const stats = {
      visitedSites,
      bootstrappedPlots,
      harvested,
      retiled,
      planted,
      retiredPlots,
      blocked,
      unreachable,
      ledgerPlots: inspection.totalPlots,
    };

    if (visitedSites === 0) {
      return {
        success: false,
        message: `Could not reach any established farm.${failures[0] ? ` ${failures[0]}` : ""}`,
        stats,
      };
    }
    if (progress === 0 && (blocked > 0 || failures.length > 0)) {
      return {
        success: false,
        message: `Farm ledger found work but could not complete it: blocked=${blocked}, unreachable=${unreachable}.${failures[0] ? ` ${failures[0]}` : ""}`,
        stats,
      };
    }
    if (progress === 0) {
      return {
        success: true,
        message: `Farm ledger verified: ${inspection.growingPlots}/${inspection.totalPlots} known plots are planted; none need work now.`,
        stats,
      };
    }
    return {
      success: true,
      message: `Farm maintenance progressed: learned ${bootstrappedPlots} legacy plots, harvested ${harvested}, restored ${retiled}, planted ${planted}, and retired ${retiredPlots} invalid ledger plots.`,
      stats,
    };
  },
};

function legacyFarmSite(raw: any): FarmSiteRecord | null {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const now = new Date().toISOString();
  return {
    water: { x: Math.round(x), y: Math.round(y), z: Math.round(z) },
    approach: { x: Math.round(x) + 2, y: Math.round(y) + 1, z: Math.round(z) },
    status: "planted",
    failures: 0,
    discoveredAt: now,
    updatedAt: now,
    plots: [],
  };
}

function plotKey(plot: FarmPlotRecord): string {
  return `${plot.x},${plot.y},${plot.z}`;
}

function uniquePlots(plots: readonly FarmPlotRecord[]): FarmPlotRecord[] {
  return [...new Map(plots.map((plot) => [plotKey(plot), plot])).values()];
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

async function withdrawSeeds(bot: Bot, rawStash: any): Promise<void> {
  const x = Number(rawStash?.x);
  const y = Number(rawStash?.y);
  const z = Number(rawStash?.z);
  if (![x, y, z].every(Number.isFinite)) return;
  const { withdrawStash } = await import("./stash.js");
  await withdrawStash(bot, { x, y, z }, "wheat_seeds", MAX_PLOTS_PER_PASS);
}

async function approachPlot(bot: Bot, plot: FarmPlotRecord): Promise<void> {
  await safeGoto(bot, new goals.GoalNear(plot.x, plot.y + 1, plot.z, 2), 12_000, 3_000);
}

type PlotPreparation = "ready" | "retiled" | "unloaded" | "obstructed" | "invalid_soil" | "no_hoe" | "till_failed";

async function preparePlot(bot: Bot, plot: FarmPlotRecord): Promise<PlotPreparation> {
  const soilPos = new Vec3(plot.x, plot.y, plot.z);
  const cropPos = soilPos.offset(0, 1, 0);
  let soil = bot.blockAt(soilPos);
  let crop = bot.blockAt(cropPos);
  if (!soil || !crop) return "unloaded";
  if (soil.name === "farmland" && crop.name === "wheat") return "ready";

  if (crop.name === "short_grass" || crop.name === "tall_grass" || crop.name === "snow") {
    await boundedDig(bot, crop, 8_000);
    crop = bot.blockAt(cropPos);
  }
  if (!crop || crop.name !== "air") return "obstructed";
  if (soil.name === "farmland") return "ready";
  if (soil.name !== "dirt" && soil.name !== "grass_block") return "invalid_soil";

  const hoe = bot.inventory.items().find((item) => item.name.endsWith("_hoe"));
  if (!hoe) return "no_hoe";
  await bot.equip(hoe, "hand");
  await bot.lookAt(soilPos.offset(0.5, 0.5, 0.5));
  await bot.activateBlock(soil, new Vec3(0, 1, 0));
  await bot.waitForTicks(4);
  soil = bot.blockAt(soilPos);
  return soil?.name === "farmland" ? "retiled" : "till_failed";
}

async function boundedDig(bot: Bot, block: any, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bot.dig(block),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          try {
            bot.stopDigging();
          } catch {
            // Not currently digging.
          }
          reject(new Error("dig timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
