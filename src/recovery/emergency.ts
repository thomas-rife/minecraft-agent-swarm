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
  private lastPosition?: { x: number; y: number; z: number };
  private stationaryChecks = 0;

  getActive(): EmergencyState | null {
    return this.active;
  }

  observe(bot: Bot): EmergencyState | null {
    const now = Date.now();
    if (consumeNavigationRecoveryRequest(bot)) return this.enter("TRAPPED", now);
    const water = waterState(bot);
    if (!water.dry) return this.enter("WATER_ESCAPE", now);

    const pos = bot.entity.position;
    if (this.lastPosition) {
      const displacement = Math.hypot(pos.x - this.lastPosition.x, pos.y - this.lastPosition.y, pos.z - this.lastPosition.z);
      this.stationaryChecks = displacement < 0.2 ? this.stationaryChecks + 1 : 0;
    }
    this.lastPosition = { x: pos.x, y: pos.y, z: pos.z };
    if (this.stationaryChecks >= 5 && pos.y < 67) return this.enter("TRAPPED", now);

    if (this.active?.kind === "WATER_ESCAPE" && water.dry) return this.active;
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
      if (result.status === "succeeded") this.active = null;
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
      if (result.status === "succeeded") {
        this.stationaryChecks = 0;
        this.active = null;
      }
      return result;
    }

    return null;
  }
}
