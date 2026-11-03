import { evaluateProgression, recordVerifiedObjective, type ProgressionState } from "./progression-tree.js";
import type {
  EvaluatedObjective,
  ObjectiveCommitment,
  ObjectiveId,
  ObjectiveSnapshot,
  ObjectiveTreeView,
} from "./objective-tree.js";

/** Positive observations from live world checks. Missing/unloaded data is false. */
export interface ProgressionObservations {
  logs: number;
  craftingStation: boolean;
  pickaxeRank: number;
  shelter: boolean;
  expandedHouse: boolean;
  operatedFurnace: boolean;
  fuel: number;
  renewableFood: boolean;
  sharedStorage: boolean;
  ironProtection: boolean;
  waterBucket: boolean;
}

export function reconcileProgression(state: ProgressionState, observed: ProgressionObservations): ProgressionState {
  const checks: Record<string, boolean> = {
    wood_supply: observed.logs >= 16,
    crafting_station: observed.craftingStation,
    wooden_pickaxe: observed.pickaxeRank >= 1,
    starter_shelter: observed.shelter,
    stone_pickaxe: observed.pickaxeRank >= 2,
    furnace_station: observed.operatedFurnace,
    fuel_supply: observed.fuel >= 8,
    renewable_food: observed.renewableFood,
    expanded_house: observed.expandedHouse,
    shared_storage: observed.sharedStorage,
    iron_pickaxe: observed.pickaxeRank >= 3,
    iron_protection: observed.ironProtection,
    water_bucket: observed.waterBucket,
  };
  let next = state;
  // Evaluate in tree order so observed achievements can unlock descendants.
  for (const stage of evaluateProgression(state)) {
    const current = evaluateProgression(next).find((entry) => entry.id === stage.id)!;
    if (current.status !== "available") continue;
    for (const objective of current.remainingObjectives) {
      if (checks[objective.id]) next = recordVerifiedObjective(next, objective.id);
    }
  }
  return next;
}

const SPECIALISTS: Record<string, string[]> = {
  wood_supply: ["Explorer / Miner", "Miner / Smelter"],
  crafting_station: ["Farmer / Crafter"],
  wooden_pickaxe: ["Miner / Smelter", "Explorer / Miner"],
  starter_shelter: ["Builder"],
  stone_pickaxe: ["Miner / Smelter", "Explorer / Miner"],
  furnace_station: ["Miner / Smelter"],
  fuel_supply: ["Explorer / Miner", "Miner / Smelter"],
  renewable_food: ["Farmer / Crafter"],
  expanded_house: ["Builder"],
  shared_storage: ["Builder"],
  iron_pickaxe: ["Miner / Smelter", "Explorer / Miner"],
  iron_protection: ["Farmer / Crafter", "Combat / Guard"],
  water_bucket: ["Farmer / Crafter"],
};

export function buildProgressionView(
  snapshot: ObjectiveSnapshot,
  state: ProgressionState,
  commitment?: ObjectiveCommitment,
): ObjectiveTreeView {
  const objectives = evaluateProgression(state).map<EvaluatedObjective>((stage) => {
    const remaining = new Set(stage.remainingObjectives.map((objective) => objective.id));
    const unclaimed = stage.objectives.filter(
      (objective) =>
        !snapshot.teamCommitments.some(
          (entry) => entry.name !== snapshot.botName && entry.subobjectiveId === `progression:${objective.id}`,
        ),
    );
    const preferred = unclaimed.filter(
      (objective) =>
        remaining.has(objective.id) &&
        SPECIALISTS[objective.id]?.includes(snapshot.role) &&
        !snapshot.recentlyFailed.has(`objective:progression:${objective.id}`),
    );
    const subobjectives = stage.objectives.map((objective) => ({
      id: `progression:${objective.id}`,
      label: objective.goal,
      description: `${objective.acceptance} Examples: ${objective.examples.join(", ") || "none yet"}.`,
      complete: !remaining.has(objective.id),
      relevant:
        stage.status !== "locked" &&
        !!SPECIALISTS[objective.id] &&
        unclaimed.includes(objective) &&
        (preferred.length === 0 || SPECIALISTS[objective.id].includes(snapshot.role)),
    }));
    return {
      id: stage.id as ObjectiveId,
      label: stage.label,
      description: "Complete the remaining verified team milestones to unlock the next stage.",
      preferredRoles: [...new Set(stage.objectives.flatMap((objective) => SPECIALISTS[objective.id] ?? []))],
      maxWorkers: 5,
      status: `${stage.status}; ${stage.objectives.length - stage.remainingObjectives.length}/${stage.objectives.length} verified milestones`,
      complete: stage.status === "complete",
      available: stage.status === "available",
      claimedBy: snapshot.teamCommitments.filter((entry) => entry.objectiveId === stage.id).map((entry) => entry.name),
      subobjectives,
    };
  });
  const activeObjective = objectives.find((objective) => objective.id === commitment?.objectiveId);
  const activeSubobjective = activeObjective?.subobjectives.find((sub) => sub.id === commitment?.subobjectiveId);
  return { progression: true, snapshot, objectives, commitment, activeObjective, activeSubobjective };
}

export function renderProgressionReport(state: ProgressionState): string {
  return [
    "TEAM PROGRESSION (verified achievements persist; current supplies still need maintenance):",
    ...evaluateProgression(state).map(
      (stage) =>
        `- ${stage.label}: ${stage.status} (${stage.objectives.length - stage.remainingObjectives.length}/${stage.objectives.length})${stage.status === "available" ? `; remaining: ${stage.remainingObjectives.map((objective) => objective.goal).join("; ")}` : ""}`,
    ),
    "Nether stages are roadmap goals; their executors and verifiers are not implemented yet.",
  ].join("\n");
}
