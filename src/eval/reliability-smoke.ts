/**
 * Opt-in real-server reliability smoke checks.
 *
 * This runner never creates items or teleports. Give the smoke bot chest
 * materials, one depositable item, food, torches, blocks, and a pickaxe in a
 * disposable survival world before enabling the optional mining scenario.
 */
import mineflayer from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import { config } from "../config.js";
import { executeAction } from "../bot/actions.js";
import { STASH_POS } from "../bot/role.js";
import { cancelActiveOperation, runControlledOperation } from "../operations/controller.js";
import { succeeded, type OperationResult } from "../operations/types.js";
import { EmergencyManager } from "../recovery/emergency.js";
import { runSkill } from "../skills/executor.js";
import { skillRegistry } from "../skills/registry.js";
import { verifyCanonicalStash } from "../world/registry.js";

const { pathfinder } = pathfinderPackage;

interface SmokeRecord {
  check: string;
  selectedSkill: string;
  initialState: Record<string, unknown>;
  result: OperationResult | Record<string, unknown>;
  finalState: Record<string, unknown>;
}

function state(bot: mineflayer.Bot): Record<string, unknown> {
  return {
    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    health: bot.health,
    food: bot.food,
    inventory: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
  };
}

function emit(record: SmokeRecord): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record }));
}

function requireSuccess(check: string, result: OperationResult): void {
  if (result.status !== "succeeded") {
    throw new Error(`${check} failed [${result.status}/${result.code}]: ${result.message}`);
  }
}

async function connect(): Promise<mineflayer.Bot> {
  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    version: config.mc.version,
    auth: config.mc.auth,
    username: process.env.SMOKE_USERNAME || "SwarmSmoke",
  });
  bot.loadPlugin(pathfinder);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SMOKE_CONNECT_TIMEOUT")), 20_000);
    bot.once("spawn", () => {
      clearTimeout(timeout);
      resolve();
    });
    bot.once("error", reject);
    bot.once("kicked", (reason) => reject(new Error(`SMOKE_KICKED: ${JSON.stringify(reason)}`)));
  });
  return bot;
}

async function run(): Promise<void> {
  const bot = await connect();
  try {
    const setup = skillRegistry.get("setup_stash");
    if (!setup) throw new Error("setup_stash is not registered");
    const initialStash = state(bot);
    const setupResult = await runSkill(bot, setup, STASH_POS);
    const registry = await verifyCanonicalStash(bot, "shared-stash", STASH_POS, 5);
    emit({ check: "establish_and_reopen_stash", selectedSkill: "setup_stash", initialState: initialStash, result: setupResult, finalState: { ...state(bot), registry } });
    requireSuccess("establish_and_reopen_stash", setupResult);
    if (registry.status !== "verified") throw new Error("Canonical stash did not reopen and verify");

    const depositable = bot.inventory.items().find((item) => item.name !== "chest");
    if (!depositable) throw new Error("Give the smoke bot one depositable item before running the stash transaction check");
    const keepItems = bot.inventory.items()
      .filter((item) => item.name !== depositable.name)
      .map((item) => ({ name: item.name, minCount: item.count }));
    const beforeTransaction = state(bot);
    const deposit = await executeAction(bot, "deposit_stash", { stashPos: STASH_POS, keepItems });
    requireSuccess("deposit_one_item", deposit);
    const withdrawal = await executeAction(bot, "withdraw_stash", { stashPos: STASH_POS, item: depositable.name, count: 1 });
    requireSuccess("withdraw_same_item", withdrawal);
    emit({ check: "stash_round_trip", selectedSkill: "deposit_stash+withdraw_stash", initialState: beforeTransaction, result: { deposit, withdrawal }, finalState: state(bot) });

    const cancellationInitial = state(bot);
    const pending = runControlledOperation(bot, "action", 10_000, async (token) => {
      while (!token.signal.aborted) {
        bot.setControlState("forward", true);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return succeeded("LATE_NAVIGATION_RESULT", "This result must be invalidated.");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cancelActiveOperation(bot);
    const cancelled = await pending;
    if (cancelled.status !== "cancelled") throw new Error(`Cancellation remained ${cancelled.status}`);
    emit({ check: "cancel_long_navigation", selectedSkill: "operation_controller", initialState: cancellationInitial, result: cancelled, finalState: state(bot) });

    if (process.env.SMOKE_WATER_FIXTURE === "true") {
      const emergency = new EmergencyManager();
      const initial = state(bot);
      if (emergency.observe(bot)?.kind !== "WATER_ESCAPE") throw new Error("Place the smoke bot in shallow water first");
      const result = await emergency.resolve(bot);
      if (!result) throw new Error("Water recovery produced no result");
      requireSuccess("water_escape", result);
      emit({ check: "water_escape", selectedSkill: "WATER_ESCAPE", initialState: initial, result, finalState: state(bot) });
    }

    if (process.env.SMOKE_STRIP_MINE === "true") {
      const stripMine = skillRegistry.get("strip_mine");
      if (!stripMine) throw new Error("strip_mine is not registered");
      const initial = state(bot);
      const result = await runSkill(bot, stripMine, {});
      emit({ check: "strip_mine_round_trip", selectedSkill: "strip_mine", initialState: initial, result, finalState: state(bot) });
      requireSuccess("strip_mine_round_trip", result);
    }
  } finally {
    bot.quit("Reliability smoke checks finished");
  }
}

run().catch((error) => {
  console.error(`[ReliabilitySmoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
