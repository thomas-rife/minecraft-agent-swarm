export type GoalStatus = "active" | "blocked" | "completed" | "failed" | "cancelled";
export type GoalType = "strategic" | "task" | "emergency";

export type GoalPredicate =
  | { kind: "not_in_water" }
  | { kind: "at_position"; position: { x: number; y: number; z: number }; tolerance: number }
  | { kind: "inventory_at_least"; item: string; count: number }
  | { kind: "structure_verified"; structureId: string }
  | { kind: "task_completed"; taskId: string }
  | { kind: "operation_succeeded"; expectedCode?: string };

export interface AgentGoal {
  id: string;
  type: GoalType;
  description: string;
  status: GoalStatus;
  completion: GoalPredicate;
  failure?: GoalPredicate;
  createdAt: number;
  updatedAt: number;
  source: "llm" | "system" | "player";
}
