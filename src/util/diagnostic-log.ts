/**
 * Compact long-run diagnostics.
 *
 * Routine outcomes are counted in five-minute summaries. Failures, crashes,
 * deaths, restarts, and recoveries are written immediately. Repeated identical
 * events are deduplicated, and files rotate before they can grow without bound.
 */

import fs from "node:fs";
import path from "node:path";
import type { OperationResult } from "../operations/types.js";

export type DiagnosticSeverity = "info" | "warn" | "error";

export interface DiagnosticEvent {
  type: string;
  severity?: DiagnosticSeverity;
  bot?: string;
  code?: string;
  message?: string;
  details?: unknown;
}

export interface DiagnosticOptions {
  directory?: string;
  summaryIntervalMs?: number;
  maxBytes?: number;
  retainedFiles?: number;
  dedupeWindowMs?: number;
  enabled?: boolean;
}

interface RecentOperation {
  at: string;
  bot: string;
  action: string;
  status: OperationResult["status"];
  code: string;
  durationMs?: number;
}

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-");
const DEFAULT_SUMMARY_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;
const DEFAULT_DEDUPE_MS = 60_000;
const MAX_RECENT_OPERATIONS = 24;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}...` : value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: clean(value.message),
      stack: clean(value.stack ?? ""),
    };
  }
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => clean(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      output[key] = clean(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export class CompactDiagnosticLog {
  private readonly directory: string;
  private readonly summaryIntervalMs: number;
  private readonly maxBytes: number;
  private readonly retainedFiles: number;
  private readonly dedupeWindowMs: number;
  private readonly enabled: boolean;
  private readonly filePath: string;
  private readonly counters = new Map<string, number>();
  private readonly recent: RecentOperation[] = [];
  private readonly dedupe = new Map<string, { lastWrittenAt: number; suppressed: number }>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private bytesWritten = 0;

  constructor(options: DiagnosticOptions = {}) {
    this.directory = options.directory ?? process.env.DIAGNOSTIC_LOG_DIR ?? path.resolve("logs", "diagnostics");
    this.summaryIntervalMs =
      options.summaryIntervalMs ??
      positiveNumber(process.env.DIAGNOSTIC_SUMMARY_MINUTES, DEFAULT_SUMMARY_MS / 60_000) * 60_000;
    this.maxBytes =
      options.maxBytes ?? positiveNumber(process.env.DIAGNOSTIC_MAX_MB, DEFAULT_MAX_BYTES / 1024 / 1024) * 1024 * 1024;
    this.retainedFiles = options.retainedFiles ?? DEFAULT_RETAINED_FILES;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;
    this.enabled = options.enabled ?? process.env.DIAGNOSTIC_LOG_ENABLED !== "false";
    this.filePath = path.join(this.directory, `swarm-${SESSION_ID}.jsonl`);
  }

  start(metadata: Record<string, unknown> = {}): string | null {
    if (!this.enabled || this.stopped) return null;
    if (!this.started) {
      fs.mkdirSync(this.directory, { recursive: true });
      this.started = true;
      this.timer = setInterval(() => this.flushSummary("periodic"), this.summaryIntervalMs);
      this.timer.unref?.();
      this.append({
        at: new Date().toISOString(),
        type: "session_start",
        severity: "info",
        sessionId: SESSION_ID,
        pid: process.pid,
        node: process.version,
        metadata: clean(metadata),
      });
    } else if (Object.keys(metadata).length > 0) {
      this.recordEvent({ type: "session_configuration", details: metadata });
    }
    return this.filePath;
  }

  recordEvent(event: DiagnosticEvent): void {
    if (!this.enabled || this.stopped) return;
    if (!this.started) this.start();

    const severity = event.severity ?? "info";
    const key = [event.type, severity, event.bot ?? "", event.code ?? "", event.message ?? ""].join("|");
    const now = Date.now();
    const prior = this.dedupe.get(key);
    if (prior && now - prior.lastWrittenAt < this.dedupeWindowMs) {
      prior.suppressed++;
      return;
    }

    const repeated = prior?.suppressed ?? 0;
    this.dedupe.set(key, { lastWrittenAt: now, suppressed: 0 });
    this.append({
      at: new Date(now).toISOString(),
      type: event.type,
      severity,
      ...(event.bot ? { bot: event.bot } : {}),
      ...(event.code ? { code: event.code } : {}),
      ...(event.message ? { message: clean(event.message) } : {}),
      ...(event.details !== undefined ? { details: clean(event.details) } : {}),
      ...(repeated > 0 ? { repeatedSinceLastWrite: repeated } : {}),
      ...(severity === "error" ? { recentOperations: this.recent.slice(-12) } : {}),
    });
  }

  recordOperation(bot: string, action: string, result: OperationResult, immediateSuccess = false): void {
    if (!this.enabled || this.stopped) return;
    if (!this.started) this.start();

    const key = [bot, action, result.status, result.code].join("|");
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    const durationMs =
      result.startedAt !== undefined && result.endedAt !== undefined
        ? Math.max(0, result.endedAt - result.startedAt)
        : undefined;
    this.recent.push({
      at: new Date().toISOString(),
      bot,
      action,
      status: result.status,
      code: result.code,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    if (this.recent.length > MAX_RECENT_OPERATIONS) this.recent.shift();

    if (result.status !== "succeeded" || immediateSuccess) {
      const failedPostconditions = result.postconditions
        .filter((condition) => !condition.satisfied)
        .map((condition) => ({ name: condition.name, evidence: clean(condition.evidence) }));
      this.recordEvent({
        type: immediateSuccess && result.status === "succeeded" ? "recovery_succeeded" : "operation_outcome",
        severity: result.status === "failed" || result.status === "timed_out" ? "warn" : "info",
        bot,
        code: result.code,
        message: result.message,
        details: {
          action,
          status: result.status,
          retryable: result.retryable,
          worldChanged: result.worldChanged,
          durationMs,
          failedPostconditions,
          progress: clean(result.progress),
        },
      });
    }
  }

  flushSummary(reason: string): void {
    if (!this.enabled || !this.started || this.stopped) return;
    const outcomes = [...this.counters.entries()].map(([key, count]) => {
      const [bot, action, status, code] = key.split("|");
      return { bot, action, status, code, count };
    });
    const suppressedEvents = [...this.dedupe.entries()]
      .filter(([, state]) => state.suppressed > 0)
      .map(([key, state]) => ({ key: clean(key), count: state.suppressed }));
    if (outcomes.length === 0 && suppressedEvents.length === 0 && reason === "periodic") return;

    this.append({
      at: new Date().toISOString(),
      type: "summary",
      severity: "info",
      reason,
      outcomes,
      suppressedEvents,
      recentOperations: this.recent.slice(-6),
    });
    this.counters.clear();
    for (const state of this.dedupe.values()) state.suppressed = 0;
  }

  stop(reason: string, exitCode = 0): void {
    if (!this.enabled || this.stopped) return;
    if (!this.started) this.start();
    this.flushSummary("shutdown");
    this.append({
      at: new Date().toISOString(),
      type: "session_end",
      severity: exitCode === 0 ? "info" : "error",
      reason: clean(reason),
      exitCode,
    });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  getFilePath(): string | null {
    return this.enabled ? this.filePath : null;
  }

  private append(payload: Record<string, unknown>): void {
    try {
      const line = `${JSON.stringify(payload)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (this.bytesWritten + lineBytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.filePath, line, "utf8");
      this.bytesWritten += lineBytes;
    } catch {
      // Diagnostics must never crash or stall the swarm.
    }
  }

  private rotate(): void {
    try {
      for (let index = this.retainedFiles - 1; index >= 1; index--) {
        const source = `${this.filePath}.${index}`;
        const target = `${this.filePath}.${index + 1}`;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(source)) fs.renameSync(source, target);
      }
      if (fs.existsSync(`${this.filePath}.1`)) fs.unlinkSync(`${this.filePath}.1`);
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
      this.bytesWritten = 0;
    } catch {
      this.bytesWritten = 0;
    }
  }
}

const diagnosticLog = new CompactDiagnosticLog();

export function startDiagnosticLog(metadata: Record<string, unknown> = {}): string | null {
  return diagnosticLog.start(metadata);
}

export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  diagnosticLog.recordEvent(event);
}

export function recordDiagnosticOperation(
  bot: string,
  action: string,
  result: OperationResult,
  immediateSuccess = false,
): void {
  diagnosticLog.recordOperation(bot, action, result, immediateSuccess);
}

export function flushDiagnosticSummary(reason: string): void {
  diagnosticLog.flushSummary(reason);
}

export function stopDiagnosticLog(reason: string, exitCode = 0): void {
  diagnosticLog.stop(reason, exitCode);
}

export function getDiagnosticLogPath(): string | null {
  return diagnosticLog.getFilePath();
}
