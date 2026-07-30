import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { waterState } from "../verification/world-verifiers.js";
import { inventoryCount } from "../verification/inventory-verifiers.js";
import { getSharedStructure } from "../world/registry.js";
import type { AgentGoal, GoalPredicate } from "./types.js";
import type { OperationResult } from "../operations/types.js";
import { getTask } from "../coordination/task-board.js";

function predicateSatisfied(bot: Bot, predicate: GoalPredicate): boolean {
  switch (predicate.kind) {
    case "not_in_water":
      return waterState(bot).dry;
    case "at_position":
      return (
        bot.entity.position.distanceTo(
          new Vec3(predicate.position.x, predicate.position.y, predicate.position.z),
        ) <= predicate.tolerance
      );
    case "inventory_at_least":
      return inventoryCount(bot, predicate.item) >= predicate.count;
    case "structure_verified":
      return getSharedStructure(predicate.structureId)?.status === "verified";
    case "task_completed":
      return getTask(predicate.taskId)?.status === "completed";
    case "operation_succeeded":
      return false;
  }
}

export class GoalManager {
  private active: AgentGoal | null = null;
  private history: AgentGoal[] = [];
  private sequence = 0;

  getActive(): AgentGoal | null {
    return this.active;
  }

  setGoal(
    goal: Omit<AgentGoal, "id" | "status" | "createdAt" | "updatedAt">,
  ): AgentGoal {
    if (this.active) this.finish("cancelled");
    const now = Date.now();
    this.active = {
      ...goal,
      id: `goal-${now.toString(36)}-${(++this.sequence).toString(36)}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.active;
  }

  evaluate(bot: Bot): AgentGoal | null {
    if (!this.active) return null;
    if (predicateSatisfied(bot, this.active.completion)) return this.finish("completed");
    if (this.active.failure && predicateSatisfied(bot, this.active.failure)) return this.finish("failed");
    return null;
  }

  evaluateOperation(bot: Bot, result: OperationResult): AgentGoal | null {
    if (!this.active) return null;
    if (this.active.completion.kind === "operation_succeeded") {
      const expected = this.active.completion.expectedCode;
      if (result.status === "succeeded" && (!expected || expected === result.code)) return this.finish("completed");
    }
    return this.evaluate(bot);
  }

  finish(status: Exclude<AgentGoal["status"], "active">): AgentGoal | null {
    if (!this.active) return null;
    const finished = { ...this.active, status, updatedAt: Date.now() };
    this.history.push(finished);
    this.active = null;
    return finished;
  }

  getHistory(): AgentGoal[] {
    return [...this.history];
  }
}
