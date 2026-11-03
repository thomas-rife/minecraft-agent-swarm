import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { collectNearbyDrops, safeGoto } from "../bot/navigation.js";
import { getAllMemoryStores, getBotMemoryStore } from "../bot/memory-registry.js";
import type { BotMemoryStore, Structure } from "../bot/memory.js";
import { SETTLEMENT_STRUCTURE_RADIUS } from "../bot/role.js";
import { preferredMineEntrance } from "./settlement-layout.js";

// Keep every pass well below the global watchdog. Long 120-200 block calls
// were the main source of timed-out promises retaining entire bot worlds.
const TUNNEL_SEGMENT_LENGTH = 24;
const TORCH_INTERVAL = 6;
// Y=16 is IRON's peak in 1.18+ (and the classic iron-mining level). At Y=-16
// (a prior diamond-chasing setting) tunnels yielded gold/redstone but ZERO
// iron — the deepslate zone is iron-poor — which starved the whole
// iron->tools->armor chain (0 iron smelted for runs). Diamonds are shelved
// (volume-limited, not worth the deep lava), so there's no reason to be that
// deep. Y=16 restores iron supply, still yields coal/copper, and is well above
// the lava lakes (~-50) so it stays lava-safe.
const TARGET_Y = 16;
const COAL_TARGET_Y = 48;

export const stripMineSkill: Skill = {
  name: "strip_mine",
  description:
    "Use the settlement's shared mine entrance and extend a persistent lit branch at the appropriate resource level (Y=16 for iron/general, Y=48 for coal). Can target iron, coal, stone, or general resources. Requires a pickaxe.",
  params: {
    target: {
      type: "string",
      description: '"general", "iron", "coal", or "stone"',
    },
    targetCount: {
      type: "number",
      description: "Preferred number of target blocks before returning; the bounded tunnel may finish first.",
    },
  },

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    // Verify pickaxe
    const pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (!pickaxe) {
      return { success: false, message: "Need a pickaxe! Use craft_gear first, then strip_mine." };
    }

    const target = normalizeTarget(params?.target);
    const targetCount = Math.max(1, Math.min(64, Number(params?.targetCount) || 64));
    const targetY = target === "coal" ? COAL_TARGET_Y : TARGET_Y;
    const settlementAnchor = params?.settlementAnchor as { x: number; y: number; z: number } | undefined;
    const sharedMine = await reachSharedMine(bot, settlementAnchor, signal, onProgress);
    if (!sharedMine.success) return { success: false, message: sharedMine.message };

    let mined = 0;
    const oresFound: string[] = [];
    let targetFound = 0;

    // Rotate bounded branches. A pass is progress even when the requested ore
    // is absent; geology is probabilistic and zero yield is not an executor
    // failure.
    const runIndex = sharedMine.runs;
    const forward = chooseFreshTunnelDirection(bot, runIndex);
    const tunnelLength = TUNNEL_SEGMENT_LENGTH;
    console.log(
      `[Skill] Shared mine run ${runIndex + 1}: target=${target}, direction=${dirName(forward)}, length=${tunnelLength}, starting Y=${bot.entity.position.y.toFixed(0)}`,
    );

    // --- Phase 1: Descend to the resource-appropriate level. Iron/general
    // use Y=16; coal uses Y=48 where it is materially more common. ---
    // The old manual staircase dug blocks but moveToPosition often failed to
    // follow it down, so the bot stayed at the surface (Y~64-90) and tunneled
    // where iron is rare — 12 runs found only coal, 0 iron. Use the pathfinder
    // with digging enabled to ACTUALLY reach depth: it handles the descent and
    // avoids lava/dangerous falls itself.
    const currentY = Math.floor(bot.entity.position.y);
    if (currentY > targetY + 5) {
      onProgress({
        skillName: "strip_mine",
        phase: "Digging down",
        progress: 0.05,
        message: `Digging down to Y=${targetY} (${target} level)...`,
        active: true,
      });
      const digMoves = new Movements(bot);
      digMoves.canDig = true;
      digMoves.allow1by1towers = true;
      bot.pathfinder.setMovements(digMoves);
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalY(targetY)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.stop();
              rej(new Error("descend timeout"));
            }, 60000),
          ),
        ]);
      } catch {
        /* partial descent — mine wherever we reached */
      }
      // Collect anything the descent dropped (ore dug on the way down).
      await collectNearbyDrops(bot, 4, 3000);
      console.log(`[Skill] strip_mine descended to Y=${bot.entity.position.y.toFixed(0)}`);
    }
    const reachedMiningLevel = bot.entity.position.y <= targetY + 5;
    if (!reachedMiningLevel) {
      const resume = bot.entity.position.floored();
      sharedMine.store?.addStructure(
        "mine",
        sharedMine.entrance.x,
        sharedMine.entrance.y,
        sharedMine.entrance.z,
        mineNotes("partial", runIndex, resume),
      );
      return {
        success: true,
        message: `Shared mine descent advanced to Y=${resume.y}; target Y=${targetY} is not reached yet. Resume point (${resume.x}, ${resume.y}, ${resume.z}) is remembered, and no premature horizontal branch was dug.`,
        stats: { blocksMined: mined, oresFound: oresFound.length, targetFound },
      };
    }

    // --- Phase 2: Horizontal mining tunnel ---
    onProgress({
      skillName: "strip_mine",
      phase: "Mining tunnel",
      progress: 0.3,
      message: "Mining horizontal tunnel...",
      active: true,
    });

    for (let step = 0; step < tunnelLength && !signal.aborted; step++) {
      const pos = bot.entity.position.floored();

      // Dig 2 blocks ahead: foot level and head level
      const targets = [pos.offset(forward.x, 0, forward.z), pos.offset(forward.x, 1, forward.z)];

      for (const t of targets) {
        const b = bot.blockAt(t);
        if (!b || b.name === "air") continue;
        if (b.name === "bedrock") {
          return {
            success: true,
            message: `Hit bedrock at step ${step}! Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (b.name === "lava" || b.name === "water") continue;

        await equipBestPickaxe(bot);
        try {
          await digSafe(bot, b);
          mined++;
          if (b.name.includes("ore")) oresFound.push(b.name);
          if (matchesTarget(b.name, target)) targetFound++;
        } catch {
          /* skip */
        }
      }

      // Mine any ore exposed in the surrounding walls/floor/ceiling. The old
      // tunnel only checked the 2 blocks dead ahead, so it walked straight past
      // veins in the walls — which is why nights of mining found "0 ores".
      const exposed = await mineExposedOre(bot, pos);
      mined += exposed.mined;
      oresFound.push(...exposed.ores);
      targetFound += exposed.ores.filter((ore) => matchesTarget(ore, target)).length;

      // Walk forward into cleared space
      const targetPos = pos.offset(forward.x, 0, forward.z);
      await moveToPosition(bot, targetPos);

      // Place torch every N blocks
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        await placeTorchOnWall(bot, forward);
      }

      if (step % 5 === 0) {
        onProgress({
          skillName: "strip_mine",
          phase: "Mining tunnel",
          progress: 0.3 + (step / tunnelLength) * 0.7,
          message: `${step}/${tunnelLength} blocks | Mined: ${mined} | ${target}: ${targetFound}`,
          active: true,
        });
      }

      if (target !== "general" && targetFound >= targetCount) break;
    }

    if (mined === 0) {
      return { success: false, message: "Couldn't mine anything. Pickaxe might have broken." };
    }

    // Sweep the tunnel to pick up the ore we dug — without this, strip_mine
    // reported "Found 8x iron_ore" but left the drops on the ground, so the
    // bot never actually had iron to smelt. Walk back over the tunnel.
    await collectNearbyDrops(bot, 16, 8000);

    if (signal.aborted) {
      return {
        success: false,
        message: `Shared mine run was interrupted after mining ${mined} blocks; the entrance remains remembered.`,
        stats: { blocksMined: mined, oresFound: oresFound.length, targetFound },
      };
    }

    sharedMine.store?.addStructure(
      "mine",
      sharedMine.entrance.x,
      sharedMine.entrance.y,
      sharedMine.entrance.z,
      mineNotes("complete", runIndex + 1),
    );

    return {
      success: true,
      message: `Shared mine run complete from (${sharedMine.entrance.x}, ${sharedMine.entrance.y}, ${sharedMine.entrance.z}). Extended the ${dirName(forward)} branch at Y=${targetY} toward ${target}, mined ${mined} blocks, and found ${targetFound} target blocks. ${formatOres(oresFound)}`,
      stats: { blocksMined: mined, oresFound: oresFound.length, targetFound },
    };
  },
};

// --- Helpers ---

type MiningTarget = "general" | "iron" | "coal" | "stone";

interface SharedMineResult {
  success: boolean;
  message: string;
  entrance: { x: number; y: number; z: number };
  runs: number;
  store?: BotMemoryStore;
}

function normalizeTarget(value: unknown): MiningTarget {
  return value === "iron" || value === "coal" || value === "stone" ? value : "general";
}

function matchesTarget(blockName: string, target: MiningTarget): boolean {
  if (target === "general") return blockName.endsWith("_ore");
  if (target === "iron") return blockName === "iron_ore" || blockName === "deepslate_iron_ore";
  if (target === "coal") return blockName === "coal_ore" || blockName === "deepslate_coal_ore";
  return blockName === "stone" || blockName === "cobblestone" || blockName === "deepslate";
}

export function mineNotes(status: "partial" | "complete", runs: number, resume?: Vec3): string {
  const resumeNote =
    status === "partial" && resume
      ? `; resume=${Math.floor(resume.x)},${Math.floor(resume.y)},${Math.floor(resume.z)}`
      : "";
  return `Shared Mine; status=${status}; runs=${runs}${resumeNote}${status === "partial" ? " (partial)" : ""}`;
}

export function parseMineRuns(notes?: string): number {
  const parsed = Number(notes?.match(/\bruns=(\d+)/)?.[1] ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseMineResume(notes?: string): Vec3 | undefined {
  const match = notes?.match(/\bresume=(-?\d+),(-?\d+),(-?\d+)/);
  if (!match) return undefined;
  const values = match.slice(1, 4).map(Number);
  if (!values.every(Number.isFinite)) return undefined;
  return new Vec3(values[0], values[1], values[2]);
}

function findTeamMine(
  anchor?: { x: number; z: number },
): { structure: Structure; store: BotMemoryStore } | undefined {
  const candidates: { structure: Structure; store: BotMemoryStore }[] = [];
  for (const store of getAllMemoryStores()) {
    for (const structure of store.getStructures()) {
      if (structure.type !== "mine") continue;
      if (
        anchor &&
        Math.hypot(structure.x - anchor.x, structure.z - anchor.z) > SETTLEMENT_STRUCTURE_RADIUS
      ) {
        continue;
      }
      candidates.push({ structure, store });
    }
  }
  return candidates.sort((a, b) => {
    const aComplete = (a.structure.notes ?? "").includes("status=complete") ? 1 : 0;
    const bComplete = (b.structure.notes ?? "").includes("status=complete") ? 1 : 0;
    if (aComplete !== bComplete) return bComplete - aComplete;
    const runDifference = parseMineRuns(b.structure.notes) - parseMineRuns(a.structure.notes);
    if (runDifference !== 0) return runDifference;
    const aResume = parseMineResume(a.structure.notes) ? 1 : 0;
    const bResume = parseMineResume(b.structure.notes) ? 1 : 0;
    return bResume - aResume;
  })[0];
}

async function reachSharedMine(
  bot: Bot,
  anchor: { x: number; y: number; z: number } | undefined,
  signal: AbortSignal,
  onProgress: Parameters<Skill["execute"]>[3],
): Promise<SharedMineResult> {
  const remembered = findTeamMine(anchor);
  const fallback = bot.entity.position.floored();
  let entrance = remembered
    ? new Vec3(remembered.structure.x, remembered.structure.y, remembered.structure.z)
    : fallback;
  const store = remembered?.store ?? getBotMemoryStore(bot);
  const runs = parseMineRuns(remembered?.structure.notes);
  const resume = parseMineResume(remembered?.structure.notes);

  onProgress({
    skillName: "strip_mine",
    phase: remembered ? "Returning to shared mine" : "Establishing shared mine",
    progress: 0.01,
    message: remembered ? "Returning to the remembered mine entrance..." : "Surveying the shared mine entrance...",
    active: true,
  });

  if (!remembered && anchor) {
    const preferred = preferredMineEntrance(anchor);
    try {
      await safeGoto(bot, new goals.GoalNear(preferred.x, anchor.y, preferred.z, 6), 35_000);
    } catch {
      return {
        success: false,
        message: `Could not reach the planned shared mine area near (${preferred.x}, ${preferred.z}).`,
        entrance: { x: fallback.x, y: fallback.y, z: fallback.z },
        runs,
        store,
      };
    }
    if (signal.aborted) {
      return {
        success: false,
        message: "Shared mine establishment was aborted before reaching the entrance.",
        entrance: { x: fallback.x, y: fallback.y, z: fallback.z },
        runs,
        store,
      };
    }
    entrance = findSurfaceEntrance(bot, preferred, anchor.y) ?? bot.entity.position.floored();
  }

  const current = bot.entity.position.floored();
  // A completed mine record intentionally drops its one-time descent resume
  // coordinate. That does not mean an agent already working at Y=16 should
  // climb back to the surface entrance. The former "partial only" test sent
  // underground bots toward (105,65,203), where Mineflayer could not reverse
  // the staircase, causing 141 entrance failures in two hours.
  const alreadyInsideSharedMine =
    !!remembered && shouldResumeFromCurrentPosition(current, entrance);

  if (!alreadyInsideSharedMine) {
    try {
      await safeGoto(bot, new goals.GoalNear(entrance.x, entrance.y, entrance.z, 2), 35_000);
    } catch {
      return {
        success: false,
        message: `Could not reach the shared mine entrance at (${entrance.x}, ${entrance.y}, ${entrance.z}).`,
        entrance: { x: entrance.x, y: entrance.y, z: entrance.z },
        runs,
        store,
      };
    }
  }

  if (resume && !alreadyInsideSharedMine && bot.entity.position.distanceTo(resume) > 3) {
    onProgress({
      skillName: "strip_mine",
      phase: "Resuming shared mine",
      progress: 0.03,
      message: `Following the remembered shaft to (${resume.x}, ${resume.y}, ${resume.z})...`,
      active: true,
    });
    const resumeMoves = new Movements(bot);
    resumeMoves.canDig = true;
    resumeMoves.allow1by1towers = true;
    bot.pathfinder.setMovements(resumeMoves);
    try {
      await safeGoto(bot, new goals.GoalNear(resume.x, resume.y, resume.z, 2), 60_000);
    } catch {
      // If pathfinding advanced into the mine, preserve that progress and let
      // the normal descent phase continue from here. Fail only if it never
      // entered the shaft at all.
      if (bot.entity.position.y >= entrance.y - 5) {
        return {
          success: false,
          message: `Could not resume the shared mine shaft from (${entrance.x}, ${entrance.y}, ${entrance.z}) toward (${resume.x}, ${resume.y}, ${resume.z}).`,
          entrance: { x: entrance.x, y: entrance.y, z: entrance.z },
          runs,
          store,
        };
      }
    }
  }

  const stableEntrance = remembered ? entrance : bot.entity.position.floored();
  const alreadyComplete = remembered && !(remembered.structure.notes ?? "").toLowerCase().includes("partial");
  if (!alreadyComplete) {
    store?.addStructure(
      "mine",
      stableEntrance.x,
      stableEntrance.y,
      stableEntrance.z,
      mineNotes("partial", runs, resume),
    );
  }
  return {
    success: true,
    message: "Shared mine entrance reached.",
    entrance: { x: stableEntrance.x, y: stableEntrance.y, z: stableEntrance.z },
    runs,
    store,
  };
}

/**
 * Once below the entrance shaft and still inside the settlement mine's bounded
 * horizontal region, continuing from the current tunnel is safer than asking
 * pathfinder to reverse a hand-dug staircase.
 */
export function shouldResumeFromCurrentPosition(current: Vec3, entrance: Vec3): boolean {
  return current.y < entrance.y - 5 && Math.hypot(current.x - entrance.x, current.z - entrance.z) <= 96;
}

function findSurfaceEntrance(
  bot: Bot,
  preferred: { x: number; z: number },
  expectedY: number,
): Vec3 | undefined {
  const candidates: Vec3[] = [];
  for (let radius = 0; radius <= 6; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        for (let y = expectedY + 12; y >= expectedY - 12; y--) {
          const feet = new Vec3(preferred.x + dx, y, preferred.z + dz);
          const floor = bot.blockAt(feet.offset(0, -1, 0));
          const feetBlock = bot.blockAt(feet);
          const headBlock = bot.blockAt(feet.offset(0, 1, 0));
          if (
            floor &&
            floor.boundingBox === "block" &&
            !floor.name.endsWith("_leaves") &&
            !floor.name.endsWith("_log") &&
            !floor.name.endsWith("_planks") &&
            feetBlock?.name === "air" &&
            headBlock?.name === "air"
          ) {
            candidates.push(feet);
            break;
          }
        }
      }
    }
    if (candidates.length > 0) break;
  }
  return candidates.sort(
    (a, b) =>
      Math.hypot(a.x - preferred.x, a.z - preferred.z) -
        Math.hypot(b.x - preferred.x, b.z - preferred.z) ||
      Math.abs(a.y - expectedY) - Math.abs(b.y - expectedY),
  )[0];
}

function cardinalForRun(run: number): Vec3 {
  return [
    new Vec3(0, 0, -1),
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
  ][Math.abs(run) % 4];
}

/** Prefer an uncut wall over walking down an already-empty branch. */
function chooseFreshTunnelDirection(bot: Bot, run: number): Vec3 {
  const origin = bot.entity.position.floored();
  const ordered = Array.from({ length: 4 }, (_, offset) => cardinalForRun(run + offset));
  const score = (direction: Vec3) => {
    let solid = 0;
    for (let distance = 1; distance <= 4; distance++) {
      for (let y = 0; y <= 1; y++) {
        const block = bot.blockAt(origin.offset(direction.x * distance, y, direction.z * distance));
        if (!block) continue;
        if (block.name === "lava" || block.name === "water" || block.name === "bedrock") return -100;
        if (block.name !== "air") solid++;
      }
    }
    return solid;
  };
  return ordered.sort((a, b) => score(b) - score(a))[0] ?? cardinalForRun(run);
}

async function equipBestPickaxe(bot: Bot): Promise<void> {
  const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
  if (pick) await bot.equip(pick, "hand");
}

/**
 * bot.dig with a hard timeout. A bare bot.dig can hang indefinitely if the
 * block can't be reached/broken — this (plus an over-long descent timeout) made
 * strip_mine run to the 240s skill watchdog repeatedly, stalling the miner.
 * Fail fast (12s) and move on instead.
 */
async function digSafe(bot: Bot, b: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(b),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* not digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

/**
 * Mine any ore block exposed in the 3x3x3 shell around `pos` (the bot's cell),
 * then follow each vein a few blocks. This is what turns a blind tunnel into an
 * actually-productive one — ores in the walls used to be ignored entirely.
 */
async function mineExposedOre(bot: Bot, pos: Vec3): Promise<{ mined: number; ores: string[] }> {
  let mined = 0;
  const ores: string[] = [];
  const toCheck: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue; // skip the cleared path itself
        toCheck.push(pos.offset(dx, dy, dz));
      }
    }
  }
  for (const t of toCheck) {
    const b = bot.blockAt(t);
    if (!b || !b.name.endsWith("_ore")) continue;
    try {
      await equipBestPickaxe(bot);
      await digSafe(bot, b);
      mined++;
      ores.push(b.name);
      // Follow the vein a little so we don't leave most of it in the wall.
      mined += await followVein(bot, t, b.name, ores);
    } catch {
      /* out of reach or interrupted — skip */
    }
  }
  return { mined, ores };
}

async function followVein(bot: Bot, start: Vec3, oreName: string, ores: string[], cap = 8): Promise<number> {
  const seen = new Set<string>([start.toString()]);
  const queue: Vec3[] = [start];
  let extra = 0;
  while (queue.length && extra < cap) {
    const cur = queue.shift()!;
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const p = cur.offset(d[0], d[1], d[2]);
      if (seen.has(p.toString())) continue;
      seen.add(p.toString());
      const b = bot.blockAt(p);
      if (!b || b.name !== oreName) continue;
      if (bot.entity.position.distanceTo(p) > 4.3) continue; // only what we can reach without re-pathing
      try {
        await equipBestPickaxe(bot);
        await digSafe(bot, b);
        extra++;
        ores.push(b.name);
        queue.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return extra;
}

async function moveToPosition(bot: Bot, targetPos: Vec3): Promise<void> {
  try {
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    // Bounded: an unreachable GoalBlock here hung strip_mine (and the whole
    // bot) for ~13h. Race against a timeout that stops the pathfinder.
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(targetPos.x, targetPos.y, targetPos.z)),
      new Promise<void>((_, rej) =>
        setTimeout(() => {
          bot.pathfinder.stop();
          rej(new Error("moveToPosition timeout"));
        }, 8000),
      ),
    ]);
  } catch {
    // Fallback: manual walk
    try {
      await bot.lookAt(targetPos.offset(0.5, 1, 0.5));
      bot.setControlState("forward", true);
      await bot.waitForTicks(8);
      bot.setControlState("forward", false);
    } catch {
      /* ok */
    }
  }
}

async function placeTorchOnWall(bot: Bot, forward: Vec3): Promise<void> {
  const torch = bot.inventory.items().find((i) => i.name === "torch");
  if (!torch) return;

  // Left wall = 90 degrees from forward
  const wallDir = new Vec3(-forward.z, 0, forward.x);
  const wallBlock = bot.blockAt(bot.entity.position.floored().offset(wallDir.x, 1, wallDir.z));
  if (wallBlock && wallBlock.name !== "air" && wallBlock.name !== "water") {
    try {
      await bot.equip(torch, "hand");
      await bot.placeBlock(wallBlock, new Vec3(-wallDir.x, 0, -wallDir.z));
    } catch {
      /* ok */
    }
  }
}

function formatOres(ores: string[]): string {
  if (ores.length === 0) return "No ores this time — try a different direction!";
  const counts: Record<string, number> = {};
  for (const o of ores) counts[o] = (counts[o] || 0) + 1;
  return (
    "Found: " +
    Object.entries(counts)
      .map(([k, v]) => `${v}x ${k}`)
      .join(", ") +
    "!"
  );
}

function dirName(dir: Vec3): string {
  if (dir.z === -1) return "north";
  if (dir.z === 1) return "south";
  if (dir.x === -1) return "west";
  return "east";
}
