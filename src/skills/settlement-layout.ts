import type { Structure } from "../bot/memory.js";
import type { Blueprint } from "./types.js";
import type { SettlementStructureName } from "./blueprints/settlement.js";

export interface Footprint {
  x: number;
  z: number;
  width: number;
  depth: number;
}

const KNOWN_DIMENSIONS: Partial<Record<Structure["type"], [number, number]>> = {
  house: [9, 9],
  warehouse: [9, 7],
  workshop: [7, 7],
};

/**
 * The house sits north of the stash/town-center coordinate, with its southern
 * entrance facing the shared work yard. The returned point is the center of
 * the preferred footprint; terrain search may move the final origin slightly.
 */
export function preferredHouseCenter(anchor: { x: number; z: number }): { x: number; z: number } {
  return { x: anchor.x, z: anchor.z - 12 };
}

/**
 * Keep the shared mine outside the core building yard while retaining it
 * inside the settlement's coordination radius. The entrance is relative to
 * the anchor so moving the base never leaves a world-specific coordinate in
 * the mining logic.
 */
export function preferredMineEntrance(anchor: { x: number; z: number }): { x: number; z: number } {
  return { x: anchor.x - 28, z: anchor.z + 24 };
}

/**
 * Put the warehouse and workshop on opposite sides of the recorded house.
 * These are relative centers, not world coordinates, so the layout follows a
 * moved base or a completely different world.
 */
export function preferredCenter(
  structure: SettlementStructureName,
  house: Pick<Structure, "x" | "z">,
): { x: number; z: number } {
  const houseCenterX = house.x + Math.floor((KNOWN_DIMENSIONS.house?.[0] ?? 9) / 2);
  const houseCenterZ = house.z + Math.floor((KNOWN_DIMENSIONS.house?.[1] ?? 9) / 2);
  return {
    x: houseCenterX + (structure === "warehouse" ? -20 : 20),
    z: houseCenterZ,
  };
}

export function footprintAtCenter(center: { x: number; z: number }, blueprint: Blueprint): Footprint {
  return {
    x: Math.round(center.x - Math.floor(blueprint.dimensions[0] / 2)),
    z: Math.round(center.z - Math.floor(blueprint.dimensions[2] / 2)),
    width: blueprint.dimensions[0],
    depth: blueprint.dimensions[2],
  };
}

export function structureFootprint(structure: Structure): Footprint | null {
  const dimensions = KNOWN_DIMENSIONS[structure.type];
  if (!dimensions) return null;
  return { x: structure.x, z: structure.z, width: dimensions[0], depth: dimensions[1] };
}

export function footprintsOverlap(a: Footprint, b: Footprint, clearance = 3): boolean {
  return !(
    a.x + a.width + clearance <= b.x ||
    b.x + b.width + clearance <= a.x ||
    a.z + a.depth + clearance <= b.z ||
    b.z + b.depth + clearance <= a.z
  );
}
