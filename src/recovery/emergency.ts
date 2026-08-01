import type { Bot } from "mineflayer";
import { cancelActiveOperation, runControlledOperation } from "../operations/controller.js";
import { failed, succeeded, type OperationResult } from "../operations/types.js";
import { consumeNavigationRecoveryRequest, escapeWaterIfDrowning, recoverToSafePoint } from "../bot/navigation.js";
import { verifyDryStable, waterState } from "../verification/world-verifiers.js";

export type EmergencyKind = "WATER_ESCAPE" | "TRAPPED" | "COMBAT_ESCAPE" | "STARVATION";

export interface EmergencyState {
  kind: EmergencyKind;
  enteredAt: number;
  lastObservedAt: number;
  attempts: number;
}

export class EmergencyManager {
  private active: EmergencyState | null = null;
  private trapRetryAfter = 0;
  private waterRetryAfter = 0;

  // A failed recovery should not become a tight cancellation loop. A later
  // navigation failure can request another attempt after this backoff.
  private static readonly TRAP_RETRY_BACKOFF_MS = 30_000;
  private static readonly MAX_WATER_ATTEMPTS = 5;
  private static readonly WATER_EXHAUSTED_BACKOFF_MS = 30_000;

  getActive(): EmergencyState | null {
    return this.active;
  }

  observe(bot: Bot): EmergencyState | null {
    const now = Date.now();
    const water = waterState(bot);
    // Feet-only water is ordinary swimming/wading. Drowning recovery must
    // match escapeWaterIfDrowning(), which acts only on head submersion.
    if (water.headInWater && now >= this.waterRetryAfter) return this.enter("WATER_ESCAPE", now);

    if (this.active?.kind === "WATER_ESCAPE" && !water.headInWater) {
      this.active = null;
      return null;
    }

    // Standing still is normal while idle, planning, crafting, or waiting for
    // another bot. Only navigation's own progress detector has enough context
    // to decide that a movement attempt is actually stuck.
    const navigationRecovery = consumeNavigationRecoveryRequest(bot);
    if (navigationRecovery && now >= this.trapRetryAfter) {
      return this.enter("TRAPPED", now);
    }

    return this.active;
  }

  private enter(kind: EmergencyKind, now: number): EmergencyState {
    if (this.active?.kind === kind) {
      this.active.lastObservedAt = now;
      return this.active;
    }
    this.active = { kind, enteredAt: now, lastObservedAt: now, attempts: 0 };
    return this.active;
  }

  async resolve(bot: Bot): Promise<OperationResult | null> {
    if (!this.active) return null;
    const emergency = this.active;
    emergency.attempts++;
    await cancelActiveOperation(bot);

    if (emergency.kind === "WATER_ESCAPE") {
      const result = await runControlledOperation(bot, "recovery", 20_000, async () => {
        await escapeWaterIfDrowning(bot);
        const dry = await verifyDryStable(bot);
        return dry.satisfied
          ? succeeded("WATER_ESCAPE_RESOLVED", "Reached stable dry ground.", {
              postconditions: [dry],
              observations: waterState(bot),
            })
          : failed("WATER_CONDITION_PERSISTS", "Water escape did not reach stable dry ground.", {
              retryable: true,
              postconditions: [dry],
              observations: waterState(bot),
            });
      });
      if (result.status === "succeeded") {
        this.active = null;
        this.waterRetryAfter = 0;
      } else if (emergency.attempts >= EmergencyManager.MAX_WATER_ATTEMPTS) {
        this.active = null;
        this.waterRetryAfter = Date.now() + EmergencyManager.WATER_EXHAUSTED_BACKOFF_MS;
      }
      return result;
    }

    if (emergency.kind === "TRAPPED") {
      const result = await runControlledOperation(bot, "recovery", 35_000, async () => {
        const attempted = await recoverToSafePoint(bot);
        return attempted
          ? succeeded("TRAPPED_RECOVERY_ATTEMPTED", "Completed deterministic trapped recovery.", {
              observations: { position: bot.entity.position.clone() },
            })
          : failed("TRAPPED_GEOMETRY_UNRESOLVED", "No supported trapped geometry was detected.", {
              retryable: true,
            });
      });
      // Recovery navigation can itself emit a recovery request. Consume that
      // internal request, clear this emergency after one bounded attempt, and
      // allow normal planning to resume instead of cancelling every 3 seconds.
      consumeNavigationRecoveryRequest(bot);
      this.active = null;
      this.trapRetryAfter = Date.now() + EmergencyManager.TRAP_RETRY_BACKOFF_MS;
      return result;
    }

    return null;
  }
}
