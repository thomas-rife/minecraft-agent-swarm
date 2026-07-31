export interface RoutedObjective {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Deterministically maps durable intent to a verified high-level capability.
 * The LLM chooses the goal text; it does not choose movement or recipe leaves.
 */
export function routeOverallGoal(goal: string): RoutedObjective {
  const text = goal.toLowerCase();
  if (/\b(farm|wheat|crop|plant|harvest)\b/.test(text)) return { action: "build_farm", params: {} };
  if (/\b(house|home|shelter|base building)\b/.test(text)) return { action: "build_house", params: {} };
  if (/\b(stash|storage|warehouse|chest)\b/.test(text)) return { action: "setup_stash", params: {} };
  if (/\bbridge\b/.test(text)) return { action: "build_bridge", params: {} };
  if (/\b(light|lighting|torch|dark area)\b/.test(text)) return { action: "light_area", params: {} };
  if (/\b(smelt|furnace|ingot)\b/.test(text)) return { action: "smelt_ores", params: {} };
  if (/\b(fish|fishing)\b/.test(text)) return { action: "go_fishing", params: {} };
  if (/\b(tool|gear|armor|pickaxe|axe|shovel|sword)\b/.test(text)) return { action: "craft_gear", params: {} };
  if (/\b(mine|mining|ore|iron|coal|diamond|copper)\b/.test(text)) return { action: "strip_mine", params: {} };
  if (/\b(plank|boards?)\b/.test(text)) return { action: "craft", params: { item: "oak_planks", count: 1 } };
  if (/\b(wood|logs?|trees?|timber)\b/.test(text)) return { action: "gather_wood", params: { count: 5 } };
  return { action: "explore", params: {} };
}
