import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";
import { BOT_ROSTER, SOLO_CONFIG, BotRoleConfig } from "./bot/role.js";
import { startUnifiedViewer } from "./stream/unified-viewer.js";
import { startMemoryMonitor } from "./diagnostics/memory-monitor.js";

loadDynamicSkills();

// Registry of active bot stop functions for clean multi-bot shutdown
const activeStops: (() => void)[] = [];

function shutdownAll() {
  console.log("\n[Main] Shutting down all bots...");
  for (const fn of activeStops) {
    try {
      fn();
    } catch {
      /* ignore errors during shutdown */
    }
  }
  process.exit(0);
}
// Register once — never overwritten
process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);

const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 30000;
const DUPLICATE_LOGIN_DELAY_MS = 60000;

// Catch unhandled promise rejections (e.g. from Twitch client, WebSocket, TCP) so they
// don't crash the entire process — log and let the main restart loop handle recovery.
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection (caught — process kept alive):", reason);
});

// Prevent TTS/WebSocket internal errors from crashing the entire process.
// msedge-tts can throw synchronous exceptions from WebSocket event handlers
// (e.g. "_streams[requestId] is undefined") that bypass promise rejection handling.
process.on("uncaughtException", (err) => {
  console.error("[Main] Uncaught exception (non-fatal — process kept alive):", err.message || err);
});

async function startBot(
  roleConfig: BotRoleConfig,
  restartCount: number,
  overlayStarted: { value: boolean },
): Promise<string> {
  console.log(`\n=== ${roleConfig.name} (${roleConfig.role}) (restart #${restartCount}) ===`);
  const fastLabel =
    config.ollama.fastModel !== config.ollama.model ? ` (fast decisions: ${config.ollama.fastModel})` : "";
  console.log(`LLM: ${config.ollama.model}${fastLabel} @ ${config.ollama.host}`);
  console.log(`Server: ${config.mc.host}:${config.mc.port} (MC ${config.mc.version})`);
  console.log(`Idle re-plan interval: ${config.bot.idleIntervalMs}ms`);
  console.log("");

  // Start overlay only once per bot (persists across restarts)
  if (!overlayStarted.value) {
    startOverlay(roleConfig.overlayPort, roleConfig.name);
    overlayStarted.value = true;
  }

  const { bot, queueChat, stop } = await createBot(
    {
      onThought: (thought) => console.log(`[${roleConfig.name}] 💭 ${thought}`),
      onAction: (action, result) => console.log(`[${roleConfig.name}] 🎮 [${action}] ${result}`),
      onChat: (message) => console.log(`[${roleConfig.name}] 💬 ${message}`),
    },
    roleConfig,
  );

  // The active single player owns the optional Twitch connection.
  const twitch =
    roleConfig.name === "Atlas" || roleConfig.name === "Solo"
      ? createTwitchChat((msg) => {
          queueChat(msg);
          addChatMessage(msg.username, msg.message, (msg as any).tier ?? "free");
        })
      : null;

  let lastKickReason = "";

  return new Promise<string>((resolve) => {
    // Register this bot's cleanup in the shared shutdown registry
    const cleanup = () => {
      stop();
      twitch?.client.disconnect();
    };
    activeStops.push(cleanup);

    const removeCleanup = () => {
      const idx = activeStops.indexOf(cleanup);
      if (idx !== -1) activeStops.splice(idx, 1);
    };

    bot.on("kicked", (reason) => {
      const reasonStr = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.log(`[${roleConfig.name}] Kicked: ${reasonStr}`);
      lastKickReason = reasonStr;
      removeCleanup();
      stop();
      twitch?.client.disconnect();
      resolve(lastKickReason);
    });

    bot.on("end", () => {
      console.log(`[${roleConfig.name}] Connection ended.`);
      removeCleanup();
      stop();
      twitch?.client.disconnect();
      resolve(lastKickReason);
    });

    bot.on("error", (err) => {
      console.error(`[${roleConfig.name}] Error:`, err);
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
    } catch (err) {
      console.error(`[${roleConfig.name}] Bot crashed:`, err);
    }

    restartCount++;
    if (restartCount >= MAX_RESTARTS) {
      console.error(`[${roleConfig.name}] Max restarts (${MAX_RESTARTS}) reached. Giving up.`);
      return;
    }

    const delay =
      lastKickReason.includes("duplicate_login") || lastKickReason.includes("You logged in from another location")
        ? DUPLICATE_LOGIN_DELAY_MS
        : RESTART_DELAY_MS;
    console.log(`[${roleConfig.name}] Restarting in ${delay / 1000}s... (attempt ${restartCount}/${MAX_RESTARTS})`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function main() {
  startMemoryMonitor();
  // Start the unified viewer server before any bots — it needs to be ready
  // to accept registerBot() calls when bots spawn. This serves the viewer
  // HTML, static assets, and handles socket.io relay for bot switching.
  if (config.viewer.enabled) {
    await startUnifiedViewer().catch((err) => {
      console.warn("[Main] Unified viewer failed to start:", err);
    });
  } else {
    console.log("[Main] Unified viewer disabled for this run.");
  }

  if (!config.multiBot.enabled) {
    console.log(`[Main] Solo mode: launching ${SOLO_CONFIG.name} (${SOLO_CONFIG.role})...`);
    try {
      const { startDashboard } = await import("./stream/dashboard.js");
      startDashboard([SOLO_CONFIG]);
    } catch {
      console.log("[Main] Dashboard module not available — skipping.");
    }
    await runBotLoop(SOLO_CONFIG);
    return;
  }

  const count = Math.min(config.multiBot.count, BOT_ROSTER.length);
  console.log(`[Main] Multi-bot mode: launching ${count} bots...`);

  const loops: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const role = BOT_ROSTER[i];
    console.log(`[Main] Starting ${role.name} (${role.role})...`);
    loops.push(runBotLoop(role));
    // Stagger each bot by 10 seconds to avoid login collisions
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Start dashboard after all bots are connecting
  try {
    const { startDashboard } = await import("./stream/dashboard.js");
    startDashboard(BOT_ROSTER.slice(0, count));
  } catch {
    console.log("[Main] Dashboard module not available — skipping.");
  }

  await Promise.all(loops);
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
