/**
 * Shared progression goals, independent of role-specific execution procedures.
 * Examples teach methods; they are not required solutions. Completion must be
 * supplied by world verifiers, never by generated code or an LLM success claim.
 */
export interface ProgressionObjective {
  id: string;
  goal: string;
  acceptance: string;
  examples: readonly string[];
}

export interface ProgressionStage {
  id: string;
  label: string;
  prerequisites: readonly string[];
  objectives: readonly ProgressionObjective[];
}

export const PROGRESSION_TREE: readonly ProgressionStage[] = [
  {
    id: "first_shelter",
    label: "1 — First shelter",
    prerequisites: [],
    objectives: [
      {
        id: "wood_supply",
        goal: "Gather a starter supply of wood",
        acceptance: "Collect at least 16 logs through gameplay.",
        examples: ["mineWoodLog"],
      },
      {
        id: "crafting_station",
        goal: "Establish a crafting station",
        acceptance: "Place a reachable crafting table anywhere in the world, including away from the settlement.",
        examples: ["craftCraftingTable"],
      },
      {
        id: "wooden_pickaxe",
        goal: "Obtain a first mining tool",
        acceptance: "Produce a wooden or better pickaxe.",
        examples: ["craftWoodenPickaxe"],
      },
      {
        id: "starter_shelter",
        goal: "Design and build a small starter shelter",
        acceptance:
          "Build at least a 4×4 footprint with a floor, roof, enclosing walls, usable entrance, and a clear interior at least two blocks high. Choose the design and materials.",
        examples: ["build_house"],
      },
    ],
  },
  {
    id: "stone_survival",
    label: "2 — Stone survival",
    prerequisites: ["first_shelter"],
    objectives: [
      {
        id: "stone_pickaxe",
        goal: "Upgrade mining to stone",
        acceptance: "Produce a stone or better pickaxe.",
        examples: ["mineTenCobblestone", "craftStonePickaxe"],
      },
      {
        id: "furnace_station",
        goal: "Establish a working furnace",
        acceptance: "Place a reachable furnace and successfully smelt or cook an item.",
        examples: ["craftFurnace", "smelt_ores"],
      },
      {
        id: "fuel_supply",
        goal: "Acquire furnace fuel",
        acceptance: "Collect or produce at least eight coal or charcoal.",
        examples: ["mineFiveCoalOres"],
      },
      {
        id: "renewable_food",
        goal: "Establish a renewable food source",
        acceptance:
          "Establish planted crops or a breeding pair of penned food animals, and obtain food from that source.",
        examples: ["build_farm", "establish_animal_pen", "maintain_farm"],
      },
    ],
  },
  {
    id: "established_base",
    label: "3 — Established base",
    prerequisites: ["stone_survival"],
    objectives: [
      {
        id: "expanded_house",
        goal: "Design a larger shared house",
        acceptance:
          "Build a usable shelter with at least 36 clear interior floor blocks, reachable crafting and storage, and interior lighting. Its design is up to the agent.",
        examples: ["build_house", "build_structure", "light_area"],
      },
      {
        id: "shared_storage",
        goal: "Establish shared resource storage",
        acceptance: "Place at least two reachable chests and successfully deposit and retrieve resources.",
        examples: ["setup_stash", "craftChest"],
      },
    ],
  },
  {
    id: "iron_industry",
    label: "4 — Iron industry",
    // Equipment can advance while the builder expands the base.
    prerequisites: ["stone_survival"],
    objectives: [
      {
        id: "iron_pickaxe",
        goal: "Upgrade mining to iron",
        acceptance: "Produce an iron or better pickaxe.",
        examples: ["strip_mine", "smelt_ores", "craftIronPickaxe"],
      },
      {
        id: "iron_protection",
        goal: "Prepare an expedition equipment set",
        acceptance:
          "Produce a full iron or better armor set, a shield, and an iron or better sword for an expedition member.",
        examples: ["craft_gear", "craftShieldImproved", "craftIronSword"],
      },
      {
        id: "water_bucket",
        goal: "Acquire portable water",
        acceptance: "Produce and fill a water bucket.",
        examples: ["craftBucket", "fillBucketWithWater"],
      },
    ],
  },
  {
    id: "nether_preparation",
    label: "5 — Nether preparation",
    prerequisites: ["iron_industry"],
    objectives: [
      {
        id: "nether_portal",
        goal: "Construct and activate a Nether portal",
        acceptance:
          "Verify an active, reachable portal built through gameplay; mined obsidian and bucket casting are both acceptable.",
        examples: [],
      },
      {
        id: "expedition_supplies",
        goal: "Stock an expedition kit",
        acceptance:
          "An expedition member simultaneously carries the protection set, at least 16 cooked food items, 64 building blocks, and flint and steel.",
        examples: ["craft_gear", "cookPorkchops"],
      },
    ],
  },
  {
    id: "nether_expedition",
    label: "6 — Nether expedition",
    prerequisites: ["nether_preparation"],
    objectives: [
      {
        id: "nether_entry",
        goal: "Enter the Nether",
        acceptance: "Observe an expedition member enter the Nether dimension through the portal.",
        examples: [],
      },
      {
        id: "fortress_route",
        goal: "Find a Nether fortress and establish a return route",
        acceptance: "Verify a fortress location and record a traversed route connecting it to the entry portal.",
        examples: [],
      },
      {
        id: "blaze_rods",
        goal: "Obtain blaze rods",
        acceptance: "Collect at least two blaze rods through gameplay.",
        examples: [],
      },
    ],
  },
];

/** Durable, team-wide milestone IDs recorded only after external verification. */
export interface ProgressionState {
  completedObjectives: readonly string[];
}

export interface EvaluatedProgressionStage extends ProgressionStage {
  status: "locked" | "available" | "complete";
  remainingObjectives: readonly ProgressionObjective[];
  /** Examples from this stage and every prerequisite ancestor are retained. */
  availableExamples: readonly string[];
}

export function evaluateProgression(state: ProgressionState): EvaluatedProgressionStage[] {
  const evidence = new Set(state.completedObjectives);
  const evaluated = new Map<string, EvaluatedProgressionStage>();
  for (const stage of PROGRESSION_TREE) {
    const parents = stage.prerequisites.map((id) => {
      const parent = evaluated.get(id);
      if (!parent) throw new Error(`Progression prerequisite ${id} must precede ${stage.id}`);
      return parent;
    });
    const unlocked = parents.every((parent) => parent.status === "complete");
    const remainingObjectives = stage.objectives.filter((objective) => !evidence.has(objective.id));
    const status = !unlocked ? "locked" : remainingObjectives.length ? "available" : "complete";
    evaluated.set(stage.id, {
      ...stage,
      status,
      remainingObjectives,
      availableExamples: unlocked
        ? [
            ...new Set([
              ...parents.flatMap((parent) => parent.availableExamples),
              ...stage.objectives.flatMap((objective) => objective.examples),
            ]),
          ]
        : [],
    });
  }
  return [...evaluated.values()];
}

/** Called by a verifier after its acceptance check, not by the skill executor. */
export function recordVerifiedObjective(state: ProgressionState, objectiveId: string): ProgressionState {
  const stage = evaluateProgression(state).find((entry) =>
    entry.objectives.some((objective) => objective.id === objectiveId),
  );
  if (!stage) throw new Error(`Unknown progression objective: ${objectiveId}`);
  if (stage.status === "locked") throw new Error(`Progression objective ${objectiveId} is locked`);
  return { completedObjectives: [...new Set([...state.completedObjectives, objectiveId])] };
}
