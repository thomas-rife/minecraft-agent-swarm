import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import type { Bot } from "mineflayer";
import type { EventEmitter } from "node:events";
import { config } from "../config.js";
import { getActiveSkillDiagnostics } from "../skills/executor.js";

type BotRegistration = { name: string; bot: Bot; extra?: () => Record<string, unknown> };

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-");
const registrations = new Map<Bot, BotRegistration>();
const crossedSnapshotThresholds = new Set<number>();
let timer: ReturnType<typeof setInterval> | null = null;

function mapSize(value: unknown): number | null {
  if (value && typeof (value as any).size === "number") return (value as any).size;
  if (value && typeof value === "object") return Object.keys(value as object).length;
  return null;
}

function loadedColumns(bot: Bot): number | null {
  const world = bot.world as any;
  for (const candidate of [
    world?.async?.columns,
    world?.sync?.columns,
    world?.columns,
    world?._columns,
    world?.async?._columns,
  ]) {
    const size = mapSize(candidate);
    if (size !== null) return size;
  }
  return null;
}

function listenerSummary(bot: Bot): Record<string, number> {
  const result: Record<string, number> = {};
  for (const event of bot.eventNames()) {
    const count = (bot as EventEmitter).listenerCount(event);
    if (count > 0) result[String(event)] = count;
  }
  return result;
}

function sample() {
  const memory = process.memoryUsage();
  const heapSpaces = Object.fromEntries(
    v8.getHeapSpaceStatistics().map((space) => [
      space.space_name,
      {
        used: space.space_used_size,
        available: space.space_available_size,
        physical: space.physical_space_size,
      },
    ]),
  );
  const bots = [...registrations.values()].map(({ name, bot, extra }) => ({
    name,
    connected: !!bot.entity,
    entities: Object.keys(bot.entities ?? {}).length,
    loadedColumns: loadedColumns(bot),
    listeners: listenerSummary(bot),
    skill: getActiveSkillDiagnostics(bot),
    ...(extra?.() ?? {}),
  }));
  const entry = {
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    memory,
    heapSpaces,
    bots,
  };

  try {
    const dir = path.resolve("logs", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${SESSION_ID}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn("[MemoryMonitor] Could not persist sample:", error);
  }

  const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  console.log(`[MemoryMonitor] heap=${heapMb}MB rss=${rssMb}MB bots=${bots.length}`);

  if (!config.diagnostics.heapSnapshots) return;
  for (const threshold of config.diagnostics.heapSnapshotThresholdsMb) {
    if (heapMb < threshold || crossedSnapshotThresholds.has(threshold)) continue;
    crossedSnapshotThresholds.add(threshold);
    try {
      const dir = path.resolve("logs", "heap-snapshots");
      fs.mkdirSync(dir, { recursive: true });
      const filename = path.join(dir, `${SESSION_ID}-${threshold}mb.heapsnapshot`);
      v8.writeHeapSnapshot(filename);
      console.warn(`[MemoryMonitor] Heap snapshot written at ${heapMb}MB: ${filename}`);
    } catch (error) {
      console.warn(`[MemoryMonitor] Heap snapshot failed:`, error);
    }
  }
}

export function registerDiagnosticBot(name: string, bot: Bot, extra?: () => Record<string, unknown>): () => void {
  registrations.set(bot, { name, bot, extra });
  return () => registrations.delete(bot);
}

export function startMemoryMonitor(): void {
  if (!config.diagnostics.memoryEnabled || timer) return;
  sample();
  timer = setInterval(sample, Math.max(10_000, config.diagnostics.memoryIntervalMs));
  timer.unref?.();
}
