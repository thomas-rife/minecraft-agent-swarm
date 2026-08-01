import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { defaultStateFile, loadJsonFile, saveJsonFile } from "../persistence/json-store.js";

export type SharedStructureType = "stash" | "farm" | "house" | "mine_entrance" | "safe_point";
export type SharedStructureStatus = "absent" | "planned" | "building" | "verified" | "missing" | "destroyed";

export interface BoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface SharedStructure {
  id: string;
  type: SharedStructureType;
  status: SharedStructureStatus;
  position?: { x: number; y: number; z: number };
  bounds?: BoundingBox;
  owner?: string;
  verifiedAt?: number;
  evidence?: Record<string, unknown>;
  failureReason?: string;
  provenance: "config" | "world_observation" | "skill";
}

const structures = new Map<string, SharedStructure>();
const stashMissCounts = new Map<string, number>();
let persistenceFile: string | null = null;

export function configureSharedWorldPersistence(file = defaultStateFile("shared-structures.json")): void {
  if (persistenceFile) return;
  persistenceFile = file;
  const stored = loadJsonFile<SharedStructure[]>(file, []);
  for (const structure of stored) structures.set(structure.id, structure);
}

function persistStructures(): void {
  if (persistenceFile) saveJsonFile(persistenceFile, [...structures.values()]);
}

export function upsertSharedStructure(structure: SharedStructure): SharedStructure {
  const current = structures.get(structure.id);
  const merged = { ...current, ...structure };
  // Status transitions must not retain contradictory fields from the previous
  // state (for example status=missing with evidence.openable=true).
  if (merged.status === "verified") {
    delete merged.failureReason;
  } else if (["absent", "missing", "destroyed"].includes(merged.status)) {
    delete merged.evidence;
    delete merged.verifiedAt;
  }
  structures.set(structure.id, merged);
  persistStructures();
  return merged;
}

export function planSharedStructure(
  id: string,
  type: SharedStructureType,
  position: { x: number; y: number; z: number },
): SharedStructure {
  const existing = structures.get(id);
  if (existing?.status === "verified") return existing;
  return upsertSharedStructure({ id, type, position, status: "planned", provenance: "config" });
}

export function getSharedStructure(id: string): SharedStructure | undefined {
  return structures.get(id);
}

export function getVerifiedStructure(type: SharedStructureType): SharedStructure | undefined {
  return [...structures.values()].find((structure) => structure.type === type && structure.status === "verified");
}

export function markStructureUnverified(id: string, status: "missing" | "destroyed", reason: string): void {
  const current = structures.get(id);
  if (!current) return;
  structures.set(id, {
    ...current,
    status,
    failureReason: reason,
    verifiedAt: undefined,
    evidence: undefined,
  });
  persistStructures();
}

async function openContainerTimed(bot: Bot, block: Parameters<Bot["openContainer"]>[0], timeoutMs = 8_000) {
  return (await Promise.race([
    bot.openContainer(block),
    new Promise((_, reject) => setTimeout(() => reject(new Error("CONTAINER_OPEN_TIMEOUT")), timeoutMs)),
  ])) as Awaited<ReturnType<Bot["openContainer"]>>;
}

export async function verifyCanonicalStash(
  bot: Bot,
  id: string,
  intendedPosition: { x: number; y: number; z: number },
  radius = 3,
): Promise<SharedStructure> {
  const previouslyVerified = getSharedStructure(id);
  const anchor =
    previouslyVerified?.status === "verified" && previouslyVerified.position
      ? previouslyVerified.position
      : intendedPosition;
  const point = new Vec3(anchor.x, anchor.y, anchor.z);
  const block = bot.findBlock({
    matching: (candidate) =>
      (candidate.name === "chest" || candidate.name === "trapped_chest") &&
      Math.hypot(candidate.position.x - anchor.x, candidate.position.z - anchor.z) <= radius,
    point,
    // Canonical Y is approximate. Search the local vertical column while the
    // horizontal-radius predicate keeps unrelated containers out.
    maxDistance: Math.max(32, radius),
  });
  if (!block) {
    const current = getSharedStructure(id);
    // One bot can have an unloaded chunk while another has already verified
    // the canonical chest. Only repeated observations made near the site are
    // strong enough to overturn that shared fact.
    if (current?.status === "verified") {
      const observer = bot.entity?.position;
      if (!observer || Math.hypot(point.x - observer.x, point.z - observer.z) > radius + 4) return current;
      const misses = (stashMissCounts.get(id) ?? 0) + 1;
      stashMissCounts.set(id, misses);
      if (misses < 3) return current;
    }
    stashMissCounts.delete(id);
    const missing = upsertSharedStructure({
      id,
      type: "stash",
      status: "missing",
      position: intendedPosition,
      provenance: "world_observation",
      failureReason: "No chest found at the canonical site.",
    });
    return missing;
  }

  stashMissCounts.delete(id);
  try {
    const container = await openContainerTimed(bot, block);
    const items = container.containerItems().map((item) => ({ name: item.name, count: item.count }));
    const capacity = container.inventoryStart;
    container.close();
    return upsertSharedStructure({
      id,
      type: "stash",
      status: "verified",
      position: { x: block.position.x, y: block.position.y, z: block.position.z },
      provenance: "world_observation",
      verifiedAt: Date.now(),
      evidence: { block: block.name, capacity, items, openable: true },
    });
  } catch (error) {
    const current = getSharedStructure(id);
    // Container opens can fail transiently while another bot is using the
    // chest. Seeing the chest still proves it exists; preserve prior verified
    // state instead of oscillating the registry to missing.
    if (current?.status === "verified") return current;
    return upsertSharedStructure({
      id,
      type: "stash",
      status: "missing",
      position: intendedPosition,
      provenance: "world_observation",
      failureReason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function verifyFarmSite(
  bot: Bot,
  id: string,
  intendedPosition: { x: number; y: number; z: number },
  radius = 10,
): SharedStructure {
  const point = new Vec3(intendedPosition.x, intendedPosition.y, intendedPosition.z);
  const farmland = bot.findBlocks({
    matching: (block) => block.name === "farmland",
    point,
    maxDistance: radius,
    count: 64,
  });
  const water = bot.findBlock({ matching: (block) => block.name === "water", point, maxDistance: radius });
  const crops = bot.findBlocks({
    matching: (block) => ["wheat", "carrots", "potatoes", "beetroots"].includes(block.name),
    point,
    maxDistance: radius,
    count: 64,
  });
  const walkableGround = bot.findBlocks({
    matching: (block) => ["grass_block", "dirt", "stone", "cobblestone", "oak_planks"].includes(block.name),
    point,
    maxDistance: radius,
    count: 64,
  });
  const safeWalkingSpace = walkableGround.filter((position) => {
    const above = bot.blockAt(new Vec3(position.x, position.y + 1, position.z));
    const head = bot.blockAt(new Vec3(position.x, position.y + 2, position.z));
    return above?.name === "air" && head?.name === "air";
  }).length;
  const verified = farmland.length >= 9 && crops.length >= 4 && water !== null && safeWalkingSpace >= 4;
  const progressExists = farmland.length > 0 || crops.length > 0;
  return upsertSharedStructure({
    id,
    type: "farm",
    status: verified ? "verified" : progressExists ? "building" : "missing",
    position: intendedPosition,
    provenance: "world_observation",
    verifiedAt: verified ? Date.now() : undefined,
    evidence: { farmland: farmland.length, crops: crops.length, water: water?.position ?? null, safeWalkingSpace },
    failureReason: verified
      ? undefined
      : "Farm requires nine farmland blocks, four crops, nearby irrigation, and four safe walking cells.",
  });
}

export function formatSharedWorldFacts(): string {
  const entries = [...structures.values()];
  if (entries.length === 0) return "SHARED WORLD: No verified shared structures.";
  const lines = entries.map((structure) => {
    const pos = structure.position
      ? ` at (${Math.round(structure.position.x)}, ${Math.round(structure.position.y)}, ${Math.round(structure.position.z)})`
      : "";
    const freshness =
      structure.status === "verified" && structure.verifiedAt
        ? `; verified ${Math.round((Date.now() - structure.verifiedAt) / 1000)}s ago`
        : "";
    return `- ${structure.id}: ${structure.type} is ${structure.status}${pos}${freshness}`;
  });
  return `SHARED WORLD:\n${lines.join("\n")}`;
}

export function resetSharedWorldRegistry(): void {
  structures.clear();
  stashMissCounts.clear();
  persistStructures();
}
