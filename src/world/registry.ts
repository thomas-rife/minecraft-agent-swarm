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
  const point = new Vec3(intendedPosition.x, intendedPosition.y, intendedPosition.z);
  const block = bot.findBlock({
    matching: (candidate) => candidate.name === "chest" || candidate.name === "trapped_chest",
    point,
    maxDistance: radius,
  });
  if (!block) {
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
  const farmland = bot.findBlocks({ matching: (block) => block.name === "farmland", point, maxDistance: radius, count: 64 });
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
    failureReason: verified ? undefined : "Farm requires nine farmland blocks, four crops, nearby irrigation, and four safe walking cells.",
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
  persistStructures();
}
