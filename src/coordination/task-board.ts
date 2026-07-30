import type { OperationResult } from "../operations/types.js";
import { defaultStateFile, loadJsonFile, saveJsonFile } from "../persistence/json-store.js";

export type TaskStatus = "open" | "claimed" | "in_progress" | "blocked" | "completed" | "failed";

export interface SwarmTask {
  id: string;
  capability: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  leaseUntil?: number;
  createdAt: number;
  updatedAt: number;
  progress?: Record<string, number | string | boolean>;
  resultCode?: string;
  prerequisites: string[];
  requestedResources?: Record<string, number>;
  evidence?: Record<string, unknown>;
  blockedReason?: string;
}

const tasks = new Map<string, SwarmTask>();
let persistenceFile: string | null = null;

export function configureTaskBoardPersistence(file = defaultStateFile("task-board.json")): void {
  if (persistenceFile) return;
  persistenceFile = file;
  const stored = loadJsonFile<SwarmTask[]>(file, []);
  restoreTaskBoard(stored);
}

export function restoreTaskBoard(stored: SwarmTask[], now = Date.now()): void {
  tasks.clear();
  for (const saved of stored.slice(-200)) {
    const task = { ...saved, prerequisites: saved.prerequisites ?? [] };
    if (!["completed", "failed"].includes(task.status) && (task.leaseUntil ?? 0) <= now) {
      task.status = "open";
      task.owner = undefined;
      task.leaseUntil = undefined;
    }
    tasks.set(task.id, task);
  }
}

function expireStaleClaims(now = Date.now()): void {
  for (const task of tasks.values()) {
    if (["claimed", "in_progress"].includes(task.status) && (task.leaseUntil ?? 0) <= now) {
      task.status = "open";
      task.owner = undefined;
      task.leaseUntil = undefined;
      task.updatedAt = now;
    }
  }
}

function persistTasks(): void {
  if (persistenceFile) saveJsonFile(persistenceFile, [...tasks.values()].slice(-200));
}

export function publishTask(task: Omit<SwarmTask, "status" | "createdAt" | "updatedAt" | "prerequisites"> & { prerequisites?: string[] }): SwarmTask {
  const now = Date.now();
  const published: SwarmTask = { ...task, prerequisites: task.prerequisites ?? [], status: "open", createdAt: now, updatedAt: now };
  tasks.set(task.id, published);
  persistTasks();
  return published;
}

export function claimTask(id: string, owner: string, leaseMs = 120_000): boolean {
  expireStaleClaims();
  const task = tasks.get(id);
  if (!task) return false;
  if (task.prerequisites.some((dependency) => tasks.get(dependency)?.status !== "completed")) return false;
  const now = Date.now();
  if (task.owner && task.owner !== owner && (task.leaseUntil ?? 0) > now) return false;
  Object.assign(task, { owner, leaseUntil: now + leaseMs, status: "claimed" as const, updatedAt: now });
  persistTasks();
  return true;
}

export function startTask(id: string, owner: string, progress: SwarmTask["progress"] = {}): boolean {
  const task = tasks.get(id);
  if (!task || task.owner !== owner || (task.leaseUntil ?? 0) <= Date.now()) return false;
  task.status = "in_progress";
  task.progress = progress;
  task.updatedAt = Date.now();
  persistTasks();
  return true;
}

export function blockTask(id: string, owner: string, reason: string, prerequisites: string[] = []): boolean {
  const task = tasks.get(id);
  if (!task || task.owner !== owner) return false;
  task.status = "blocked";
  task.blockedReason = reason;
  task.prerequisites = [...new Set([...task.prerequisites, ...prerequisites])];
  task.owner = undefined;
  task.leaseUntil = undefined;
  task.updatedAt = Date.now();
  persistTasks();
  return true;
}

export function recordTaskResult(id: string, result: OperationResult): SwarmTask | undefined {
  const task = tasks.get(id);
  if (!task) return undefined;
  task.status = result.status === "succeeded" ? "completed" : result.retryable ? "open" : "failed";
  task.progress = result.progress;
  task.resultCode = result.code;
  task.evidence = { observations: result.observations, postconditions: result.postconditions };
  task.updatedAt = Date.now();
  if (task.status === "open") {
    task.owner = undefined;
    task.leaseUntil = undefined;
  }
  persistTasks();
  return task;
}

export function getTask(id: string): SwarmTask | undefined {
  return tasks.get(id);
}

export function formatTaskBoard(): string {
  expireStaleClaims();
  const active = [...tasks.values()].filter((task) => task.status !== "completed");
  if (active.length === 0) return "TASK BOARD: No open tasks.";
  return `TASK BOARD:\n${active
    .map((task) => `- ${task.id}: ${task.status} ${task.capability}; owner=${task.owner ?? "unclaimed"}; dependencies=${task.prerequisites.join(",") || "none"}; ${task.blockedReason ? `blocked=${task.blockedReason}; ` : ""}${task.description}`)
    .join("\n")}`;
}

export function resetTaskBoard(): void {
  tasks.clear();
  persistTasks();
}
