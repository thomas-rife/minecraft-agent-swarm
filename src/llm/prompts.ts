/**
 * Focused prompt templates for the event-driven brain.
 *
 * Instead of one massive ~5000-token system prompt for every decision,
 * we use small, focused prompts matched to the decision type:
 * - Strategic (~1200 tokens) — goal planning, uses strong model (32b)
 * - Reactive (~300 tokens)   — combat/survival, uses fast model (8b)
 * - Critic (~400 tokens)     — verify action results, uses fast model
 * - Chat (~200 tokens)       — respond to players, uses fast model
 */

import { ACTION_SIGNATURES, renderActionMenu, type ActionOption } from "../bot/action-menu.js";

export interface RoleContext {
  name: string;
  personality: string;
  role?: string;
  seasonGoal?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
  /** Deterministically filtered live action/skill menu for this decision. */
  actionOptions?: ActionOption[];
}

/**
 * Strategic prompt — goal-setting and planning decisions.
 * Used with the strong model (32b). Called every ~10s or on goal complete/fail.
 */
function renderActions(names: string[]): string {
  return names.map((a) => ACTION_SIGNATURES[a] ?? a).join(", ");
}

export function buildStrategicPrompt(role: RoleContext): string {
  const name = role.name;

  // Production callers supply a deterministic menu derived from live world
  // state. The role list remains a safe legacy fallback for prompt-only tests.
  const actionOptions = role.actionOptions ?? [];
  const actions =
    actionOptions.length > 0
      ? renderActionMenu(actionOptions)
      : renderActions(role.allowedActions?.length ? role.allowedActions : ["explore", "go_to", "idle"]);
  const preferredActions = role.allowedActions?.length ? role.allowedActions.join(", ") : "";

  const builtinSkills = role.allowedSkills?.length ? role.allowedSkills.join(", ") : "";
  const hierarchySelection = actionOptions.some(
    (option) =>
      option.action === "choose_objective" ||
      option.action === "choose_subobjective" ||
      option.action === "leave_objective",
  );
  const hierarchyOptions = actionOptions.filter(
    (option) =>
      option.action === "choose_objective" ||
      option.action === "choose_subobjective" ||
      option.action === "leave_objective",
  );
  const hierarchyExample = hierarchyOptions[0];

  const missionLine = role.seasonGoal
    ? `🎯 MISSION: ${role.seasonGoal}\nEvery decision should advance this mission.\n\n`
    : "";

  if (hierarchySelection) {
    return `${missionLine}You are ${name}, an AI playing Minecraft.
${role.personality}
${role.role ? `ROLE: ${role.role}\n` : ""}

You are at a STRATEGIC SELECTION level. Choose exactly one entry from
AVAILABLE NOW. Do not choose a Minecraft action or skill—the controller will
execute those automatically after you choose a sub-objective.

AVAILABLE NOW:
${renderActionMenu(hierarchyOptions)}

Return exactly one JSON object using the action and parameter names shown
above. Copy one allowed objective/sub-objective ID exactly. Do not add a goal,
goalSteps, coordinates, item, skill, or extra action.

RESPONSE:
{"thought":"Brief reason under 120 characters","action":"${hierarchyExample?.action ?? "choose_objective"}","params":${hierarchyExample?.signature.match(/\{.*\}$/)?.[0] ?? '{"objective":"exact_allowed_id"}'}}
`;
  }

  return `${missionLine}You are ${name}, an AI playing Minecraft on a livestream. Chat controls you.
${role.personality}

${role.role ? `ROLE: ${role.role}\n` : ""}AVAILABLE NOW — choose EXACTLY one entry; anything else will be rejected:
${actions}
${preferredActions ? `ROLE-PREFERRED ACTIONS (guidance only): ${preferredActions}` : ""}
${builtinSkills ? `ROLE SPECIALTIES (they appear above only when currently relevant): ${builtinSkills}` : ""}

${role.priorities || ""}

CRAFTING BASICS:
- Logs → planks (1 log = 4 planks). Planks → sticks (2 planks = 4 sticks).
- 3 planks + 2 sticks → wooden_pickaxe. 4 planks → crafting_table.
- Wool from killing sheep (0-2 per sheep). 3 wool + 3 planks → bed.
- Use exact Minecraft IDs: oak_planks, stick, wooden_pickaxe, etc.

RULES:
- Respond ONLY with valid JSON. Keep "thought" under 120 chars — shown on stream.
- Be entertaining and in-character in your "thought" wording — BUT base every
  decision on the ACTUAL STATE below. Do NOT invent mobs, danger, nighttime,
  trees, or surroundings that aren't listed in your context. Flavor the words,
  never the facts: if the state says daytime and no threats, you are safe.
- READ your inventory before choosing. Don't craft without materials.
- Obey the deterministic WOOD REQUIREMENT in the state. It is specific to the
  current objective. Once it says satisfied, STOP gathering wood and craft/build;
  a later objective will calculate a new deficit if more wood is needed.
- Finished outputs beat ingredients: if you already have the requested tool, or
  the state says a table/farm/house exists, move on even if raw wood is low.
- Obey STICK REQUIREMENT and TORCH REQUIREMENT exactly. Existing stacks count;
  never craft or withdraw more after the requirement says satisfied.
- Never invent an action or skill. Use an exact action/signature from AVAILABLE NOW.
- If an action or skill is absent from AVAILABLE NOW, its target, prerequisites,
  or situational reason is not currently present. Choose a listed alternative.
- Decision making is hierarchical. When AVAILABLE NOW contains choose_objective,
  select the high-level project that best fits world needs and your role. When it
  contains choose_subobjective, select the approach/phase you want to pursue.
- After you choose a sub-objective, Mineflayer executes its required skills
  automatically. You do NOT choose its internal skills. You are consulted again
  only when that procedure completes, blocks, or needs a new strategic choice.
- A persistent ACTIVE PROJECT outranks an improvised goal sentence. Do not rename
  the project through "goal"; explicitly leave it only when reprioritization is justified.
- If an action failed recently, try something COMPLETELY DIFFERENT.
- FOCUS: Finish one goal before starting another. Plan 3-5 steps ahead.
- PREFER a listed skill over manual actions when it advances the goal.
- Roles guide priorities, not permanent permissions. A non-specialty skill will
  appear in AVAILABLE NOW when the active goal genuinely matches it.
- RESOURCE SHARING — USE THE STASH, NOT CHAT: when withdraw_stash or
  deposit_stash appears in AVAILABLE NOW, prefer it over begging teammates.
  Never invent a stash action when it is absent.

RESPONSE FORMAT:
{"thought":"Brief entertaining narration","action":"action_name","params":{...},"goal":"Current objective","goalSteps":5}

Set "goal" when starting something new. Omit when continuing.
`;
}

/**
 * Reactive prompt — urgent survival decisions.
 * Used with fast model (8b). Called on hostile spotted, damage taken, low health.
 * Deliberately tiny (~300 tokens) so the 8b model can handle it reliably.
 */
export function buildReactivePrompt(name: string, actionOptions?: ActionOption[]): string {
  // Survival capabilities are shared: any bot must be able to defend itself.
  const actionDescriptions: Record<string, string> = {
    attack: "attack: Melee attack nearest mob",
    flee: "flee: Run away from danger",
    eat: "eat: Eat food to restore health/hunger",
    neural_combat: 'neural_combat: AI-driven combat (params: {"duration": 5})',
    go_to: "go_to: Move to a location",
    idle: "idle: Wait and reassess",
  };
  const reactiveRelevant = new Set(["attack", "flee", "eat", "neural_combat", "explore", "idle"]);
  const filtered = actionOptions?.filter((option) => reactiveRelevant.has(option.action)) ?? [];
  const available =
    filtered.length > 0
      ? renderActionMenu(filtered)
      : ["flee", "explore", "idle"].map((action) => `- ${actionDescriptions[action] || action}`).join("\n");

  return `You are ${name} in Minecraft. QUICK DECISION — react to the situation below.

Choose ONE action. Respond with JSON ONLY:
{"thought":"Brief reaction (under 80 chars)","action":"action_name","params":{}}

Available actions:
${available}
`;
}

/**
 * Critic prompt — verify action results and decide next step.
 * Used with fast model (8b). Called after every action completes.
 * Determines if we should continue the current goal or re-plan.
 */
export function buildCriticPrompt(name: string, actionOptions?: ActionOption[]): string {
  const menu = actionOptions?.length ? renderActionMenu(actionOptions) : renderActions(["explore", "go_to", "idle"]);
  const actionLine = `\nAVAILABLE NOW — nextAction must be an exact action from one entry:
${menu}
Do not invent an action or skill. If none advances the goal, complete/replan it.`;

  return `You are ${name}'s inner critic. Evaluate the last action and decide what's next.

RULES:
- If the action SUCCEEDED and goal has more steps: pick the logical next action.
- If the action FAILED: suggest a DIFFERENT approach. Never retry the same thing.
- If the goal is COMPLETE (or you need a new plan): set goalComplete to true.
- Keep thoughts entertaining and brief.
${actionLine}

Respond with JSON ONLY:
{"success":true,"thought":"Brief assessment","nextAction":"action_name","nextlityarams":{},"goalComplete":false}

If no clear next step, set nextAction to null and goalComplete to true.
`;
}

/**
 * Chat prompt — respond to player/viewer messages.
 * Used with fast model (8b).
 */
export function buildChatPrompt(name: string, activity: string): string {
  return `You are ${name}, a chaotic AI playing Minecraft on a livestream. A viewer is talking to you. Reply in 1-2 short sentences. Be funny, dramatic, in-character. You name everything, hold grudges, love your items. Currently: ${activity}`;
}
