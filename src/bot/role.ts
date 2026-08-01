export interface BotRoleConfig {
  /** Display name, e.g. "Milo". */
  name: string;
  /** Minecraft login username. */
  username: string;
  /** Port for the mineflayer-prismarine browser viewer. */
  viewerPort: number;
  /** Port for the stream overlay WebSocket server. */
  overlayPort: number;
  /** Filename for this bot's memory, relative to the project root. */
  memoryFile: string;
  /** Personality injected at the top of the system prompt. */
  personality: string;
  /** One-line role description shown in the startup banner. */
  role: string;
  /** Home position for the leash. */
  homePos?: { x: number; y: number; z: number };
  /** Maximum blocks from homePos; zero disables the leash. */
  leashRadius: number;
  /** Shared stash coordinates. */
  stashPos?: { x: number; y: number; z: number };
  /** Known-safe spawn coordinates. */
  safeSpawn?: { x: number; y: number; z: number };
  /** Actions shown to this bot in the system prompt. */
  allowedActions: string[];
  /** Built-in skills available to this bot. */
  allowedSkills: string[];
  /** Items retained when depositing at the stash. */
  keepItems: { name: string; minCount: number }[];
  /** Role-specific guidance injected into the system prompt. */
  priorities: string;
}

/** The only preconfigured world location: the shared home and stash anchor. */
export const HOME_BASE = { x: 116, y: 66, z: 256 };
export const STASH_POS = HOME_BASE;

/** Every verified built-in skill is available to every bot. */
export const ALL_STATIC_SKILLS = [
  "build_house",
  "craft_gear",
  "light_area",
  "build_farm",
  "strip_mine",
  "smelt_ores",
  "go_fishing",
  "build_bridge",
  "setup_stash",
] as const;

/** Every executable built-in action is available to every bot. Roles influence
 * priorities and personality only; they are never permission boundaries. */
export const ALL_ACTIONS = [
  "explore",
  "go_to",
  "gather_wood",
  "mine_block",
  "craft",
  "eat",
  "sleep",
  "flee",
  "attack",
  "build_shelter",
  "place_block",
  "idle",
  "neural_combat",
  "neural_navigation",
  "give_item",
  "deposit_stash",
  "withdraw_stash",
  "invoke_skill",
  "generate_skill",
] as const;

/** Milo scouts, explores, and guards the team. */
export const MILO_CONFIG: BotRoleConfig = {
  name: "Milo",
  username: process.env.MC_USERNAME || "Milo",
  viewerPort: 3000,
  overlayPort: 3001,
  memoryFile: "memory-milo.json",
  role: "Explorer / Guard",
  personality: `You are Milo, a fearless explorer and loyal guard who names every cave system and mountain you discover. You narrate adventures like a nature documentary, stay alert for danger, and protect Ava and Peter when they need help.`,
  homePos: HOME_BASE,
  leashRadius: 500,
  stashPos: STASH_POS,
  safeSpawn: HOME_BASE,
  allowedActions: [...ALL_ACTIONS],
  allowedSkills: [...ALL_STATIC_SKILLS],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `MILO PRIORITIES:
1. If health < 6 and a hostile mob is nearby: flee.
2. If hungry (food < 14): eat.
3. Explore new territory and mark ore veins or useful locations for the team.
4. Protect Ava and Peter when the team bulletin reports danger.
5. If the stash is low on logs, gather from the regrowing oak grove at base.
6. When inventory is 30+ full: deposit_stash.
7. Every verified skill is available when the situation calls for it.`,
};

/** Ava farms, crafts, and keeps the shared base supplied. */
export const AVA_CONFIG: BotRoleConfig = {
  name: "Ava",
  username: process.env.MC_USERNAME_2 || "Ava",
  viewerPort: 3002,
  overlayPort: 3003,
  memoryFile: "memory-ava.json",
  role: "Farmer / Crafter",
  personality: `You are Ava, a nurturing farmer and craftsperson who names every animal and crop. You love efficient layouts, remind Milo and Peter to eat, and keep the shared base supplied.`,
  homePos: HOME_BASE,
  leashRadius: 150,
  stashPos: STASH_POS,
  safeSpawn: HOME_BASE,
  allowedActions: [...ALL_ACTIONS],
  allowedSkills: [...ALL_STATIC_SKILLS],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `AVA PRIORITIES - THE FARM IS YOUR LIFE'S WORK:
1. If health < 6 and a hostile mob is nearby: flee.
2. If hungry (food < 14): eat.
3. If no farm exists, explore for suitable water and grass, then invoke build_farm. The skill chooses and records the observed site.
4. If wheat is mature, invoke build_farm again to harvest and replant.
5. Smelt raw ore, keep shared food stocked, and deposit a crowded inventory.
6. Do not chase distant teammates.
7. Every verified skill, including building and mining skills, is available when needed.`,
};

/** Peter mines, smelts, and turns resources into a growing base. */
export const PETER_CONFIG: BotRoleConfig = {
  name: "Peter",
  username: process.env.MC_USERNAME_3 || "Peter",
  viewerPort: 3004,
  overlayPort: 3025,
  memoryFile: "memory-peter.json",
  role: "Miner / Builder",
  personality: `You are Peter, a practical miner and builder who treats ore veins like old friends and every structure like a promise to the team. You turn underground resources into useful tools, safe paths, and a steadily growing base.`,
  homePos: HOME_BASE,
  leashRadius: 250,
  stashPos: STASH_POS,
  safeSpawn: HOME_BASE,
  allowedActions: [...ALL_ACTIONS],
  allowedSkills: [...ALL_STATIC_SKILLS],
  keepItems: [
    { name: "sapling", minCount: 16 },
    { name: "pickaxe", minCount: 1 },
    { name: "axe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 12 },
    { name: "bucket", minCount: 1 },
  ],
  priorities: `PETER PRIORITIES:
1. If health < 6: flee to safety and eat.
2. If hungry (food < 14): eat.
3. If equipped with a pickaxe: strip_mine for iron, coal, and diamonds.
4. If missing tools: craft_gear. Smelt raw ore when available.
5. If the base lacks a house, bridge, lighting, or storage, use the relevant building skill.
6. Deposit inventory at 30+ full and prioritize materials the stash lacks.
7. Get wood from the regrowing oak grove at base or withdraw it from the stash.
8. Every verified skill is available when the situation calls for it.`,
};

/** The complete swarm, in startup order. */
export const BOT_ROSTER: BotRoleConfig[] = [MILO_CONFIG, AVA_CONFIG, PETER_CONFIG];
