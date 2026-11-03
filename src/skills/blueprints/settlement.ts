import type { Blueprint } from "../types.js";
import { warehouseBlueprint } from "./warehouse.js";
import { workshopBlueprint } from "./workshop.js";

export type SettlementStructureName = "warehouse" | "workshop";

export const SETTLEMENT_BLUEPRINTS: Record<SettlementStructureName, Blueprint> = {
  warehouse: warehouseBlueprint,
  workshop: workshopBlueprint,
};

export function isSettlementStructureName(value: unknown): value is SettlementStructureName {
  return value === "warehouse" || value === "workshop";
}
