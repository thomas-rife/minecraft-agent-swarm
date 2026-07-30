import type { Skill } from "./types.js";
import { buildHouseSkill } from "./build-house.js";
import { craftGearSkill } from "./craft-gear.js";
import { lightAreaSkill } from "./light-area.js";
import { buildFarmSkill } from "./build-farm.js";
import { stripMineSkill } from "./strip-mine.js";
import { smeltOresSkill } from "./smelt-ores.js";
import { goFishingSkill } from "./go-fishing.js";
import { buildBridgeSkill } from "./build-bridge.js";
import { setupStashSkill } from "./setup-stash.js";

export const skillRegistry = new Map<string, Skill>();

function register(skill: Skill) {
  skillRegistry.set(skill.name, skill);
}

register(buildHouseSkill);
register(craftGearSkill);
register(lightAreaSkill);
register(buildFarmSkill);
register(stripMineSkill);
register(smeltOresSkill);
register(goFishingSkill);
register(buildBridgeSkill);
register(setupStashSkill);

// Dynamic skills are loaded lazily by calling loadDynamicSkills() from dynamic-loader.ts.
// The import is intentionally kept out of this file to avoid circular module evaluation:
// dynamic-loader.ts imports skillRegistry from this file, so registry.ts must not
// import dynamic-loader.ts at module load time (TDZ / circular ref issue with tsx/Node ESM).

/** Generate the SKILLS section for the LLM system prompt. */
export function getSkillPromptLines(allowedNames?: readonly string[]): string {
  const lines: string[] = [];
  for (const skill of skillRegistry.values()) {
    if (allowedNames && !allowedNames.includes(skill.name)) continue;
    const paramStr =
      Object.keys(skill.params).length > 0
        ? `params: { ${Object.entries(skill.params)
            .map(([k, v]) => `${k}: ${v.type}${v.source === "system" ? " (system-injected)" : ""}`)
            .join(", ")} }`
        : "params: {}";
    const contract = skill.contract;
    lines.push(
      [
        `SKILL: ${skill.name}`,
        `PURPOSE: ${contract?.purpose ?? skill.description}`,
        `USE WHEN: ${contract?.useWhen ?? "The described outcome is needed."}`,
        `DO NOT USE WHEN: ${contract?.doNotUseWhen ?? "Its preconditions are not satisfied."}`,
        `PARAMETERS: ${paramStr}`,
        `PRECONDITIONS: ${contract?.requiredStatus?.join("; ") ?? "validated at execution time"}`,
        `SUCCESS: ${contract?.successCriteria?.join("; ") ?? "all observed postconditions pass"}`,
        `FAILURES: ${contract?.knownFailureCodes?.join(", ") ?? "SKILL_PRECONDITION_FAILED, SKILL_POSTCONDITION_FAILED"}`,
        `PROGRESS: ${contract?.progressPolicy ?? "machine-readable phase and completion fields"}`,
        `RECOVERY: ${contract?.recoveryPolicy ?? "cancel, clean up, and replan from fresh state"}`,
      ].join("\n"),
    );
  }
  return lines.join("\n\n");
}
