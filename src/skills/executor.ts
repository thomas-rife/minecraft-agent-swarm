import type { Bot } from "mineflayer";
import type { Skill, SkillProgress } from "./types.js";
import { gatherMaterials } from "./materials.js";
import { updateOverlay } from "../stream/overlay.js";
import { recordSkillAttempt } from "../bot/memory.js";
import { getBotMemoryStore, registerBotMemory } from "../bot/memory-registry.js";
import { cancelActiveOperation, runControlledOperation } from "../operations/controller.js";
import { failed, operationResult, succeeded, type OperationResult } from "../operations/types.js";
import { getSharedStructure } from "../world/registry.js";

export { registerBotMemory };

type ActiveSkillState = {
  skill: Skill;
  startTime: number;
};

const activeSkillMap = new Map<Bot, ActiveSkillState>();

// setup_stash mutates one canonical shared resource. Serialize it across bots;
// role-specific activeSkillMap entries alone do not prevent a three-bot race.
let setupStashTail: Promise<void> = Promise.resolve();

export function isSkillRunning(bot: Bot): boolean {
  return activeSkillMap.has(bot);
}

export function getActiveSkillName(bot: Bot): string | null {
  return activeSkillMap.get(bot)?.skill.name ?? null;
}

export function abortActiveSkill(bot: Bot): void {
  const active = activeSkillMap.get(bot);
  if (active) {
    console.log(`[Skill] Aborting skill "${active.skill.name}"`);
    void cancelActiveOperation(bot);
  }
}

/** Run a deterministic skill under the bot's single cancellable operation controller. */
export async function runSkill(bot: Bot, skill: Skill, params: Record<string, any>): Promise<OperationResult> {
  if (skill.name !== "setup_stash") return runSkillUnlocked(bot, skill, params);

  const previous = setupStashTail;
  let release!: () => void;
  setupStashTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const verified = getSharedStructure("shared-stash");
    if (verified?.status === "verified") {
      return succeeded("SKILL_ALREADY_SATISFIED", "Shared stash is already verified; skipped duplicate setup.", {
        worldChanged: false,
        postconditions: [
          { name: "canonical_stash_openable", satisfied: true, evidence: verified.evidence ?? verified },
        ],
      });
    }
    return await runSkillUnlocked(bot, skill, params);
  } finally {
    release();
  }
}

async function runSkillUnlocked(bot: Bot, skill: Skill, params: Record<string, any>): Promise<OperationResult> {
  const active = activeSkillMap.get(bot);
  if (active) {
    return failed("SKILL_ALREADY_ACTIVE", `Already running skill "${active.skill.name}".`, {
      retryable: true,
      observations: { activeSkill: active.skill.name },
    });
  }

  const startTime = Date.now();
  activeSkillMap.set(bot, { skill, startTime });
  console.log(`[Skill] Starting "${skill.name}"`);

  const progress = (value: SkillProgress) => {
    updateOverlay({ skillProgress: value });
    if (value.message) {
      console.log(`[Skill] ${skill.name}: ${value.phase} - ${value.message} (${Math.round(value.progress * 100)}%)`);
    }
  };

  const quips = [
    "Still working on it... this better be worth it.",
    "Going great. Totally under control.",
    "Almost there... maybe.",
    "Chat, if this works, you owe me a follow.",
  ];
  const chatterInterval = setInterval(() => {
    if (activeSkillMap.has(bot)) bot.chat(quips[Math.floor(Math.random() * quips.length)]);
  }, 30_000);

  try {
    const result = await runControlledOperation(bot, "skill", skill.contract?.timeoutMs ?? 240_000, async (token) => {
      const baseline = skill.contract?.capture?.(bot, params);
      progress({
        skillName: skill.name,
        phase: "Checking preconditions",
        progress: 0,
        message: "Validating world state...",
        active: true,
      });

      const parameterChecks: import("../operations/types.js").PostconditionResult[] = Object.entries(skill.params).map(
        ([name, schema]) => {
          const value = params[name];
          const present = value !== undefined && value !== null && value !== "";
          const typeValid = !present || schema.type === "any" || typeof value === schema.type;
          return {
            name: `parameter:${name}`,
            satisfied: (schema.required === false || present) && typeValid,
            evidence: {
              expectedType: schema.type,
              required: schema.required !== false,
              source: schema.source ?? "llm",
              present,
            },
          };
        },
      );
      parameterChecks.push(...(skill.contract?.validate?.(params) ?? []));
      const invalidParameters = parameterChecks.filter((check) => !check.satisfied);
      if (invalidParameters.length > 0) {
        return failed("SKILL_INVALID_PARAMETERS", `Cannot start ${skill.name}: parameters are invalid.`, {
          retryable: false,
          postconditions: parameterChecks,
          observations: { invalidParameters: invalidParameters.map((check) => check.name) },
        });
      }

      const preconditions = (await skill.contract?.preconditions?.(bot, params)) ?? [];
      const unsatisfied = preconditions.filter((condition) => !condition.satisfied);
      if (unsatisfied.length > 0) {
        return failed("SKILL_PRECONDITION_FAILED", `Cannot start ${skill.name}: preconditions are not satisfied.`, {
          retryable: skill.contract?.retryable ?? true,
          postconditions: preconditions,
          observations: { failedPreconditions: unsatisfied.map((condition) => condition.name) },
        });
      }

      const materialsNeeded = skill.estimateMaterials(bot, params);
      const materialsList = Object.entries(materialsNeeded);
      if (materialsList.length > 0) {
        console.log(
          `[Skill] Materials needed: ${materialsList.map(([name, count]) => `${count}x ${name}`).join(", ")}`,
        );
        const gathered = await gatherMaterials(bot, materialsNeeded, token.signal, (message, percent) => {
          progress({
            skillName: skill.name,
            phase: "Gathering materials",
            progress: percent * 0.3,
            message,
            active: true,
          });
        });
        if (!gathered.success) {
          return failed("MATERIAL_GATHER_FAILED", gathered.message, {
            retryable: true,
            observations: { materialsNeeded },
          });
        }
      }

      if (token.signal.aborted) {
        return operationResult("cancelled", "SKILL_CANCELLED", `Skill ${skill.name} was interrupted.`);
      }

      const normalized = await skill.execute(bot, params, token.signal, (next) => {
        progress({ ...next, progress: 0.3 + next.progress * 0.7 });
      });

      const contractPostconditions = (await skill.contract?.postconditions?.(bot, params, baseline)) ?? [];
      const postconditions = [...normalized.postconditions, ...contractPostconditions];
      if (postconditions.some((condition) => !condition.satisfied)) {
        return operationResult("partial", "SKILL_POSTCONDITION_FAILED", normalized.message, {
          retryable: skill.contract?.retryable ?? true,
          worldChanged: normalized.worldChanged,
          observations: normalized.observations,
          progress: normalized.progress,
          postconditions,
        });
      }
      return { ...normalized, postconditions };
    });

    const durationSeconds = (Date.now() - startTime) / 1000;
    const success = result.status === "succeeded";
    const memory = getBotMemoryStore(bot);
    if (memory) memory.recordSkillAttempt(skill.name, success, durationSeconds, result.message);
    else recordSkillAttempt(skill.name, success, durationSeconds, result.message);

    progress({
      skillName: skill.name,
      phase: success ? "Complete!" : result.status,
      progress: success ? 1 : 0,
      message: result.message,
      active: false,
    });
    console.log(
      `[Skill] "${skill.name}" finished [${result.code}] operation=${result.operationId ?? "unknown"} started=${result.startedAt ?? startTime} ended=${result.endedAt ?? Date.now()}: ${result.message} postconditions=${JSON.stringify(result.postconditions)}`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationSeconds = (Date.now() - startTime) / 1000;
    const memory = getBotMemoryStore(bot);
    if (memory) memory.recordSkillAttempt(skill.name, false, durationSeconds, `Crashed: ${message}`);
    else recordSkillAttempt(skill.name, false, durationSeconds, `Crashed: ${message}`);
    progress({ skillName: skill.name, phase: "Crashed", progress: 0, message, active: false });
    return failed("SKILL_EXECUTOR_CRASHED", `Skill ${skill.name} crashed: ${message}`, { retryable: true });
  } finally {
    clearInterval(chatterInterval);
    activeSkillMap.delete(bot);
  }
}
