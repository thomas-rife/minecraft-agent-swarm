import type { Bot } from "mineflayer";
import { failed, succeeded, type OperationResult } from "../operations/types.js";
import { getStaticSkillContract } from "./contracts.js";
import type { Skill, SkillContract, SkillProgress, SkillResult } from "./types.js";

export interface SkillDefinition extends Omit<Skill, "execute" | "contract"> {
  contract?: SkillContract;
  execute(
    bot: Bot,
    params: Record<string, any>,
    signal: AbortSignal,
    onProgress: (progress: SkillProgress) => void,
  ): Promise<SkillResult | OperationResult>;
}

/** Convert legacy implementations once so every registered Skill has a native typed public contract. */
export function defineSkill(definition: SkillDefinition): Skill {
  return {
    ...definition,
    contract: definition.contract ?? getStaticSkillContract(definition.name),
    async execute(bot, params, signal, onProgress): Promise<OperationResult> {
      const result = await definition.execute(bot, params, signal, onProgress);
      if ("status" in result) return result;
      return result.success
        ? succeeded("SKILL_COMPLETED", result.message, { progress: result.stats, worldChanged: true })
        : failed("SKILL_FAILED", result.message, { progress: result.stats, retryable: true });
    },
  };
}
