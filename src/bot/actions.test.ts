import { test } from "node:test";
import assert from "node:assert/strict";
import {
  craftExecutionsForOutput,
  executeAction,
  gatherWoodBudgetExpired,
  isVerifiedExploreProgress,
  isVerifiedMineProgress,
  isTransientCraftWindowFailure,
} from "./actions.js";

// ── Minimal mock bot ────────────────────────────────────────────────────────

function mockBot(overrides: Record<string, any> = {}) {
  const pos = { x: 0, y: 64, z: 0, clone: () => ({ ...pos }), distanceTo: () => 0, offset: () => pos };
  const chatLog: string[] = [];
  return {
    entity: { position: pos },
    health: 20,
    food: 20,
    username: "TestBot",
    chat: (msg: string) => chatLog.push(msg),
    _chatLog: chatLog,
    inventory: {
      items: () => overrides.items ?? [],
    },
    findBlock: () => null,
    findBlocks: () => [],
    blockAt: () => ({ name: "air" }),
    pathfinder: {
      setMovements: () => {},
      goto: () => Promise.resolve(),
      stop: () => {},
      thinkTimeout: 5000,
    },
    dig: () => Promise.resolve(),
    equip: () => Promise.resolve(),
    consume: () => Promise.resolve(),
    entities: {},
    ...overrides,
  } as any;
}

// ── Action routing: valid actions ───────────────────────────────────────────

test("executeAction: idle returns vibing message", async () => {
  const result = await executeAction(mockBot(), "idle", {});
  assert.equal(result.message, "Just vibing.");
  assert.equal(result.status, "succeeded");
});

test("executeAction: chat cannot consume an action", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "chat", { message: "Hello world" });
  assert.equal(result.code, "CHAT_DISABLED");
  assert.equal(bot._chatLog.length, 0);
});

test("executeAction: chat remains disabled without params", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "chat", {});
  assert.equal(bot._chatLog.length, 0);
  assert.equal(result.code, "CHAT_DISABLED");
  assert.equal(result.status, "failed");
});

test("executeAction: respond_to_chat cannot consume an action", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "respond_to_chat", { message: "Hey back!" });
  assert.equal(result.code, "CHAT_DISABLED");
  assert.equal(bot._chatLog.length, 0);
});

test("executeAction: unknown action returns descriptive error", async () => {
  const result = await executeAction(mockBot(), "nonexistent_action_xyz", {});
  assert.ok(result.message.includes("Unknown action"), `Expected 'Unknown action' message, got: ${result.message}`);
  assert.equal(result.code, "UNKNOWN_ACTION");
});

// ── Action routing: aliases ─────────────────────────────────────────────────

test("executeAction: flee_to_safety routes to flee handler", async () => {
  // flee tries to find hostile entities and run away; with no hostiles it will
  // still succeed (explore fallback)
  const bot = mockBot();
  const result = await executeAction(bot, "flee", {});
  // Should not throw and should return a string
  assert.equal(typeof result, "object");
});

test("executeAction: sleep_in_bed routes to sleep handler", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "sleep_in_bed", {});
  assert.equal(typeof result, "object");
});

test("executeAction: use_bed routes to sleep handler", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "use_bed", {});
  assert.equal(typeof result, "object");
});

// ── Action routing: gather_wood with no trees ───────────────────────────────

test("executeAction: gather_wood with no trees returns helpful message", async () => {
  const bot = mockBot({ findBlocks: () => [] });
  const result = await executeAction(bot, "gather_wood", {});
  assert.ok(result.message.includes("No trees found"), `Expected no-trees message, got: ${result.message}`);
});

// ── Action routing: mine_block with no matching block ───────────────────────

test("executeAction: mine_block with no block found", async () => {
  const bot = mockBot({ findBlock: () => null });
  const result = await executeAction(bot, "mine_block", { blockType: "diamond_ore" });
  assert.ok(result.message.includes("No diamond_ore found"), `Got: ${result.message}`);
});

// ── Action routing: invoke_skill with missing skill ─────────────────────────

test("executeAction: invoke_skill without skill param", async () => {
  const result = await executeAction(mockBot(), "invoke_skill", {});
  assert.ok(result.message.includes("needs a 'skill' param"));
});

test("executeAction: invoke_skill with unknown skill name", async () => {
  const result = await executeAction(mockBot(), "invoke_skill", { skill: "nonexistent_skill_xyz" });
  assert.ok(result.message.includes("disabled") || result.message.includes("not found"), `Got: ${result.message}`);
});

// ── Action routing: generate_skill with empty task ──────────────────────────

test("executeAction: generate_skill with empty task", async () => {
  const result = await executeAction(mockBot(), "generate_skill", { task: "" });
  assert.ok(result.message.includes("disabled"), `Got: ${result.message}`);
});

test("executeAction: generate_skill with no task param", async () => {
  const result = await executeAction(mockBot(), "generate_skill", {});
  assert.ok(result.message.includes("disabled"), `Got: ${result.message}`);
});

// ── Action routing: navigate variants ───────────────────────────────────────

test("executeAction: navigate alias routes to go_to", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "navigate", { x: 10, y: 64, z: 20 });
  assert.equal(typeof result, "object");
});

test("executeAction: go_to with coordinate array [x, z]", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "go_to", { coordinates: [100, 200] });
  assert.equal(result.code, "INVALID_COORDINATES");
});

test("executeAction: go_to with coordinate array [x, y, z]", async () => {
  const bot = mockBot();
  const result = await executeAction(bot, "go_to", { coordinates: [100, 64, 200] });
  assert.equal(typeof result, "object");
});

// ── Action routing: explore picks random direction ──────────────────────────

test("explore verification rejects blocked movement reports", () => {
  assert.equal(isVerifiedExploreProgress("Couldn't move north — path blocked, still at 0, 64, 0.", 0), false);
  assert.equal(isVerifiedExploreProgress("Path blocked after a partial move.", 5), false);
  assert.equal(isVerifiedExploreProgress("Explored north and moved 12 blocks.", 12), true);
});
test("craft output counts account for recipe yield", () => {
  assert.equal(craftExecutionsForOutput(4, 4), 1);
  assert.equal(craftExecutionsForOutput(5, 4), 2);
  assert.equal(craftExecutionsForOutput(3, 1), 3);
});
test("craft retry classification recognizes transient table-window failures", () => {
  assert.equal(isTransientCraftWindowFailure("Event windowOpen did not fire within timeout of 20000ms"), true);
  assert.equal(isTransientCraftWindowFailure("missing ingredient"), false);
});
test("gather_wood deadline expires deterministically", () => {
  assert.equal(gatherWoodBudgetExpired(1_000, 999), false);
  assert.equal(gatherWoodBudgetExpired(1_000, 1_000), true);
});
test("mine verification rejects expected navigation failures", () => {
  assert.equal(isVerifiedMineProgress("Couldn't reach coal_ore at 1, 2, 3."), false);
  assert.equal(isVerifiedMineProgress("Failed to mine coal_ore; the target remained unchanged."), false);
  assert.equal(isVerifiedMineProgress("Mined 3x coal_ore (vein)."), true);
});

// ── Action routing: deposit/withdraw stash without position ─────────────────

test("executeAction: deposit_stash without stashPos returns error", async () => {
  const result = await executeAction(mockBot(), "deposit_stash", {});
  assert.ok(result.message.includes("No stash position"));
});

test("executeAction: withdraw_stash without stashPos returns error", async () => {
  const result = await executeAction(mockBot(), "withdraw_stash", {});
  assert.ok(result.message.includes("No stash position"));
});

test("executeAction: withdraw_stash without item param returns error", async () => {
  const result = await executeAction(mockBot(), "withdraw_stash", {
    stashPos: { x: 0, y: 64, z: 0 },
  });
  assert.ok(result.message.includes("needs an 'item' param"));
});

// ── Action error handling ───────────────────────────────────────────────────

test("executeAction: catches thrown errors gracefully", async () => {
  const bot = mockBot({
    findBlock: () => {
      throw new Error("Chunk not loaded");
    },
  });
  const result = await executeAction(bot, "mine_block", { blockType: "stone" });
  assert.ok(
    result.message.includes("Action failed") || result.message.includes("Chunk not loaded"),
    `Got: ${result.message}`,
  );
});
