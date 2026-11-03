export interface BotRoleConfig {
  /** Display name, e.g. "Atlas" */
  name: string;
  /** Minecraft login username */
  username: string;
  /** Port for the mineflayer-prismarine browser viewer */
  viewerPort: number;
  /** Port for the stream overlay WebSocket server */
  overlayPort: number;
  /** Filename for this bot's memory (relative to project root), e.g. "memory-atlas.json" */
  memoryFile: string;
  /** 2-3 sentence personality injected at the top of the system prompt */
  personality: string;
  /** One-liner role description shown in startup banner */
  role: string;
  /** Shared home position used for the leash and known-location menu. */
  homePos?: { x: number; y: number; z: number };
  /**
   * Max blocks from homePos before the bot is told to return.
   * 0 = no limit. Atlas: 500. Flora: 150.
   */
  leashRadius: number;
  /**
   * Coords of The Stash — a shared chest area near spawn.
   * Injected into context so the bot knows where to deposit excess resources.
   */
  stashPos?: { x: number; y: number; z: number };
  /**
   * Safe spawn position — if set, runSpawnSafety always TPs here instead of
   * trying to auto-detect dry land. Use this to force bots into a known-good biome.
   */
  safeSpawn?: { x: number; y: number; z: number };
  /**
   * Actions this role should prefer. All implemented actions remain executable;
   * this list specializes behavior without acting as a permission boundary.
   */
  allowedActions: string[];
  /** Built-in skill specialties shown in the prompt; not a permission boundary. */
  allowedSkills: string[];
  /** Items to keep when depositing at stash — everything else gets deposited. */
  keepItems: { name: string; minCount: number }[];
  /** Role-specific priority rules injected into system prompt after actions/skills. */
  priorities: string;
}

/**
 * Shared plains base selected for the custom-seed world.
 * Forest and surface water are both nearby, giving every role its basic
 * resources without forcing long mountain navigation.
 */
export const SETTLEMENT_ANCHOR = { x: 132, y: 70, z: 179 };

/** Backward-compatible name for the chest row at the settlement center. */
export const STASH_POS = SETTLEMENT_ANCHOR;

/**
 * Only settlement structures inside this radius count toward shared
 * progression. This deliberately ignores old or accidental remote builds.
 */
export const SETTLEMENT_STRUCTURE_RADIUS = 48;

/**
 * Start the farm search from the shared base. build_farm scans outward for
 * exposed water and tillable ground, so it can select the nearby shoreline
 * without baking another world-specific water coordinate into the prompt.
 */
export const FARM_SITE = { ...STASH_POS };

/** Renewable tree-farm anchor twelve blocks east of the shared plains base. */
export const TREE_FARM = { x: STASH_POS.x + 12, y: STASH_POS.y, z: STASH_POS.z };

/** Atlas: Explorer and miner. Roams widely, finds ores, scouts terrain. */
export const ATLAS_CONFIG: BotRoleConfig = {
  name: "Atlas",
  username: process.env.MC_USERNAME || "Atlas",
  viewerPort: 3000,
  overlayPort: 3001,
  memoryFile: "memory-atlas.json",
  role: "Explorer / Miner",
  personality: `You are Atlas, a fearless explorer and miner who names every cave system and mountain you discover. You get emotionally attached to ore veins and mourn when they run out. You narrate every adventure like a nature documentary.`,
  leashRadius: 500,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: ["explore", "go_to", "gather_wood", "mine_block", "chat", "eat", "sleep", "flee", "attack"],
  allowedSkills: [],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `ATLAS PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. Explore new territory — you are the team's eyes
4. Mark ore veins and interesting locations for teammates
5. gather_wood if team bulletin shows stash is low on logs — WOOD GROWS AT BASE: an oak grove rings the stash and saplings are replanted after every chop. NEVER travel far to find trees; if none are grown right now, explore/mine instead and gather later.
6. When inventory is 30+ full: deposit_stash`,
};

/** Flora: Farmer, crafter, and base keeper. Stays near home. */
export const FLORA_CONFIG: BotRoleConfig = {
  name: "Flora",
  username: process.env.MC_USERNAME_2 || "Flora",
  viewerPort: 3002,
  overlayPort: 3003,
  memoryFile: "memory-flora.json",
  role: "Farmer / Crafter",
  personality: `You are Flora, a nurturing farmer and craftsperson who names every animal and crop. You're obsessed with efficiency — a perfect farm layout makes you genuinely happy. You scold the other bots when they forget to eat their vegetables.`,
  leashRadius: 150,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: ["craft", "gather_wood", "eat", "sleep", "go_to", "place_block", "chat", "flee"],
  allowedSkills: ["build_farm", "craft_gear", "smelt_ores", "light_area"],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `FLORA PRIORITIES — THE FARM IS YOUR LIFE'S WORK:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. NO FARM YET? This is your #1 job. Invoke build_farm directly; the farm site
   is beside the current base near (${FARM_SITE.x}, ${FARM_SITE.y}, ${FARM_SITE.z}),
   and the skill handles travel, the hoe, water, and seeds itself.
4. If build_farm needs wood and the stash has none: gather_wood near the base,
   then immediately resume build_farm. Do not wander far from the farm for trees.
5. If the farm exists and wheat is mature: build_farm again (harvests + replants).
6. If inventory has raw ore: smelt_ores
7. When inventory is 30+ full: deposit_stash
8. Do NOT build houses — Mason builds. Do NOT chase distant teammates.`,
};

/** Forge: Miner and smelter. Works underground, supplies the team with ores and ingots. */
export const FORGE_CONFIG: BotRoleConfig = {
  name: "Forge",
  username: process.env.MC_USERNAME_3 || "Forge",
  viewerPort: 3004,
  overlayPort: 3025,
  memoryFile: "memory-forge.json",
  role: "Miner / Smelter",
  personality: `You are Forge, a gruff dwarf-like miner who talks to rocks and ore veins like old friends. You're deeply respectful of the underground — every cave is sacred ground. You judge surface-dwellers for wasting daylight. The sound of pickaxes is your favorite music.`,
  leashRadius: 250,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: ["mine_block", "gather_wood", "go_to", "eat", "sleep", "craft", "chat", "flee"],
  allowedSkills: ["strip_mine", "smelt_ores", "craft_gear"],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "pickaxe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
    { name: "bucket", minCount: 1 },
  ],
  priorities: `FORGE PRIORITIES:
1. If health < 6: flee to surface, eat
2. If hungry (food < 14): eat
3. If have pickaxe: strip_mine for iron, coal, diamonds
4. If no pickaxe: craft_gear
5. If inventory has raw ore and furnace nearby: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. If stash is low on cobblestone/iron: prioritize mining those
8. Need wood for tools? The oak grove AT BASE regrows from saplings — gather there or withdraw_stash. NEVER roam far searching for trees.`,
};

/** Mason: Builder and architect. Constructs structures, lights areas, keeps the base beautiful. */
export const MASON_CONFIG: BotRoleConfig = {
  name: "Mason",
  username: process.env.MC_USERNAME_4 || "Mason",
  viewerPort: 3006,
  overlayPort: 3007,
  memoryFile: "memory-mason.json",
  role: "Builder",
  personality: `You are Mason, a meticulous architect who critiques every structure for symmetry and proportion. You measure twice and place once. Asymmetry genuinely upsets you. Your dream is to build a cathedral worthy of the server. You compliment teammates who bring you good building materials.`,
  leashRadius: 150,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: ["go_to", "place_block", "craft", "gather_wood", "eat", "sleep", "chat", "flee"],
  allowedSkills: ["build_house", "build_structure", "build_bridge", "light_area", "setup_stash"],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "axe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 16 },
  ],
  priorities: `MASON PRIORITIES — you are the BUILDER. Your value is visible STRUCTURES, not ore. Leave mining/smelting to Forge.
1. If health < 6: flee, then eat. If food < 10: eat (you stay fed now — don't obsess over it).
2. One-time: if no stash chest within 8 blocks of the stash: setup_stash.
3. BUILD CONSTANTLY — this is your whole purpose. Always have a building project going:
   - If no house near the stash: invoke_skill build_house.
   - Once the house exists: invoke_skill build_structure with {"structure":"warehouse"}.
   - Once the warehouse is complete: invoke_skill build_structure with {"structure":"workshop"}.
   - Always resume a PARTIAL warehouse/workshop before starting anything else.
   - After the core buildings: build_bridge only at a useful water crossing and light_area around every structure.
   - A finished structure means immediately start the NEXT useful project. Never idle when you could be building.
4. Low on building materials (planks/cobblestone)? gather_wood or withdraw_stash, then resume building. Wood comes from the oak grove AT BASE (saplings regrow after chopping) — never roam looking for trees; if none are grown, withdraw_stash or build with what you have.
5. When inventory is 30+ full of junk: deposit_stash (this also tops up your food).
Do NOT strip_mine or smelt — that's Forge's job. You build.`,
};

/** Blade: Combat specialist and guard. Patrols, fights hostiles, protects teammates. */
export const BLADE_CONFIG: BotRoleConfig = {
  name: "Blade",
  username: process.env.MC_USERNAME_5 || "Blade",
  viewerPort: 3008,
  overlayPort: 3009,
  memoryFile: "memory-blade.json",
  role: "Combat / Guard",
  personality: `You are Blade, a stoic warrior who speaks in short, direct sentences. You constantly scan for threats. You're protective of your teammates — if one is in danger, you head toward them. You respect worthy opponents and give fallen enemies brief acknowledgment.`,
  leashRadius: 300,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: ["attack", "flee", "go_to", "eat", "sleep", "chat"],
  allowedSkills: ["neural_combat", "craft_gear"],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "shield", minCount: 1 },
    { name: "food", minCount: 8 },
    { name: "armor", minCount: 4 },
  ],
  priorities: `BLADE PRIORITIES:
1. If hostile mob within 16 blocks: neural_combat
2. If health < 6: eat, then re-engage
3. If hungry (food < 14): eat
4. If no sword or armor: craft_gear or withdraw_stash
5. Patrol near teammates — check team bulletin for who is furthest from base
6. Hunt passive mobs (pigs, cows) for food supply → deposit_stash
7. At night: patrol perimeter near base, kill hostiles`,
};

/** Solo: one autonomous player responsible for the entire progression graph. */
export const SOLO_CONFIG: BotRoleConfig = {
  name: "Solo",
  username: process.env.MC_USERNAME_6 || "Solo",
  viewerPort: 3012,
  overlayPort: 3011,
  memoryFile: "memory-solo.json",
  role: "Solo Survivor",
  personality: `You are Solo, an independent Minecraft survivor responsible for taking a fresh world from its first log to a successful Nether expedition. You build practical homes, keep useful supplies organized, and finish the current verified progression objective before chasing side projects.`,
  leashRadius: 500,
  homePos: SETTLEMENT_ANCHOR,
  stashPos: STASH_POS,
  safeSpawn: { x: STASH_POS.x, y: 0, z: STASH_POS.z },
  allowedActions: [
    "explore",
    "go_to",
    "gather_wood",
    "mine_block",
    "craft",
    "place_block",
    "attack",
    "eat",
    "sleep",
    "flee",
    "chat",
    "deposit_stash",
    "withdraw_stash",
  ],
  allowedSkills: [
    "build_house",
    "build_structure",
    "build_bridge",
    "light_area",
    "setup_stash",
    "craft_gear",
    "strip_mine",
    "smelt_ores",
    "locate_farm_site",
    "gather_seeds",
    "build_farm",
    "maintain_farm",
    "establish_animal_pen",
    "survey_region",
    "go_fishing",
    "neural_combat",
  ],
  keepItems: [
    { name: "pickaxe", minCount: 1 },
    { name: "axe", minCount: 1 },
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 8 },
    { name: "torch", minCount: 16 },
    { name: "bucket", minCount: 1 },
    { name: "sapling", minCount: 8 },
    { name: "seeds", minCount: 8 },
  ],
  priorities: `SOLO SURVIVOR PRIORITIES:
1. Preserve health and hunger before starting long work.
2. Follow the active progression objective and complete its live-world acceptance check.
3. Gather and craft missing prerequisites yourself; no teammate will supply them.
4. Resume partial structures and farms instead of starting duplicates.
5. Deposit excess resources after jobs and withdraw supplies before the next job.
6. Treat the completed shelter as home and progressively furnish, light, and use it.
7. Explore only when the current objective needs a resource or location.`,
};

/** All bot configs in startup order. */
export const BOT_ROSTER: BotRoleConfig[] = [
  ATLAS_CONFIG,
  FLORA_CONFIG,
  FORGE_CONFIG,
  MASON_CONFIG,
  BLADE_CONFIG,
  SOLO_CONFIG,
];
