/**
 * Deterministic goal/resource reconciliation.
 *
 * The LLM's goal is free text, so this module is intentionally conservative:
 * it only completes goals that can be proven from inventory or a distinctive
 * skill result. Unknown and multi-resource goals remain under LLM/critic
 * control. Wood requirements are per objective and are recalculated from the
 * current inventory; there is no permanent "wood unlocked" state.
 */

export const GENERIC_WOOD_RESERVE = 32; // eight logs, expressed as planks
/** One resumable construction batch for the 9x9 shared starter lodge. */
export const HOUSE_WOOD_TARGET = 128;
export const FARM_WOOD_TARGET = 8;
export const STASH_WOOD_TARGET = 20; // two chests plus a crafting table
export const STICK_RESERVE = 8;
export const TORCH_RESERVE = 8;

export type InventoryCounts = ReadonlyMap<string, number>;

export interface GoalFacts {
  action?: string;
  result?: string;
  nearbyCraftingTable?: boolean;
  /** Persisted remaining requirement after a partial deterministic skill. */
  woodTargetOverride?: number;
}

export interface WoodRequirement {
  purpose: string;
  currentPlankEquivalent: number;
  targetPlankEquivalent: number;
  deficitPlankEquivalent: number;
  deficitLogs: number;
  satisfied: boolean;
}

export interface GoalAssessment {
  goalComplete: boolean;
  goalCompleteReason?: string;
  wood?: WoodRequirement;
  item?: ItemRequirement;
}

export interface ItemRequirement {
  item: "stick" | "torch";
  purpose: string;
  current: number;
  target: number;
  deficit: number;
  satisfied: boolean;
}

const NON_WOOD_RESOURCES = /\b(coal|charcoal|iron|ore|stone|cobblestone|seed|wheat|wool|food|meat|diamond)\b/i;
const WOOD_TERMS = /\b(wood|logs?|planks?|timber|tree|trees|lumber|chop|chopping)\b/i;
const GATHER_TERMS = /\b(gather|collect|get|obtain|stock|stockpile|harvest|chop|chopping|cut)\b/i;

export function inventoryCounts(items: ReadonlyArray<{ name: string; count: number }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

export function countMatching(counts: InventoryCounts, predicate: (name: string) => boolean): number {
  let total = 0;
  for (const [name, count] of counts) {
    if (predicate(name)) total += count;
  }
  return total;
}

export function woodPlankEquivalent(counts: InventoryCounts): number {
  const logs = countMatching(counts, (name) => name.endsWith("_log") || name.endsWith("_stem"));
  const planks = countMatching(counts, (name) => name.endsWith("_planks"));
  return logs * 4 + planks;
}

function hasItem(counts: InventoryCounts, predicate: (name: string) => boolean): boolean {
  for (const [name, count] of counts) {
    if (count > 0 && predicate(name)) return true;
  }
  return false;
}

function woodRequirement(
  counts: InventoryCounts,
  target: number,
  purpose: string,
  satisfiedByOutput = false,
): WoodRequirement {
  const current = woodPlankEquivalent(counts);
  const deficit = satisfiedByOutput ? 0 : Math.max(0, target - current);
  return {
    purpose,
    currentPlankEquivalent: current,
    targetPlankEquivalent: target,
    deficitPlankEquivalent: deficit,
    deficitLogs: Math.ceil(deficit / 4),
    satisfied: satisfiedByOutput || deficit === 0,
  };
}

function explicitWoodTarget(goal: string): number | null {
  // "8 logs", "collect 12 planks", and similar concrete targets. Cap absurd
  // hallucinated quantities so one bad goal cannot create an endless project.
  const match = goal.match(/\b(\d{1,3})\s*(logs?|planks?|wood)\b/i);
  if (!match) return null;
  const amount = Math.min(Number(match[1]), 128);
  return /logs?/i.test(match[2]) ? amount * 4 : amount;
}

function explicitItemTarget(goal: string, item: "stick" | "torch"): number | null {
  const noun = item === "stick" ? "sticks?" : "torches?";
  const match = goal.match(new RegExp(`\\b(\\d{1,3})\\s*${noun}\\b`, "i"));
  return match ? Math.min(Number(match[1]), 128) : null;
}

function itemRequirement(
  counts: InventoryCounts,
  item: "stick" | "torch",
  target: number,
  purpose: string,
): ItemRequirement {
  const current = counts.get(item) ?? 0;
  return {
    item,
    purpose,
    current,
    target,
    deficit: Math.max(0, target - current),
    satisfied: current >= target,
  };
}

function resultCompletesHouse(result: string): boolean {
  return /\bHOUSE BUILT!/i.test(result) || /\bhouse already built\b/i.test(result);
}

function resultCompletesFarm(result: string): boolean {
  return /^Farm planted!\s+\d+\s+wheat seeds\b/i.test(result.trim()) || /^Farm complete\b/i.test(result.trim());
}

/**
 * Assess an active goal against facts that exist right now.
 *
 * A satisfied wood prerequisite does not complete a house/farm/stash goal; it
 * only tells the brain to stop gathering and perform the actual project.
 */
export function assessGoal(goalText: string, counts: InventoryCounts, facts: GoalFacts = {}): GoalAssessment {
  const goal = goalText.trim().toLowerCase();
  if (!goal) return { goalComplete: false };

  const result = facts.result ?? "";
  const hasTable = facts.nearbyCraftingTable === true || (counts.get("crafting_table") ?? 0) > 0;
  const hasHoe = hasItem(counts, (name) => name.endsWith("_hoe"));

  const houseProject =
    facts.action === "build_house" ||
    (/\b(house|home|shelter)\b/.test(goal) &&
      /\b(build|construct|make|finish|complete|repair|expand|prepare|gather|collect)\b/.test(goal));
  if (houseProject) {
    if (resultCompletesHouse(result)) {
      return { goalComplete: true, goalCompleteReason: "the house build reported completion" };
    }
    return {
      goalComplete: false,
      wood: woodRequirement(
        counts,
        Math.max(0, facts.woodTargetOverride ?? HOUSE_WOOD_TARGET),
        facts.woodTargetOverride === undefined ? "the house" : "the unfinished part of the house",
      ),
    };
  }

  const farmProject =
    facts.action === "build_farm" ||
    (/\b(farm|farmland)\b/.test(goal) &&
      /\b(build|create|make|start|establish|finish|complete|plant|prepare|gather|collect)\b/.test(goal));
  if (farmProject) {
    if (resultCompletesFarm(result)) {
      return { goalComplete: true, goalCompleteReason: "the farm reported that crops were planted" };
    }
    return {
      goalComplete: false,
      wood: woodRequirement(counts, FARM_WOOD_TARGET, "a hoe and crafting table", hasHoe),
    };
  }

  const storageProject =
    facts.action === "setup_stash" ||
    (/\b(stash|warehouse|storage|chests?)\b/.test(goal) &&
      /\b(build|create|make|set up|setup|establish|finish|complete|expand)\b/.test(goal));
  if (storageProject) {
    if (
      /\bstash (?:already )?(?:set up|exists)\b/i.test(result) ||
      /\bstash (?:bootstrapped|built|complete|ready)\b/i.test(result)
    ) {
      return { goalComplete: true, goalCompleteReason: "the storage setup reported completion" };
    }
    const chestCount = Math.min(2, counts.get("chest") ?? 0);
    const hasTwoChests = chestCount >= 2;
    const chestPlanksNeeded = (2 - chestCount) * 8;
    return {
      goalComplete: false,
      wood: woodRequirement(
        counts,
        chestPlanksNeeded + (hasTable ? 0 : 4),
        "two chests and a crafting table",
        hasTwoChests,
      ),
    };
  }

  if (/\bcrafting table\b/.test(goal)) {
    if (hasTable) {
      return {
        goalComplete: true,
        goalCompleteReason: "a crafting table is already available",
        wood: woodRequirement(counts, 4, "a crafting table", true),
      };
    }
    return { goalComplete: false, wood: woodRequirement(counts, 4, "a crafting table") };
  }

  const requestedToolMatch = goal.match(
    /\b(wooden|stone|iron|golden|diamond|netherite)[ _](pickaxe|axe|shovel|hoe|sword)\b/,
  );
  const requestedTool = requestedToolMatch ? `${requestedToolMatch[1]}_${requestedToolMatch[2]}` : undefined;
  const genericToolGoal = /\b(tool|tools|pickaxe|axe|shovel|hoe|sword)\b/.test(goal);
  if (requestedTool || genericToolGoal) {
    const hasRequestedOutput = requestedTool
      ? (counts.get(requestedTool) ?? 0) > 0
      : hasItem(counts, (name) => /_(pickaxe|axe|shovel|hoe|sword)$/.test(name));
    if (hasRequestedOutput) {
      return {
        goalComplete: true,
        goalCompleteReason: requestedTool ? `${requestedTool} is in inventory` : "the requested tool is in inventory",
      };
    }

    // This is only the wood prerequisite. Stone/iron/etc. may still be
    // missing, so meeting it never completes the overall crafting goal.
    const toolKind = requestedToolMatch?.[2] ?? (goal.match(/\b(pickaxe|axe|shovel|hoe|sword)\b/)?.[1] || "pickaxe");
    const sticksNeeded = toolKind === "sword" ? 1 : 2;
    const sticks = counts.get("stick") ?? 0;
    const stickPlanksNeeded = sticks >= sticksNeeded ? 0 : 2;
    const woodenToolPlanks: Record<string, number> = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2, sword: 2 };
    const isWoodenTool = !requestedToolMatch || requestedToolMatch[1] === "wooden";
    const toolPlanks = isWoodenTool ? woodenToolPlanks[toolKind] : 0;
    const tablePlanks = hasTable ? 0 : 4;
    return {
      goalComplete: false,
      wood: woodRequirement(counts, toolPlanks + stickPlanksNeeded + tablePlanks, "the requested tool"),
    };
  }

  const stickMention = goal.search(/\bsticks?\b/);
  const torchMention = goal.search(/\btorches?\b/);
  // Choose the output named first: "craft sticks for torches" is a stick goal,
  // while "craft torches using sticks" is a torch goal.
  if (stickMention >= 0 && (torchMention < 0 || stickMention < torchMention)) {
    const target = explicitItemTarget(goal, "stick") ?? STICK_RESERVE;
    const item = itemRequirement(counts, "stick", target, "the current stick-crafting goal");
    const compoundGoal =
      /\b(and|then)\b/.test(goal) &&
      /\b(coal|charcoal|torches?|tools?|pickaxe|build|light|place|farm|house|shelter)\b/.test(goal);
    return {
      goalComplete: item.satisfied && !compoundGoal,
      goalCompleteReason:
        item.satisfied && !compoundGoal ? `stick target reached (${item.current}/${item.target})` : undefined,
      item,
    };
  }

  if (/\btorches?\b/.test(goal)) {
    const target = explicitItemTarget(goal, "torch") ?? TORCH_RESERVE;
    const item = itemRequirement(counts, "torch", target, "the current torch-crafting goal");
    // Owning torches completes a crafting/supply goal, but not a larger goal
    // that explicitly includes placing them or lighting an area.
    const placementGoal =
      /\b(light|lighting|place|placing|illuminate|illuminating)\b.*\b(area|base|house|farm|cave|surroundings?)\b/.test(
        goal,
      ) ||
      /\b(and|then)\b.*\b(light|place|illuminate)\b/.test(goal) ||
      (/\b(and|then)\b/.test(goal) && /\bsticks?\b/.test(goal));
    const outputFocused = /\b(craft|make|produce|obtain|get|prepare|stock|supply)\b/.test(goal);
    const sticks = counts.get("stick") ?? 0;
    return {
      goalComplete: item.satisfied && outputFocused && !placementGoal,
      goalCompleteReason:
        item.satisfied && outputFocused && !placementGoal
          ? `torch target reached (${item.current}/${item.target})`
          : undefined,
      item,
      // Coal/charcoal is a separate prerequisite. Existing sticks mean more
      // tree gathering cannot advance this goal.
      wood: woodRequirement(counts, sticks > 0 ? 0 : 2, "torch sticks", sticks > 0),
    };
  }

  // Do not auto-complete compound resource goals from wood alone.
  if (WOOD_TERMS.test(goal) && NON_WOOD_RESOURCES.test(goal)) {
    const target = explicitWoodTarget(goal) ?? GENERIC_WOOD_RESERVE;
    return {
      goalComplete: false,
      wood: woodRequirement(counts, target, "the wood portion of the compound resource goal"),
    };
  }

  if (WOOD_TERMS.test(goal) && GATHER_TERMS.test(goal)) {
    // "Get 5 more logs" is relative to the inventory when the goal was set.
    // This stateless assessor cannot prove that baseline, so leave it to the
    // finite goal step budget instead of incorrectly treating 5 total as done.
    if (/\b(more|additional|another)\b/.test(goal)) return { goalComplete: false };
    const target = explicitWoodTarget(goal) ?? GENERIC_WOOD_RESERVE;
    const wood = woodRequirement(counts, target, "the current wood-gathering goal");
    return {
      goalComplete: wood.satisfied,
      goalCompleteReason: wood.satisfied ? `wood target reached (${wood.currentPlankEquivalent}/${target})` : undefined,
      wood,
    };
  }

  return { goalComplete: false };
}

/**
 * Every direct gather_wood action gets a deterministic stopping point.
 * Objective-specific requirements win; vague/unrelated goals fall back to the
 * modest general reserve. This prevents an LLM from bypassing the guard by
 * pairing gather_wood with goals such as "explore" or "mine more ore."
 */
export function assessWoodGatherDecision(
  goalText: string,
  counts: InventoryCounts,
  facts: GoalFacts = {},
): GoalAssessment {
  const assessment = assessGoal(goalText, counts, facts);
  if (assessment.goalComplete || assessment.wood) return assessment;

  const fallback = assessGoal("gather wood", counts, facts);
  return {
    ...assessment,
    wood: fallback.wood
      ? {
          ...fallback.wood,
          purpose: "the generic reserve (no larger wood requirement was found)",
        }
      : undefined,
  };
}

export function formatWoodRequirement(requirement: WoodRequirement): string {
  if (requirement.satisfied) {
    return `WOOD REQUIREMENT: satisfied for ${requirement.purpose} (${requirement.currentPlankEquivalent}/${requirement.targetPlankEquivalent} plank-equivalent). Do NOT gather more wood for this objective; perform the actual craft/build step.`;
  }
  return `WOOD REQUIREMENT: ${requirement.currentPlankEquivalent}/${requirement.targetPlankEquivalent} plank-equivalent for ${requirement.purpose}; deficit ${requirement.deficitPlankEquivalent} planks (about ${requirement.deficitLogs} logs). Gather/withdraw only that deficit, then continue the objective.`;
}

export function formatItemRequirement(requirement: ItemRequirement): string {
  if (requirement.satisfied) {
    return `${requirement.item.toUpperCase()} REQUIREMENT: satisfied (${requirement.current}/${requirement.target}). Do NOT craft or withdraw more ${requirement.item}s for this objective.`;
  }
  return `${requirement.item.toUpperCase()} REQUIREMENT: ${requirement.current}/${requirement.target}; need ${requirement.deficit} more for ${requirement.purpose}.`;
}
