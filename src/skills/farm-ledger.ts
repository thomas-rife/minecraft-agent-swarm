import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { FarmPlotRecord, FarmSiteRecord, Structure } from "../bot/memory.js";
import { getAllMemoryStores } from "../bot/memory-registry.js";

const FARM_STRUCTURE_MATCH_RADIUS = 4;
const FARM_SCAN_RADIUS = 11;

function positionKey(position: FarmPlotRecord): string {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
}

function sameFarm(a: FarmSiteRecord, b: FarmSiteRecord): boolean {
  return (
    Math.abs(a.water.x - b.water.x) <= 2 &&
    Math.abs(a.water.y - b.water.y) <= 2 &&
    Math.abs(a.water.z - b.water.z) <= 2
  );
}

/** Merge independently remembered copies of a farm without losing plot coordinates. */
export function mergeFarmSiteRecords(records: readonly FarmSiteRecord[]): FarmSiteRecord[] {
  const ranked = { planted: 4, reachable: 3, discovered: 2, blocked: 1 } as const;
  const merged: FarmSiteRecord[] = [];
  for (const record of records) {
    let destination = merged.find((candidate) => sameFarm(candidate, record));
    if (!destination) {
      destination = {
        ...record,
        water: { ...record.water },
        approach: { ...record.approach },
        plots: [],
      };
      merged.push(destination);
    }

    const recordRank = ranked[record.status];
    const destinationRank = ranked[destination.status];
    if (
      recordRank > destinationRank ||
      (recordRank === destinationRank && record.updatedAt > destination.updatedAt)
    ) {
      destination.status = record.status;
      destination.approach = { ...record.approach };
      destination.updatedAt = record.updatedAt;
      destination.failures = record.failures;
      destination.lastFailure = record.lastFailure;
    }

    const plots = new Map((destination.plots ?? []).map((plot) => [positionKey(plot), plot]));
    for (const plot of record.plots ?? []) {
      const rounded: FarmPlotRecord = {
        x: Math.round(plot.x),
        y: Math.round(plot.y),
        z: Math.round(plot.z),
      };
      const key = positionKey(rounded);
      const previous = plots.get(key);
      plots.set(key, {
        ...rounded,
        invalidChecks: Math.max(previous?.invalidChecks ?? 0, plot.invalidChecks ?? 0) || undefined,
      });
    }
    destination.plots = [...plots.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    if (destination.plots.length > 0) destination.status = "planted";
  }
  return merged;
}

export function getTeamFarmSites(): FarmSiteRecord[] {
  return mergeFarmSiteRecords(getAllMemoryStores().flatMap((store) => [...store.getFarmSites()]));
}

function nearFarmStructure(site: FarmSiteRecord, structures: readonly Structure[]): boolean {
  return structures.some(
    (structure) =>
      structure.type === "farm" &&
      !(structure.notes ?? "").toLowerCase().includes("partial") &&
      Math.abs(structure.x - site.water.x) <= FARM_STRUCTURE_MATCH_RADIUS &&
      Math.abs(structure.y - site.water.y) <= FARM_STRUCTURE_MATCH_RADIUS &&
      Math.abs(structure.z - site.water.z) <= FARM_STRUCTURE_MATCH_RADIUS,
  );
}

/** Farms with durable evidence that construction actually reached planting. */
export function getTeamEstablishedFarmSites(): FarmSiteRecord[] {
  const stores = getAllMemoryStores();
  const structures = stores.flatMap((store) => [...store.getStructures()]);
  const sites = mergeFarmSiteRecords(stores.flatMap((store) => [...store.getFarmSites()]));
  const established = sites.filter(
    (site) => site.status === "planted" || (site.plots?.length ?? 0) > 0 || nearFarmStructure(site, structures),
  );

  // Compatibility for old memories that recorded only a farm structure.
  for (const structure of structures.filter(
    (entry) => entry.type === "farm" && !(entry.notes ?? "").toLowerCase().includes("partial"),
  )) {
    if (
      established.some(
        (site) =>
          Math.abs(site.water.x - structure.x) <= FARM_STRUCTURE_MATCH_RADIUS &&
          Math.abs(site.water.z - structure.z) <= FARM_STRUCTURE_MATCH_RADIUS,
      )
    ) {
      continue;
    }
    established.push({
      water: { x: structure.x, y: structure.y, z: structure.z },
      approach: { x: structure.x + 2, y: structure.y + 1, z: structure.z },
      status: "planted",
      failures: 0,
      discoveredAt: structure.builtAt,
      updatedAt: structure.builtAt,
      plots: [],
    });
  }
  return established;
}

/** Discover legacy farm plots after navigating close enough for their chunks to be loaded. */
export function scanFarmPlots(bot: Bot, site: FarmSiteRecord): FarmPlotRecord[] {
  const plots = new Map<string, FarmPlotRecord>();
  const add = (position: Vec3) => {
    if (
      Math.abs(position.x - site.water.x) > FARM_SCAN_RADIUS ||
      Math.abs(position.z - site.water.z) > FARM_SCAN_RADIUS ||
      Math.abs(position.y - site.water.y) > 4
    ) {
      return;
    }
    const plot = { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) };
    plots.set(positionKey(plot), plot);
  };

  for (const position of bot.findBlocks({
    matching: (block) => block.name === "farmland",
    maxDistance: 18,
    count: 256,
  })) {
    add(position);
  }
  for (const position of bot.findBlocks({
    matching: (block) => block.name === "wheat",
    maxDistance: 18,
    count: 256,
  })) {
    add(position.offset(0, -1, 0));
  }
  return [...plots.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

export interface FarmLedgerInspection {
  totalPlots: number;
  loadedPlots: number;
  growingPlots: number;
  maturePlots: number;
  repairPlots: number;
  unknownPlots: number;
}

export function wheatIsMature(block: any): boolean {
  if (!block || block.name !== "wheat") return false;
  try {
    const age = Number(block.getProperties?.().age);
    return Number.isFinite(age) ? age >= 7 : Number(block.metadata) >= 7;
  } catch {
    return Number(block.metadata) >= 7;
  }
}

/** Inspect exact known plots, never unrelated wheat in another nearby farm. */
export function inspectFarmLedger(bot: Bot, sites: readonly FarmSiteRecord[]): FarmLedgerInspection {
  const uniquePlots = new Map<string, FarmPlotRecord>();
  for (const site of sites) {
    for (const plot of site.plots ?? []) uniquePlots.set(positionKey(plot), plot);
  }

  const result: FarmLedgerInspection = {
    totalPlots: uniquePlots.size,
    loadedPlots: 0,
    growingPlots: 0,
    maturePlots: 0,
    repairPlots: 0,
    unknownPlots: 0,
  };
  for (const plot of uniquePlots.values()) {
    const position = new Vec3(plot.x, plot.y, plot.z);
    const soil = bot.blockAt(position);
    const crop = bot.blockAt(position.offset(0, 1, 0));
    if (!soil || !crop) {
      result.unknownPlots++;
      continue;
    }
    result.loadedPlots++;
    if (soil.name === "farmland" && crop.name === "wheat") {
      result.growingPlots++;
      if (wheatIsMature(crop)) result.maturePlots++;
    } else {
      result.repairPlots++;
    }
  }
  return result;
}
