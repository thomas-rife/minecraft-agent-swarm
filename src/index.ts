import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";
import { BOT_ROSTER, type BotRoleConfig } from "./bot/role.js";
import { startUnifiedViewer } from "./stream/unified-viewer.js";
import {
  recordDiagnosticEvent,
  startDiagnosticLog,
  stopDiagnosticLog,
} from "./util/diagnostic-log.js";

if (config.bot.dynamicSkillsEnabled) loadDynamicSkills();

const activeStops: (() => void)[] = [];
let shuttingDown = false;

function shutdownAll(signal = "shutdown"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[Main] Shutting down all bots...");
  recordDiagnosticEvent({ type: "shutdown_requested", details: { signal } });
  for (const stop of activeStops) {
    try {
      stop();
    } catch {
      // Continue shutting down the other bots.
    }
  }
  stopDiagnosticLog(signal, 0);
  process.exit(0);
}

process.on("SIGINT", () => shutdownAll("SIGINT"));
process.on("SIGTERM", () => shutdownAll("SIGTERM"));

const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 30_000;
const DUPLICATE_LOGIN_DELAY_MS = 60_000;

process.on("unhandledRejection", (reason) => {
  recordDiagnosticEvent({
    type: "unhandled_rejection",
    severity: "error",
    message: reason instanceof Error ? reason.message : String(reason),
    details: reason,
  });
  console.error("[Main] Unhandled rejection (caught; process kept alive):", reason);
});

process.on("uncaughtException", (error) => {
  recordDiagnosticEvent({
    type: "uncaught_exception",
    severity: "error",
    message: error.message || String(error),
    details: error,
  });
  console.error("[Main] Uncaught exception (non-fatal; process kept alive):", error.message || error);
});

async function startBot(
  roleConfig: BotRoleConfig,
  restartCount: number,
  overlayStarted: { value: boolean },
): Promise<string> {
  recordDiagnosticEvent({
    type: "bot_starting",
    bot: roleConfig.name,
    details: { username: roleConfig.username, role: roleConfig.role, restartCount },
  });

  console.log(`\n=== ${roleConfig.name} (${roleConfig.role}) (restart #${restartCount}) ===`);
  const fastLabel =
    config.ollama.fastModel !== config.ollama.model ? ` (fast decisions: ${config.ollama.fastModel})` : "";
  console.log(`LLM: ${config.ollama.model}${fastLabel} @ ${config.ollama.host}`);
  console.log(`Server: ${config.mc.host}:${config.mc.port} (MC ${config.mc.version})`);
  console.log(`Idle re-plan interval: ${config.bot.idleIntervalMs}ms\n`);

  if (!overlayStarted.value) {
    startOverlay(roleConfig.overlayPort, roleConfig.name);
    overlayStarted.value = true;
  }

  const { bot, queueChat, stop } = await createBot(
    {
      onThought: (thought) => console.log(`[${roleConfig.name}] Thought: ${thought}`),
      onAction: (action, result) => console.log(`[${roleConfig.name}] [${action}] ${result}`),
      onChat: (message) => console.log(`[${roleConfig.name}] Chat: ${message}`),
    },
    roleConfig,
  );

  // A single Twitch connection is enough for the whole team.
  const twitch =
    roleConfig.name === "Milo"
      ? createTwitchChat((message) => {
          queueChat(message);
          addChatMessage(message.username, message.message, (message as any).tier ?? "free");
        })
      : null;

  let lastKickReason = "";

  return new Promise<string>((resolve) => {
    const cleanup = () => {
      stop();
      twitch?.client.disconnect();
    };
    activeStops.push(cleanup);

    const removeCleanup = () => {
      const index = activeStops.indexOf(cleanup);
      if (index !== -1) activeStops.splice(index, 1);
    };

    bot.on("kicked", (reason) => {
      const reasonString = typeof reason === "string" ? reason : JSON.stringify(reason);
      lastKickReason = reasonString;
      recordDiagnosticEvent({
        type: "bot_kicked",
        severity: "warn",
        bot: roleConfig.name,
        message: reasonString,
      });
      console.log(`[${roleConfig.name}] Kicked: ${reasonString}`);
      removeCleanup();
      cleanup();
      resolve(lastKickReason);
    });

    bot.on("end", () => {
      recordDiagnosticEvent({
        type: "bot_connection_ended",
        severity: lastKickReason ? "warn" : "info",
        bot: roleConfig.name,
        details: { lastKickReason },
      });
      console.log(`[${roleConfig.name}] Connection ended.`);
      removeCleanup();
      cleanup();
      resolve(lastKickReason);
    });

    bot.on("error", (error) => {
      recordDiagnosticEvent({
        type: "bot_error",
        severity: "error",
        bot: roleConfig.name,
        message: error.message,
        details: error,
      });
      console.error(`[${roleConfig.name}] Error:`, error);
    });

    console.log(`[Main] ${roleConfig.name} is starting up. Waiting for spawn...`);
  });
}

async function runBotLoop(roleConfig: BotRoleConfig): Promise<void> {
  let restartCount = 0;
  const overlayStarted = { value: false };

  while (restartCount < MAX_RESTARTS) {
    let lastKickReason = "";
    try {
      lastKickReason = await startBot(roleConfig, restartCount, overlayStarted);
    } catch (error) {
      recordDiagnosticEvent({
        type: "bot_crash",
        severity: "error",
        bot: roleConfig.name,
        message: error instanceof Error ? error.message : String(error),
        details: error,
      });
      console.error(`[${roleConfig.name}] Bot crashed:`, error);
    }

    restartCount++;
    if (restartCount >= MAX_RESTARTS) {
      recordDiagnosticEvent({
        type: "max_restarts_reached",
        severity: "error",
        bot: roleConfig.name,
        details: { restartCount, maxRestarts: MAX_RESTARTS },
      });
      console.error(`[${roleConfig.name}] Max restarts (${MAX_RESTARTS}) reached. Giving up.`);
      return;
    }

    const delay =
      lastKickReason.includes("duplicate_login") || lastKickReason.includes("You logged in from another location")
        ? DUPLICATE_LOGIN_DELAY_MS
        : RESTART_DELAY_MS;
    recordDiagnosticEvent({
      type: "bot_restart_scheduled",
      severity: "warn",
      bot: roleConfig.name,
      details: { restartCount, delayMs: delay, lastKickReason },
    });
    console.log(`[${roleConfig.name}] Restarting in ${delay / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function main(): Promise<void> {
  const diagnosticPath = startDiagnosticLog({
    bots: BOT_ROSTER.map(({ name, username, role }) => ({ name, username, role })),
    minecraft: { host: config.mc.host, port: config.mc.port, version: config.mc.version },
    models: { strategic: config.ollama.model, fast: config.ollama.fastModel },
    multiBot: config.multiBot,
  });
  if (diagnosticPath) console.log(`[Main] Compact diagnostics: ${diagnosticPath}`);

  await startUnifiedViewer().catch((error) => {
    recordDiagnosticEvent({
      type: "viewer_start_failed",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      details: error,
    });
    console.warn("[Main] Unified viewer failed to start:", error);
  });

  if (!config.multiBot.enabled) {
    await runBotLoop(BOT_ROSTER[0]);
    return;
  }

  const count = Math.min(config.multiBot.count, BOT_ROSTER.length);
  console.log(`[Main] Multi-bot mode: launching ${count} bots...`);

  const loops: Promise<void>[] = [];
  for (let index = 0; index < count; index++) {
    const role = BOT_ROSTER[index];
    console.log(`[Main] Starting ${role.name} (${role.role})...`);
    loops.push(runBotLoop(role));
    if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  try {
    const { startDashboard } = await import("./stream/dashboard.js");
    startDashboard(BOT_ROSTER.slice(0, count));
  } catch (error) {
    recordDiagnosticEvent({
      type: "dashboard_start_failed",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      details: error,
    });
    console.log("[Main] Dashboard module not available; skipping.");
  }

  await Promise.all(loops);
  stopDiagnosticLog("all_bot_loops_finished", 0);
}

main().catch((error) => {
  recordDiagnosticEvent({
    type: "fatal_error",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    details: error,
  });
  stopDiagnosticLog("fatal_error", 1);
  console.error("[Main] Fatal error:", error);
  process.exit(1);
});
