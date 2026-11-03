import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ObjectiveCommitment, ObjectiveId } from "./objective-tree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Structure {
  type: "house" | "farm" | "warehouse" | "workshop" | "bridge" | "mine" | "furnace" | "animal_pen" | "other";
  x: number;
  y: number;
  z: number;
  builtAt: string;
  notes?: string;
}

export interface ScoutSectorRecord {
  id: string;
  waypoint: { x: number; y: number; z: number };
  reached: { x: number; y: number; z: number };
  observations: string[];
  visitedAt: string;
}

export interface SafetyZoneRecord {
  zone: string;
  center: { x: number; y: number; z: number };
  torchesPlaced: number;
  securedAt: string;
}

export interface FarmSiteRecord {
  water: { x: number; y: number; z: number };
  /** A dry feet position from which the shore can be worked. */
  approach: { x: number; y: number; z: number };
  status: "discovered" | "reachable" | "blocked" | "planted";
  failures: number;
  discoveredAt: string;
  updatedAt: string;
  lastFailure?: string;
  /** Exact soil-block coordinates belonging to this farm. */
  plots?: FarmPlotRecord[];
}

export interface FarmPlotRecord {
  x: number;
  y: number;
  z: number;
  /** Consecutive confirmations that this coordinate is no longer tillable soil. */
  invalidChecks?: number;
}

export interface Death {
  location: string;
  x: number;
  y: number;
  z: number;
  cause: string;
  timestamp: string;
}

export interface OreDiscovery {
  type: string;
  x: number;
  y: number;
  z: number;
  timestamp: string;
}

export interface SkillAttempt {
  skill: string;
  success: boolean;
  durationSeconds: number;
  notes: string;
  timestamp: string;
}

export interface BotMemory {
  structures: Structure[];
  /** Promising farm shores are remembered before the first crop is planted. */
  farmSites?: FarmSiteRecord[];
  /** Bounded settlement sectors visited by the scout objective. */
  scoutSectors?: ScoutSectorRecord[];
  /** Independently verified lighting zones around the active settlement. */
  safetyZones?: SafetyZoneRecord[];
  deaths: Death[];
  oreDiscoveries: OreDiscovery[];
  skillHistory: SkillAttempt[];
  lessons: string[];
  lastUpdated: string;
  /** Persistent set of skills confirmed broken (5+ failures with 0% success rate). Never cleared by rolling window. */
  brokenSkillNames: string[];
  seasonGoal?: string;
  /** Persistent hierarchical project selected by the LLM. */
  objectiveCommitment?: ObjectiveCommitment;
  progressionObjectives?: string[];
  progressionStorage?: { deposited: boolean; retrieved: boolean };
}

/**
 * Return a genuinely new memory graph for every bot.
 *
 * A shallow spread of one object containing arrays made every newly-created
 * store share structures, farm sites, and skill history until it loaded a
 * file. That made one bot's result appear in all memory files.
 */
function createDefaultMemory(): BotMemory {
  return {
    structures: [],
    farmSites: [],
    scoutSectors: [],
    safetyZones: [],
    deaths: [],
    oreDiscoveries: [],
    skillHistory: [],
    lessons: [],
    lastUpdated: new Date().toISOString(),
    brokenSkillNames: [],
    seasonGoal: undefined,
    objectiveCommitment: undefined,
  };
}

function normalizeMemory(value: Partial<BotMemory> | null | undefined): BotMemory {
  const fresh = createDefaultMemory();
  return {
    ...fresh,
    ...value,
    structures: Array.isArray(value?.structures) ? [...value.structures] : fresh.structures,
    farmSites: Array.isArray(value?.farmSites)
      ? value.farmSites.map((site) => ({
          ...site,
          water: { ...site.water },
          approach: { ...site.approach },
          plots: Array.isArray(site.plots) ? site.plots.map((plot) => ({ ...plot })) : [],
        }))
      : fresh.farmSites,
    scoutSectors: Array.isArray(value?.scoutSectors) ? [...value.scoutSectors] : fresh.scoutSectors,
    safetyZones: Array.isArray(value?.safetyZones) ? [...value.safetyZones] : fresh.safetyZones,
    deaths: Array.isArray(value?.deaths) ? [...value.deaths] : fresh.deaths,
    oreDiscoveries: Array.isArray(value?.oreDiscoveries) ? [...value.oreDiscoveries] : fresh.oreDiscoveries,
    skillHistory: Array.isArray(value?.skillHistory) ? [...value.skillHistory] : fresh.skillHistory,
    lessons: Array.isArray(value?.lessons) ? [...value.lessons] : fresh.lessons,
    brokenSkillNames: Array.isArray(value?.brokenSkillNames) ? [...value.brokenSkillNames] : fresh.brokenSkillNames,
    progressionObjectives: Array.isArray(value?.progressionObjectives)
      ? value.progressionObjectives.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export const PRECONDITION_KEYWORDS = [
  "No trees found",
  "need wood",
  "Need a pickaxe",
  "No torches",
  "Couldn't plant",
  "aborted",
  "No crafting_table",
  "No furnace",
  "Need more",
  "not enough",
  "missing materials",
  // build_farm environment failures (not skill bugs — just wrong location)
  "No water found",
  "No usable surface water",
  "No usable farm shore",
  "No tillable dirt",
  "No seeds from grass",
  "Can't craft a hoe",
  "No reachable farm shore",
  "Farm shore",
  "remembered farm shore",
  "chunk may not be loaded",
  "no farmland plots were visible",
  "no hoe",
  "no wheat seeds available",
  "Could not reach any established farm",
  // voyager mineBlock / exploreUntil: resource not nearby (precondition, not bug)
  "Cannot find",
  "Could not find",
  // smelt_ores when inventory has no ore / no fuel (environment, not bug —
  // analogous to "No water found" for build_farm). Without "No fuel" excluded,
  // a working smelt skill gets retired during the team's fuel droughts, which
  // then permanently blocks the iron loop once ore IS available.
  "Nothing to smelt",
  "No fuel",
  // craft_gear with an empty inventory (environment, not bug)
  "No new tools crafted",
  "get materials first",
  // "timed out" removed — combat/mining skills that time out are real failures,
  // not precondition failures. exploreUntil timeouts use "aborted" instead.
];

/**
 * Source-backed procedures can be repaired without changing their public name.
 * Their failures may trigger a short runtime cooldown, but must never become a
 * permanent historical blacklist entry.
 */
export const STATIC_SKILL_NAMES = new Set([
  "build_house",
  "craft_gear",
  "light_area",
  "build_farm",
  "maintain_farm",
  "strip_mine",
  "smelt_ores",
  "go_fishing",
  "build_bridge",
  "build_structure",
  "setup_stash",
  "gather_seeds",
  "locate_farm_site",
  "survey_region",
  "establish_animal_pen",
]);

export class BotMemoryStore {
  private memory: BotMemory;
  private memoryFile: string;

  constructor(memoryFileName = "memory.json") {
    this.memoryFile = path.join(__dirname, "../../", memoryFileName);
    this.memory = createDefaultMemory();
  }

  // Static skills are TypeScript source files that developers can fix.
  // They should NOT be permanently blacklisted — clear them from brokenSkillNames
  // on every load so a fixed version gets a fresh chance each session.
  // Dynamic/Voyager skills have no developer fix path, so they stay permanently blocked.
  load(): BotMemory {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = fs.readFileSync(this.memoryFile, "utf-8");
        this.memory = normalizeMemory(JSON.parse(data));

        // Startup heal: remove static skills from brokenSkillNames so a fixed
        // version of the skill can be tried again. If still broken, it will
        // re-accumulate failures and be re-added within the session.
        const before = this.memory.brokenSkillNames.length;
        this.memory.brokenSkillNames = this.memory.brokenSkillNames.filter((s) => !STATIC_SKILL_NAMES.has(s));
        const healed = before - this.memory.brokenSkillNames.length;

        console.log(
          `[Memory] Loaded from ${path.basename(this.memoryFile)}: ${this.memory.structures.length} structures, ${this.memory.skillHistory.length} skill attempts, ${this.memory.brokenSkillNames.length} known broken skills${healed > 0 ? ` (healed ${healed} static skills)` : ""}`,
        );
      }
    } catch (err) {
      console.error("[Memory] Failed to load:", err);
      this.memory = createDefaultMemory();
    }
    return this.memory;
  }

  private save() {
    try {
      this.memory.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      console.error("[Memory] Failed to save:", err);
    }
  }

  addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean {
    const existing = this.memory.structures.find(
      (s) => s.type === type && Math.abs(s.x - x) < 10 && Math.abs(s.z - z) < 10,
    );
    if (existing) {
      // Upgrade the record (e.g. "Oak House (partial)" → "Oak House" once
      // a resumed build completes) instead of silently keeping stale notes.
      if (notes && existing.notes !== notes) {
        existing.notes = notes;
        this.save();
        console.log(`[Memory] Structure at ${existing.x}, ${existing.y}, ${existing.z} updated: ${notes}`);
      } else {
        console.log(`[Memory] Structure already exists nearby at ${existing.x}, ${existing.y}, ${existing.z}`);
      }
      return false;
    }
    this.memory.structures.push({
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      builtAt: new Date().toISOString(),
      notes,
    });
    console.log(`[Memory] Added ${type} at ${x}, ${y}, ${z}. Total: ${this.memory.structures.length}`);
    this.save();
    return true;
  }

  hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius = 50): boolean {
    return this.memory.structures.some(
      (s) => s.type === type && Math.abs(s.x - x) <= radius && Math.abs(s.z - z) <= radius,
    );
  }

  getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
    let nearest: Structure | null = null;
    let minDist = Infinity;
    for (const s of this.memory.structures) {
      if (s.type === type) {
        const dist = Math.sqrt((s.x - x) ** 2 + (s.z - z) ** 2);
        if (dist < minDist) {
          minDist = dist;
          nearest = s;
        }
      }
    }
    return nearest;
  }

  rememberFarmSite(
    water: { x: number; y: number; z: number },
    approach: { x: number; y: number; z: number },
  ): FarmSiteRecord {
    if (!this.memory.farmSites) this.memory.farmSites = [];
    const now = new Date().toISOString();
    const roundedWater = {
      x: Math.round(water.x),
      y: Math.round(water.y),
      z: Math.round(water.z),
    };
    const roundedApproach = {
      x: Math.round(approach.x),
      y: Math.round(approach.y),
      z: Math.round(approach.z),
    };
    const existing = this.memory.farmSites.find(
      (site) =>
        Math.abs(site.water.x - roundedWater.x) <= 2 &&
        Math.abs(site.water.y - roundedWater.y) <= 2 &&
        Math.abs(site.water.z - roundedWater.z) <= 2,
    );
    if (existing) {
      const approachChanged =
        existing.approach.x !== roundedApproach.x ||
        existing.approach.y !== roundedApproach.y ||
        existing.approach.z !== roundedApproach.z;
      existing.approach = roundedApproach;
      existing.updatedAt = now;
      if (existing.status === "blocked" && approachChanged) {
        existing.status = "discovered";
        existing.failures = 0;
        existing.lastFailure = undefined;
      }
      this.save();
      return {
        ...existing,
        water: { ...existing.water },
        approach: { ...existing.approach },
        plots: (existing.plots ?? []).map((plot) => ({ ...plot })),
      };
    }
    const site: FarmSiteRecord = {
      water: roundedWater,
      approach: roundedApproach,
      status: "discovered",
      failures: 0,
      discoveredAt: now,
      updatedAt: now,
    };
    this.memory.farmSites.push(site);
    // Avoid an unbounded map if agents explore for days.
    if (this.memory.farmSites.length > 24) {
      this.memory.farmSites = this.memory.farmSites.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 24);
    }
    this.save();
    console.log(
      `[Memory] Remembered farm shore at ${site.water.x}, ${site.water.y}, ${site.water.z} via ${site.approach.x}, ${site.approach.y}, ${site.approach.z}`,
    );
    return { ...site, water: { ...site.water }, approach: { ...site.approach }, plots: [] };
  }

  updateFarmSite(
    water: { x: number; y: number; z: number },
    status: FarmSiteRecord["status"],
    lastFailure?: string,
  ): void {
    if (!this.memory.farmSites) this.memory.farmSites = [];
    const site = this.memory.farmSites.find(
      (entry) =>
        Math.abs(entry.water.x - water.x) <= 2 &&
        Math.abs(entry.water.y - water.y) <= 2 &&
        Math.abs(entry.water.z - water.z) <= 2,
    );
    if (!site) return;
    // Once a farm has produced planted plots, a transient path/survey failure
    // must not erase its identity. Maintenance can still record the failure,
    // while the exact plot ledger remains available for the next attempt.
    site.status = site.status === "planted" && status !== "planted" ? "planted" : status;
    site.updatedAt = new Date().toISOString();
    if (lastFailure) {
      site.failures++;
      site.lastFailure = lastFailure.slice(0, 240);
      // A single timeout is transient. The objective executor already retries
      // once, so a second failure should advance to another remembered shore.
      if (site.failures >= 2 && status !== "planted" && site.status !== "planted") site.status = "blocked";
    } else if (status === "reachable" || status === "planted") {
      site.lastFailure = undefined;
      site.failures = 0;
    }
    this.save();
  }

  getFarmSites(): readonly FarmSiteRecord[] {
    return (this.memory.farmSites ?? []).map((site) => ({
      ...site,
      water: { ...site.water },
      approach: { ...site.approach },
      plots: (site.plots ?? []).map((plot) => ({ ...plot })),
    }));
  }

  /** Persist the exact soil blocks that make up a planted farm. */
  recordFarmPlots(water: { x: number; y: number; z: number }, plots: readonly FarmPlotRecord[]): void {
    if (!this.memory.farmSites) this.memory.farmSites = [];
    const site = this.memory.farmSites.find(
      (entry) =>
        Math.abs(entry.water.x - water.x) <= 2 &&
        Math.abs(entry.water.y - water.y) <= 2 &&
        Math.abs(entry.water.z - water.z) <= 2,
    );
    if (!site) return;

    const unique = new Map<string, FarmPlotRecord>();
    for (const plot of [...(site.plots ?? []), ...plots]) {
      const rounded = { x: Math.round(plot.x), y: Math.round(plot.y), z: Math.round(plot.z) };
      const key = `${rounded.x},${rounded.y},${rounded.z}`;
      const previous = unique.get(key);
      unique.set(key, {
        ...rounded,
        invalidChecks: Math.max(previous?.invalidChecks ?? 0, plot.invalidChecks ?? 0) || undefined,
      });
    }
    site.plots = [...unique.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    if (site.plots.length > 0) {
      site.status = "planted";
      site.failures = 0;
      site.lastFailure = undefined;
    }
    site.updatedAt = new Date().toISOString();
    this.save();
  }

  recordFarmPlotInvalid(water: { x: number; y: number; z: number }, plot: FarmPlotRecord): number {
    const site = (this.memory.farmSites ?? []).find(
      (entry) =>
        Math.abs(entry.water.x - water.x) <= 2 &&
        Math.abs(entry.water.y - water.y) <= 2 &&
        Math.abs(entry.water.z - water.z) <= 2,
    );
    const remembered = site?.plots?.find(
      (entry) => entry.x === Math.round(plot.x) && entry.y === Math.round(plot.y) && entry.z === Math.round(plot.z),
    );
    if (!remembered) return 0;
    remembered.invalidChecks = (remembered.invalidChecks ?? 0) + 1;
    if (site) site.updatedAt = new Date().toISOString();
    this.save();
    return remembered.invalidChecks;
  }

  clearFarmPlotInvalid(water: { x: number; y: number; z: number }, plot: FarmPlotRecord): void {
    const site = (this.memory.farmSites ?? []).find(
      (entry) =>
        Math.abs(entry.water.x - water.x) <= 2 &&
        Math.abs(entry.water.y - water.y) <= 2 &&
        Math.abs(entry.water.z - water.z) <= 2,
    );
    const remembered = site?.plots?.find(
      (entry) => entry.x === Math.round(plot.x) && entry.y === Math.round(plot.y) && entry.z === Math.round(plot.z),
    );
    if (!remembered?.invalidChecks) return;
    delete remembered.invalidChecks;
    if (site) site.updatedAt = new Date().toISOString();
    this.save();
  }

  removeFarmPlot(water: { x: number; y: number; z: number }, plot: FarmPlotRecord): boolean {
    const site = (this.memory.farmSites ?? []).find(
      (entry) =>
        Math.abs(entry.water.x - water.x) <= 2 &&
        Math.abs(entry.water.y - water.y) <= 2 &&
        Math.abs(entry.water.z - water.z) <= 2,
    );
    if (!site?.plots) return false;
    const before = site.plots.length;
    site.plots = site.plots.filter(
      (entry) => entry.x !== Math.round(plot.x) || entry.y !== Math.round(plot.y) || entry.z !== Math.round(plot.z),
    );
    if (site.plots.length === before) return false;
    site.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  recordScoutSector(
    id: string,
    waypoint: { x: number; y: number; z: number },
    reached: { x: number; y: number; z: number },
    observations: string[],
  ): void {
    if (!this.memory.scoutSectors) this.memory.scoutSectors = [];
    const record: ScoutSectorRecord = {
      id,
      waypoint: { ...waypoint },
      reached: { ...reached },
      observations: [...new Set(observations)].slice(0, 12),
      visitedAt: new Date().toISOString(),
    };
    const existing = this.memory.scoutSectors.find((entry) => entry.id === id);
    if (existing) Object.assign(existing, record);
    else this.memory.scoutSectors.push(record);
    this.memory.scoutSectors = this.memory.scoutSectors.slice(-16);
    this.save();
  }

  getScoutSectors(): readonly ScoutSectorRecord[] {
    return (this.memory.scoutSectors ?? []).map((record) => ({
      ...record,
      waypoint: { ...record.waypoint },
      reached: { ...record.reached },
      observations: [...record.observations],
    }));
  }

  recordSafetyZone(zone: string, center: { x: number; y: number; z: number }, torchesPlaced: number): void {
    if (!this.memory.safetyZones) this.memory.safetyZones = [];
    const record: SafetyZoneRecord = {
      zone,
      center: { ...center },
      torchesPlaced,
      securedAt: new Date().toISOString(),
    };
    const existing = this.memory.safetyZones.find((entry) => entry.zone === zone);
    if (existing) Object.assign(existing, record);
    else this.memory.safetyZones.push(record);
    this.save();
  }

  getSafetyZones(): readonly SafetyZoneRecord[] {
    return (this.memory.safetyZones ?? []).map((record) => ({
      ...record,
      center: { ...record.center },
    }));
  }

  recordDeath(x: number, y: number, z: number, cause: string): void {
    this.memory.deaths.push({
      location: `${x}, ${y}, ${z}`,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      cause,
      timestamp: new Date().toISOString(),
    });
    if (this.memory.deaths.length > 50) {
      this.memory.deaths = this.memory.deaths.slice(-50);
    }
    console.log(`[Memory] Recorded death at ${x}, ${y}, ${z} (cause: ${cause})`);
    this.save();
  }

  recordOre(oreType: string, x: number, y: number, z: number): void {
    const existing = this.memory.oreDiscoveries.find(
      (o) => o.type === oreType && Math.abs(o.x - x) < 5 && Math.abs(o.z - z) < 5,
    );
    if (existing) return;
    this.memory.oreDiscoveries.push({
      type: oreType,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      timestamp: new Date().toISOString(),
    });
    console.log(`[Memory] Discovered ${oreType} at ${x}, ${y}, ${z}`);
    this.save();
  }

  recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void {
    // Heal stale entries immediately as well as at load time. This matters for
    // long-running swarms upgraded through the TypeScript watcher.
    this.memory.brokenSkillNames = this.memory.brokenSkillNames.filter((name) => !STATIC_SKILL_NAMES.has(name));
    this.memory.skillHistory.push({ skill, success, durationSeconds, notes, timestamp: new Date().toISOString() });
    if (this.memory.skillHistory.length > 100) {
      this.memory.skillHistory = this.memory.skillHistory.slice(-100);
    }

    const skillAttempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    const successCount = skillAttempts.filter((s) => s.success).length;
    const successRate = skillAttempts.length > 0 ? (successCount / skillAttempts.length) * 100 : 0;

    const isPreconditionFail =
      !success && PRECONDITION_KEYWORDS.some((k) => notes.toLowerCase().includes(k.toLowerCase()));
    const realFailures = skillAttempts.filter(
      (a) => !a.success && !PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
    );
    if (
      !success &&
      !isPreconditionFail &&
      realFailures.length >= 5 &&
      !STATIC_SKILL_NAMES.has(skill) &&
      !this.memory.brokenSkillNames.includes(skill)
    ) {
      this.memory.brokenSkillNames.push(skill);
      console.log(`[Memory] ${skill} added to permanent broken skills list`);
    }
    // NOTE: we intentionally do NOT auto-remove from brokenSkillNames on success.
    // brokenSkillNames is permanently managed — a skill that was manually added or flagged
    // as broken (e.g., after deletion) stays broken. Fake successes from a buggy old
    // version of a skill must not inadvertently restore it.

    console.log(
      `[Memory] ${skill}: ${success ? "SUCCESS" : "FAIL"} (${successRate.toFixed(0)}% success rate over ${skillAttempts.length} attempts)`,
    );
    this.save();
  }

  getSkillSuccessRate(skill: string): { successRate: number; totalAttempts: number; avgDuration: number } {
    const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    if (attempts.length === 0) return { successRate: -1, totalAttempts: 0, avgDuration: 0 };
    const successes = attempts.filter((a) => a.success).length;
    const avgDuration = attempts.reduce((sum, a) => sum + a.durationSeconds, 0) / attempts.length;
    return { successRate: (successes / attempts.length) * 100, totalAttempts: attempts.length, avgDuration };
  }

  addLesson(lesson: string): void {
    this.memory.lessons.push(lesson);
    if (this.memory.lessons.length > 20) {
      this.memory.lessons = this.memory.lessons.slice(-20);
    }
    this.save();
  }

  getMemoryContext(): string {
    const parts: string[] = [];

    if (this.memory.objectiveCommitment) {
      const commitment = this.memory.objectiveCommitment;
      parts.push(
        `PERSISTENT PROJECT: ${commitment.objectiveId}${
          commitment.subobjectiveId ? ` → ${commitment.subobjectiveId}` : ""
        } (selected because: ${commitment.reason})`,
      );
    }

    // Show last 5 skill actions first — helps LLM detect spin loops and avoid repeating
    if (this.memory.skillHistory.length > 0) {
      const recent = this.memory.skillHistory.slice(-5);
      // Check if the bot is spinning: same skill repeated 3+ times with no-op notes
      const skillNames = recent.map((s) => s.skill);
      const dominant = skillNames.find((s) => skillNames.filter((x) => x === s).length >= 3);
      const spinWarning = dominant
        ? ` ⚠ WARNING: You have called '${dominant}' ${skillNames.filter((x) => x === dominant).length} times in a row — DO SOMETHING DIFFERENT!`
        : "";
      const recentDesc = recent
        .map((s) => {
          const icon = s.success ? "✓" : "✗";
          const note = s.notes.slice(0, 55).replace(/\n/g, " ");
          return `${icon}${s.skill}(${note})`;
        })
        .join(", ");
      parts.push(`LAST ${recent.length} ACTIONS: ${recentDesc}.${spinWarning}`);
    }

    if (this.memory.structures.length > 0) {
      const houses = this.memory.structures.filter((s) => s.type === "house");
      if (houses.length > 0) {
        parts.push(
          `HOUSES BUILT: ${houses.length} at ${houses.map((h) => `(${h.x}, ${h.z})`).join(", ")} — GOAL ACHIEVED, no need to build again`,
        );
      }
      const settlement = this.memory.structures.filter((s) => s.type === "warehouse" || s.type === "workshop");
      if (settlement.length > 0) {
        parts.push(
          `SETTLEMENT BUILDINGS: ${settlement
            .map(
              (s) =>
                `${s.type}${(s.notes ?? "").includes("partial") ? " (PARTIAL — finish this first)" : ""} at (${s.x}, ${s.z})`,
            )
            .join(", ")}`,
        );
      }
      const mines = this.memory.structures.filter((s) => s.type === "mine");
      if (mines.length > 0) {
        parts.push(
          `SHARED MINE: ${mines
            .map(
              (mine) =>
                `${(mine.notes ?? "").includes("partial") ? "PARTIAL" : "established"} entrance at (${mine.x}, ${mine.y}, ${mine.z})`,
            )
            .join(", ")}`,
        );
      }
    }

    if (this.memory.deaths.length > 0) {
      const recentDeaths = this.memory.deaths.slice(-5);
      parts.push(`RECENT DEATHS: ${recentDeaths.map((d) => `${d.cause} at (${d.x}, ${d.y}, ${d.z})`).join("; ")}`);
    }

    if (this.memory.oreDiscoveries.length > 0) {
      const uniqueOres = [...new Set(this.memory.oreDiscoveries.map((o) => o.type))];
      parts.push(`ORES FOUND: ${uniqueOres.join(", ")}`);
    }

    const brokenSet = new Set(this.memory.brokenSkillNames);
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    if (brokenSet.size > 0 || skills.length > 0) {
      const brokenLabel: string[] = [];
      const preconditionLabel: string[] = [];
      const normalStats: string[] = [];
      for (const skill of brokenSet) {
        brokenLabel.push(`${skill} (historically broken)`);
      }
      for (const skill of skills) {
        if (brokenSet.has(skill)) continue;
        const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
        const successes = attempts.filter((a) => a.success).length;
        const realFailures = attempts.filter(
          (a) =>
            !a.success && !PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
        );
        const preconditionFailures = attempts.filter(
          (a) =>
            !a.success && PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
        );
        // Static skills (fixable TypeScript source) should never be shown as permanently broken
        // based on history alone — a bug fix can change everything. Show normal stats for them.
        const isStatic = STATIC_SKILL_NAMES.has(skill);
        if (!isStatic && successes === 0 && realFailures.length >= 2) {
          // No successes, at least 2 genuine failures — truly broken (dynamic skills only)
          brokenLabel.push(`${skill} (failed ${attempts.length}/${attempts.length} times)`);
        } else if (successes === 0 && preconditionFailures.length >= 2 && realFailures.length === 0) {
          // All failures are precondition misses (no trees, no materials, etc.) — skill works, just needs resources
          preconditionLabel.push(`${skill} (needs resources — explore/gather first)`);
        } else {
          const rate = attempts.length > 0 ? ((successes / attempts.length) * 100).toFixed(0) : "0";
          normalStats.push(`${skill}: ${rate}%`);
        }
      }
      if (brokenLabel.length > 0) {
        parts.push(
          `BROKEN SKILLS — DO NOT USE EVER: ${brokenLabel.join(", ")}. These have NEVER succeeded. Choose completely different skills.`,
        );
      }
      if (preconditionLabel.length > 0) {
        parts.push(
          `SKILLS WAITING FOR RESOURCES (these work fine — just need prerequisites): ${preconditionLabel.join(", ")}`,
        );
      }
      if (normalStats.length > 0) {
        parts.push(`SKILL PERFORMANCE: ${normalStats.join(", ")}`);
      }
    }

    if (this.memory.lessons.length > 0) {
      const recentLessons = this.memory.lessons.slice(-3);
      parts.push(`LESSONS LEARNED: ${recentLessons.join("; ")}`);
    }

    return parts.length > 0 ? parts.join(". ") : "No memory yet.";
  }

  getBrokenSkills(): Map<string, string> {
    const broken = new Map<string, string>();
    for (const skill of this.memory.brokenSkillNames) {
      if (STATIC_SKILL_NAMES.has(skill)) continue;
      const msg = `Historically broken (0% success) — never use this skill`;
      broken.set(skill, msg);
      broken.set(`skill:${skill}`, msg);
    }
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    for (const skill of skills) {
      if (broken.has(skill)) continue;
      const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
      const successes = attempts.filter((a) => a.success).length;
      const realFailures = attempts.filter(
        (a) =>
          !a.success && !PRECONDITION_KEYWORDS.some((k) => (a.notes || "").toLowerCase().includes(k.toLowerCase())),
      );
      // Only flag as broken if there are REAL failures (not just precondition misses like "no trees").
      // Static skills (fixable source code) are excluded — historical crashes don't mean unfixable.
      const isStatic = STATIC_SKILL_NAMES.has(skill);
      if (!isStatic && successes === 0 && realFailures.length >= 2) {
        const msg = `Failed ${attempts.length} times (0% success rate) — this skill is broken, never use it`;
        broken.set(skill, msg);
        broken.set(`skill:${skill}`, msg);
      }
    }
    return broken;
  }

  /**
   * Remove skills from brokenSkillNames that are now in the skill registry.
   * Call this after loadDynamicSkills() so newly-created skill files auto-heal
   * any blacklist entries that accumulated before the file existed.
   */
  healBrokenSkillsFromRegistry(registeredNames: Set<string>): void {
    const before = this.memory.brokenSkillNames.length;
    this.memory.brokenSkillNames = this.memory.brokenSkillNames.filter((s) => !registeredNames.has(s));
    const healed = before - this.memory.brokenSkillNames.length;
    if (healed > 0) {
      console.log(
        `[Memory] Auto-healed ${healed} skill(s) now in registry: ${
          this.memory.brokenSkillNames.length === before ? "none" : "saved"
        }`,
      );
      this.save();
    }
  }

  /** Returns only the persistent brokenSkillNames list (for execution-layer gating). */
  getPersistentBrokenSkillNames(): Set<string> {
    return new Set(this.memory.brokenSkillNames);
  }

  /**
   * Returns a map of skill → soft-blacklist message for skills whose last 2+
   * attempts were all precondition failures with a known pattern.
   * Used to pre-populate recentFailures on restart so the bot doesn't re-run
   * the same failing actions immediately after a server disconnect.
   *
   * Only covers patterns that don't self-resolve with time (water proximity,
   * wool count). "No trees found" is intentionally excluded — the bot may have
   * moved to a new forest area since the last session.
   */
  getSkillHistory(): SkillAttempt[] {
    return this.memory.skillHistory;
  }

  getSessionPreconditionBlocks(): Map<string, string> {
    const result = new Map<string, string>();
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    for (const skill of skills) {
      const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
      const recent = attempts.slice(-3);
      // Only pre-block if the last 2+ attempts were all precondition failures
      if (recent.length < 2) continue;
      const allPrecondition = recent.every(
        (a) => !a.success && PRECONDITION_KEYWORDS.some((k) => a.notes.toLowerCase().includes(k.toLowerCase())),
      );
      if (!allPrecondition) continue;

      const lastNotes = recent[recent.length - 1].notes;
      if (/no water found/i.test(lastNotes)) {
        result.set(skill, "No water found within 96 blocks — explore to find a river or pond, then retry build_farm");
      } else if (/cannot find.*wool|need.*wool/i.test(lastNotes)) {
        result.set(
          skill,
          "Need 3 wool of same color — first EXPLORE to find a sheep flock, then use 'attack' on a sheep mob to get wool",
        );
      } else if (/no torch/i.test(lastNotes)) {
        result.set(skill, "No torches — mine coal_ore first, then craft torches (coal + stick), then retry light_area");
      }
      // "No trees found" excluded — bot may have moved to a new forest area.
    }
    return result;
  }

  shouldAvoidLocation(x: number, y: number, z: number, radius = 10): boolean {
    return this.memory.deaths.some((d) => Math.abs(d.x - x) < radius && Math.abs(d.z - z) < radius);
  }

  getStats(): { structures: number; deaths: number; ores: number; skills: number } {
    return {
      structures: this.memory.structures.length,
      deaths: this.memory.deaths.length,
      ores: this.memory.oreDiscoveries.length,
      skills: this.memory.skillHistory.length,
    };
  }

  /** Snapshot used for team-wide site planning; callers cannot mutate memory. */
  getStructures(): readonly Structure[] {
    return this.memory.structures.map((structure) => ({ ...structure }));
  }

  getSeasonGoal(): string | undefined {
    return this.memory.seasonGoal;
  }

  setSeasonGoal(goal: string): void {
    this.memory.seasonGoal = goal.trim();
    this.save();
    console.log(`[Memory] Season goal set: "${this.memory.seasonGoal}"`);
  }

  clearSeasonGoal(): void {
    this.memory.seasonGoal = undefined;
    this.save();
    console.log("[Memory] Season goal cleared.");
  }

  getObjectiveCommitment(): ObjectiveCommitment | undefined {
    return this.memory.objectiveCommitment ? { ...this.memory.objectiveCommitment } : undefined;
  }

  getProgressionObjectives(): string[] {
    return [...(this.memory.progressionObjectives ?? [])];
  }

  saveProgressionObjectives(ids: readonly string[]): void {
    const next = [...new Set(ids)].sort();
    if (JSON.stringify(next) === JSON.stringify([...(this.memory.progressionObjectives ?? [])].sort())) return;
    this.memory.progressionObjectives = next;
    this.save();
  }

  getProgressionStorage(): { deposited: boolean; retrieved: boolean } {
    return {
      deposited: !!this.memory.progressionStorage?.deposited,
      retrieved: !!this.memory.progressionStorage?.retrieved,
    };
  }

  recordProgressionStorage(operation: "deposited" | "retrieved"): void {
    this.memory.progressionStorage = { ...this.getProgressionStorage(), [operation]: true };
    this.save();
  }

  chooseObjective(objectiveId: ObjectiveId, reason: string): ObjectiveCommitment {
    const now = new Date().toISOString();
    const existing = this.memory.objectiveCommitment;
    this.memory.objectiveCommitment = {
      objectiveId,
      reason: reason.trim() || `Selected ${objectiveId}`,
      startedAt: existing?.objectiveId === objectiveId ? existing.startedAt : now,
      updatedAt: now,
    };
    this.save();
    console.log(`[Memory] Objective selected: ${objectiveId}`);
    return { ...this.memory.objectiveCommitment };
  }

  chooseSubobjective(subobjectiveId: string): ObjectiveCommitment | undefined {
    if (!this.memory.objectiveCommitment) return undefined;
    this.memory.objectiveCommitment.subobjectiveId = subobjectiveId;
    this.memory.objectiveCommitment.updatedAt = new Date().toISOString();
    this.save();
    console.log(`[Memory] Sub-objective selected: ${this.memory.objectiveCommitment.objectiveId} → ${subobjectiveId}`);
    return { ...this.memory.objectiveCommitment };
  }

  replaceObjectiveCommitment(commitment: ObjectiveCommitment): void {
    this.memory.objectiveCommitment = { ...commitment };
    this.save();
  }

  clearObjectiveSubobjective(): void {
    if (!this.memory.objectiveCommitment?.subobjectiveId) return;
    this.memory.objectiveCommitment.subobjectiveId = undefined;
    this.memory.objectiveCommitment.updatedAt = new Date().toISOString();
    this.save();
  }

  clearObjectiveCommitment(reason: string): void {
    if (!this.memory.objectiveCommitment) return;
    console.log(`[Memory] Objective cleared: ${this.memory.objectiveCommitment.objectiveId} (${reason})`);
    this.memory.objectiveCommitment = undefined;
    this.save();
  }
}

// ---------------------------------------------------------------------------
// Backward-compat singleton — used by src/llm/index.ts and any code that
// hasn't been migrated to per-bot BotMemoryStore instances yet.
// createBot in src/bot/index.ts creates its own per-bot store separately.
// ---------------------------------------------------------------------------
const _singleton = new BotMemoryStore("memory.json");

export function loadMemory(): BotMemory {
  return _singleton.load();
}
export function getMemoryContext(): string {
  return _singleton.getMemoryContext();
}
export function recordDeath(x: number, y: number, z: number, cause: string): void {
  _singleton.recordDeath(x, y, z, cause);
}
export function recordOre(oreType: string, x: number, y: number, z: number): void {
  _singleton.recordOre(oreType, x, y, z);
}
export function recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void {
  _singleton.recordSkillAttempt(skill, success, durationSeconds, notes);
}
export function getSkillSuccessRate(skill: string) {
  return _singleton.getSkillSuccessRate(skill);
}
export function addLesson(lesson: string): void {
  _singleton.addLesson(lesson);
}
export function addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean {
  return _singleton.addStructure(type, x, y, z, notes);
}
export function hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius?: number): boolean {
  return _singleton.hasStructureNearby(type, x, y, z, radius);
}
export function getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
  return _singleton.getNearestStructure(type, x, z);
}
export function getBrokenSkills(): Map<string, string> {
  return _singleton.getBrokenSkills();
}
export function shouldAvoidLocation(x: number, y: number, z: number, radius?: number): boolean {
  return _singleton.shouldAvoidLocation(x, y, z, radius);
}
export function getStats() {
  return _singleton.getStats();
}
export function getSeasonGoal(): string | undefined {
  return _singleton.getSeasonGoal();
}
export function setSeasonGoal(goal: string): void {
  _singleton.setSeasonGoal(goal);
}
export function clearSeasonGoal(): void {
  _singleton.clearSeasonGoal();
}
