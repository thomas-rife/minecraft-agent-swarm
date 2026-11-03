import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { buildActionMenu, validateDecisionAgainstMenu } from "./action-menu.js";
import { skillRegistry } from "../skills/registry.js";

function block(name: string) {
  return { name, boundingBox: name === "air" ? "empty" : "block", position: new Vec3(1, 64, 0) };
}

function mockBot(
  options: {
    items?: { name: string; count: number }[];
    blocks?: string[];
    entities?: any[];
    food?: number;
    health?: number;
    time?: number;
  } = {},
) {
  const blocks = new Set(options.blocks ?? []);
  const entities = Object.fromEntries((options.entities ?? []).map((entity, index) => [index, entity]));
  const position = new Vec3(0, 64, 0);
  return {
    entity: { position },
    entities,
    inventory: { items: () => options.items ?? [] },
    food: options.food ?? 20,
    health: options.health ?? 20,
    time: { timeOfDay: options.time ?? 6000 },
    findBlock: ({ matching }: any) => {
      for (const name of blocks) {
        const candidate = block(name);
        if (matching(candidate)) return candidate;
      }
      return null;
    },
    registry: {
      itemsByName: {
        oak_planks: { id: 1 },
        stick: { id: 2 },
      },
      foodsByName: { bread: {} },
    },
  } as any;
}

function context(overrides: Record<string, any> = {}) {
  return {
    roleName: "Atlas",
    role: "Explorer / Miner",
    preferredActions: ["explore", "mine_block"],
    preferredSkills: [],
    structures: new Set<string>(),
    ...overrides,
  };
}

test("menu omits conditionally impossible actions", () => {
  const menu = buildActionMenu(mockBot(), context());
  const names = menu.map((option) => option.action);

  assert.ok(names.includes("explore"));
  assert.ok(!names.includes("go_to"));
  assert.ok(!names.includes("idle"));
  assert.ok(!names.includes("eat"));
  assert.ok(!names.includes("sleep"));
  assert.ok(!names.includes("attack"));
  assert.ok(!names.includes("gather_wood"));
  assert.ok(!names.includes("generate_skill"));
});

test("menu exposes only visible mine targets and needed wood", () => {
  const bot = mockBot({ blocks: ["oak_log", "iron_ore"] });
  const menu = buildActionMenu(bot, context({ woodNeeded: true }));
  const mine = menu.find((option) => option.action === "mine_block");

  assert.ok(menu.some((option) => option.action === "gather_wood"));
  assert.deepEqual(mine?.allowedParams?.blockType, ["iron_ore"]);
});

test("non-miners do not see ordinary stone or grass as relevant mine targets", () => {
  const menu = buildActionMenu(
    mockBot({ blocks: ["stone", "grass_block"] }),
    context({
      roleName: "Flora",
      role: "Farmer / Crafter",
      preferredActions: ["craft", "explore"],
      preferredSkills: ["build_farm"],
      goal: "Collect wheat seeds for the farm",
    }),
  );

  assert.ok(!menu.some((option) => option.action === "mine_block"));
});

test("Flora sees build_farm but not unrelated dynamic skills", () => {
  const dynamicName = "collectFiveCactusBlocks";
  const previous = skillRegistry.get(dynamicName);
  skillRegistry.set(dynamicName, {
    name: dynamicName,
    description: "Collect five cactus blocks.",
    params: {},
    estimateMaterials: () => ({}),
    execute: async () => ({ success: true, message: "done" }),
  });
  try {
    const menu = buildActionMenu(
      mockBot(),
      context({
        roleName: "Flora",
        role: "Farmer / Crafter",
        preferredSkills: ["build_farm"],
        goal: "Collect wheat seeds for the farm",
      }),
    );

    assert.ok(menu.some((option) => option.skill === "build_farm"));
    assert.ok(!menu.some((option) => option.skill === dynamicName));

    const explicitlyRequested = buildActionMenu(
      mockBot(),
      context({
        goal: "Collect five cactus blocks",
        explicitlyRequestedSkills: new Set([dynamicName]),
      }),
    );
    assert.ok(explicitlyRequested.some((option) => option.skill === dynamicName));
  } finally {
    if (previous) skillRegistry.set(dynamicName, previous);
    else skillRegistry.delete(dynamicName);
  }
});

test("execution gate rejects invented actions and stale parameters", () => {
  const bot = mockBot({ blocks: ["iron_ore"] });
  const menu = buildActionMenu(bot, context());

  assert.equal(validateDecisionAgainstMenu(bot, { action: "gather_seeds", params: {} }, menu).ok, false);
  assert.equal(
    validateDecisionAgainstMenu(bot, { action: "mine_block", params: { blockType: "diamond_ore" } }, menu).ok,
    false,
  );
  assert.equal(
    validateDecisionAgainstMenu(bot, { action: "mine_block", params: { blockType: "iron_ore" } }, menu).ok,
    true,
  );
});

test("execution gate rejects a valid item whose recipe is not currently satisfiable", () => {
  const bot = mockBot();
  bot.registry.itemsByName.iron_pickaxe = { id: 3 };
  bot.recipesFor = () => [];
  const menu = buildActionMenu(bot, context({ goal: "Craft an iron pickaxe" }));
  const validation = validateDecisionAgainstMenu(
    bot,
    { action: "craft", params: { item: "iron_pickaxe", count: 1 } },
    menu,
  );

  assert.equal(validation.ok, false);
  assert.match(validation.reason ?? "", /no currently satisfiable recipe/);
});

test("execution gate rejects hallucinated distant coordinates", () => {
  const bot = mockBot();
  const menu = buildActionMenu(bot, context({ knownLocations: [{ x: 100, y: 64, z: 0, label: "base" }] }));
  const validation = validateDecisionAgainstMenu(bot, { action: "go_to", params: { x: 500, y: 64, z: 500 } }, menu);

  assert.equal(validation.ok, false);
  assert.match(validation.reason ?? "", /capped at 200/);
});

test("go_to accepts a listed location but rejects invented nearby coordinates", () => {
  const bot = mockBot();
  const menu = buildActionMenu(bot, context({ knownLocations: [{ x: 100, y: 64, z: 0, label: "base" }] }));

  assert.equal(validateDecisionAgainstMenu(bot, { action: "go_to", params: { x: 100, y: 64, z: 0 } }, menu).ok, true);
  const invented = validateDecisionAgainstMenu(bot, { action: "go_to", params: { x: 90, y: 64, z: 10 } }, menu);
  assert.equal(invented.ok, false);
  assert.match(invented.reason ?? "", /known location/);
});

test("distant known locations are exposed as safe bounded waypoints", () => {
  const bot = mockBot();
  const menu = buildActionMenu(bot, context({ knownLocations: [{ x: 500, y: 64, z: 0, label: "home" }] }));
  const goTo = menu.find((option) => option.action === "go_to");
  const waypoint = goTo?.coordinateTargets?.[0];

  assert.ok(waypoint);
  assert.match(waypoint?.label ?? "", /waypoint toward home/);
  assert.ok(Math.hypot(waypoint!.x, waypoint!.z) <= 180);
  assert.equal(validateDecisionAgainstMenu(bot, { action: "go_to", params: waypoint! }, menu).ok, true);
});
