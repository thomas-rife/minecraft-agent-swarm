import type { Bot } from "mineflayer";
import { operationResult, type OperationResult } from "./types.js";

export type OperationKind = "action" | "skill" | "recovery";

export interface OperationToken {
  id: string;
  kind: OperationKind;
  generation: number;
  signal: AbortSignal;
  startedAt: number;
  deadline: number;
}

interface ActiveOperation extends OperationToken {
  abortController: AbortController;
}

const activeByBot = new Map<Bot, ActiveOperation>();
const generationByBot = new Map<Bot, number>();
let operationSequence = 0;

function nextGeneration(bot: Bot): number {
  const generation = (generationByBot.get(bot) ?? 0) + 1;
  generationByBot.set(bot, generation);
  return generation;
}

function clearControls(bot: Bot): void {
  for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    try {
      bot.setControlState(control, false);
    } catch {
      // Bot may be disconnected.
    }
  }
}

export async function cleanupBotOperation(bot: Bot): Promise<void> {
  try {
    bot.pathfinder.stop();
  } catch {
    // Pathfinder may not be loaded.
  }
  try {
    bot.stopDigging();
  } catch {
    // Bot may not be digging.
  }
  clearControls(bot);
  try {
    const currentWindow = bot.currentWindow;
    if (currentWindow) bot.closeWindow(currentWindow);
  } catch {
    // No open container, or connection already closed.
  }
  await Promise.resolve();
}

export function getActiveOperation(bot: Bot): OperationToken | null {
  return activeByBot.get(bot) ?? null;
}

export function isOperationCurrent(bot: Bot, token: Pick<OperationToken, "generation" | "signal">): boolean {
  return !token.signal.aborted && generationByBot.get(bot) === token.generation;
}

export function assertOperationCurrent(bot: Bot, token: Pick<OperationToken, "generation" | "signal">): void {
  if (!isOperationCurrent(bot, token)) throw new Error("STALE_OPERATION");
}

export async function cancelActiveOperation(bot: Bot): Promise<void> {
  const active = activeByBot.get(bot);
  if (!active) return;
  active.abortController.abort();
  nextGeneration(bot);
  await cleanupBotOperation(bot);
  if (activeByBot.get(bot)?.id === active.id) activeByBot.delete(bot);
}

export async function runControlledOperation(
  bot: Bot,
  kind: OperationKind,
  timeoutMs: number,
  execute: (token: OperationToken) => Promise<OperationResult>,
): Promise<OperationResult> {
  const existing = activeByBot.get(bot);
  if (existing) {
    return operationResult("failed", "OPERATION_ALREADY_ACTIVE", `Already running ${existing.kind} ${existing.id}.`, {
      retryable: true,
      observations: { activeOperationId: existing.id, activeKind: existing.kind },
    });
  }

  const startedAt = Date.now();
  const generation = nextGeneration(bot);
  const abortController = new AbortController();
  const id = `${kind}-${startedAt.toString(36)}-${(++operationSequence).toString(36)}`;
  const active: ActiveOperation = {
    id,
    kind,
    generation,
    signal: abortController.signal,
    abortController,
    startedAt,
    deadline: startedAt + timeoutMs,
  };
  activeByBot.set(bot, active);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<OperationResult>((resolve) => {
    timeout = setTimeout(async () => {
      abortController.abort();
      nextGeneration(bot);
      await cleanupBotOperation(bot);
      resolve(
        operationResult("timed_out", "OPERATION_TIMED_OUT", `${kind} timed out after ${timeoutMs / 1000}s.`, {
          retryable: true,
          observations: { kind, timeoutMs },
        }),
      );
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const result = await Promise.race([execute(active), timeoutPromise]);
    if (result.status !== "timed_out" && !isOperationCurrent(bot, active)) {
      return operationResult("cancelled", "STALE_OPERATION_RESULT_IGNORED", `Ignored late result from ${kind} ${id}.`, {
        retryable: false,
        operationId: id,
        startedAt,
        endedAt: Date.now(),
        observations: { originalCode: result.code, originalStatus: result.status },
      });
    }
    return { ...result, operationId: id, startedAt, endedAt: Date.now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = abortController.signal.aborted || message === "STALE_OPERATION";
    return operationResult(cancelled ? "cancelled" : "failed", cancelled ? "OPERATION_CANCELLED" : "OPERATION_CRASHED", message, {
      retryable: !cancelled,
      operationId: id,
      startedAt,
      endedAt: Date.now(),
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (activeByBot.get(bot)?.id === id) activeByBot.delete(bot);
  }
}
