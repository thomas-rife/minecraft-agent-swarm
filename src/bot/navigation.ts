import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { getSharedStructure } from "../world/registry.js";

interface NavigationRecoveryRequest {
  reason: string;
  requestedAt: number;
  causes: string[];
}

const recoveryRequests = new WeakMap<Bot, NavigationRecoveryRequest>();

export function consumeNavigationRecoveryRequest(bot: Bot): NavigationRecoveryRequest | null {
  const request = recoveryRequests.get(bot) ?? null;
  recoveryRequests.delete(bot);
  return request;
}

/** Create safe movement defaults — no digging, no block placement, just walk/jump */
export function safeMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  // Fall safety for the TEAM-WIDE default movement (go_to + every post-action
  // nav). The explorerMoves-only cap missed this path — bots still fell during
  // go_to, incl. into the mined-out pits around the base. Cap drop height (no
  // fall damage) and forbid parkour leaps so the pathfinder never routes over
  // a dangerous drop. Navigation caution, not a cheat.
  moves.maxDropDown = 3;
  moves.allowParkour = false;
  return moves;
}

/** Movement config for exploring — allows swimming across water (allowFreeMotion=true) */
export function explorerMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = true; // needed for pathfinder to route through water
  moves.scafoldingBlocks = [];
  // Fall safety: Atlas the explorer was 25 of 31 fall deaths over the week,
  // roaming off cliffs/ledges. Cap how far the pathfinder will drop (default
  // lets it take 4-block fall-damage drops) and forbid parkour leaps across
  // gaps — both routinely walked him off high terrain. Navigation caution,
  // not a cheat.
  moves.maxDropDown = 3; // 3 blocks = no fall damage
  moves.allowParkour = false;
  return moves;
}

/**
 * Wraps pathfinder.goto with a timeout and stall detection.
 * - Times out after `timeoutMs` (default 15s)
 * - Cancels if bot hasn't moved more than 0.3 blocks in 5 seconds AFTER movement begins
 * - `stallStartDelayMs`: grace period before stall detection activates (use when thinkTimeout is high)
 */
export class NavigationRecoveryError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly causes: string[],
  ) {
    super(message);
    this.name = "NavigationRecoveryError";
  }
}

function relaxedGoal(goal: any, extraRadius: number): any {
  if (!Number.isFinite(goal?.x) || !Number.isFinite(goal?.z)) return goal;
  if (Number.isFinite(goal?.y)) {
    const currentRange = Number(goal.range ?? goal.radius ?? 1);
    return new goals.GoalNear(goal.x, goal.y, goal.z, Math.max(1, currentRange + extraRadius));
  }
  return new goals.GoalXZ(goal.x, goal.z);
}

async function recoveryNudge(bot: Bot): Promise<void> {
  try {
    bot.pathfinder.stop();
    bot.setControlState("back", true);
    bot.setControlState("jump", true);
    await new Promise((resolve) => setTimeout(resolve, 450));
  } finally {
    for (const control of ["back", "jump", "forward", "left", "right"] as const) {
      try {
        bot.setControlState(control, false);
      } catch {
        // disconnected during recovery
      }
    }
  }
}

/** Staged recovery: normal route, fresh replan with wider tolerance, then final alternate approach. */
export async function safeGoto(bot: Bot, goal: any, timeoutMs = 15000, stallStartDelayMs = 0): Promise<void> {
  if (
    ("x" in (goal ?? {}) && !Number.isFinite(goal.x)) ||
    ("y" in (goal ?? {}) && !Number.isFinite(goal.y)) ||
    ("z" in (goal ?? {}) && !Number.isFinite(goal.z))
  ) {
    throw new NavigationRecoveryError("INVALID_NAVIGATION_TARGET", 0, ["Target contains a non-finite coordinate."]);
  }
  const executionBudget = Math.max(600, timeoutMs - 900); // reserve two 450ms recovery nudges
  const budgets = [0.5, 0.3, 0.2].map((fraction) => Math.max(200, Math.floor(executionBudget * fraction)));
  const candidates = [goal, relaxedGoal(goal, 1), relaxedGoal(goal, 3)];
  const causes: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    try {
      await safeGotoAttempt(bot, candidates[index], budgets[index], Math.min(stallStartDelayMs, budgets[index] / 2));
      return;
    } catch (error) {
      causes.push(error instanceof Error ? error.message : String(error));
      if (index < candidates.length - 1) await recoveryNudge(bot);
    }
  }
  throw new NavigationRecoveryError("Navigation failed after staged recovery.", candidates.length, causes);
}

async function safeGotoAttempt(bot: Bot, goal: any, timeoutMs: number, stallStartDelayMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let lastPos = bot.entity.position.clone();
    let stallTicks = 0;
    let bestDistance = goalDistance(bot, goal);
    let goalProgressTicks = 0;
    let waterTicks = 0;
    const repeatedPositions = new Map<string, number>();
    let stallActive = stallStartDelayMs === 0;
    const STALL_CHECK_MS = 1000;
    const STALL_THRESHOLD = 5; // 5 checks of 1s = 5 seconds without progress

    // Delay stall detection to let pathfinder finish computing the path first
    const stallDelayTimer =
      stallStartDelayMs > 0
        ? setTimeout(() => {
            stallActive = true;
            lastPos = bot.entity.position.clone(); // fresh baseline after think phase
            stallTicks = 0;
          }, stallStartDelayMs)
        : null;

    const timeout = setTimeout(() => {
      clearInterval(stallCheck);
      if (stallDelayTimer) clearTimeout(stallDelayTimer);
      bot.pathfinder.stop();
      reject(new Error("Navigation timed out — goal may be unreachable."));
    }, timeoutMs);

    const stallCheck = setInterval(() => {
      if (!stallActive) return;
      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);
      const distance = goalDistance(bot, goal);
      if (distance !== null && (bestDistance === null || distance < bestDistance - 0.15)) {
        bestDistance = distance;
        goalProgressTicks = 0;
      } else if (distance !== null) {
        goalProgressTicks++;
      }
      const positionKey = `${Math.floor(currentPos.x * 2)},${Math.floor(currentPos.y * 2)},${Math.floor(currentPos.z * 2)}`;
      const repeats = (repeatedPositions.get(positionKey) ?? 0) + 1;
      repeatedPositions.set(positionKey, repeats);
      const feet = bot.blockAt(currentPos)?.name;
      const head = bot.blockAt(currentPos.offset(0, 1, 0))?.name;
      waterTicks = feet === "water" || head === "water" ? waterTicks + 1 : 0;
      if (moved < 0.3 || repeats >= 4 || goalProgressTicks >= 10) {
        stallTicks++;
        if (stallTicks >= STALL_THRESHOLD) {
          clearTimeout(timeout);
          clearInterval(stallCheck);
          if (stallDelayTimer) clearTimeout(stallDelayTimer);
          bot.pathfinder.stop();
          reject(new Error(`NO_POSITIONAL_PROGRESS distance=${distance ?? "unknown"} waterSeconds=${waterTicks}`));
        }
      } else {
        stallTicks = 0;
      }
      lastPos = currentPos.clone();
    }, STALL_CHECK_MS);

    bot.pathfinder
      .goto(goal)
      .then(() => {
        clearTimeout(timeout);
        clearInterval(stallCheck);
        if (stallDelayTimer) clearTimeout(stallDelayTimer);
        resolve();
      })
      .catch((err: any) => {
        clearTimeout(timeout);
        clearInterval(stallCheck);
        if (stallDelayTimer) clearTimeout(stallDelayTimer);
        reject(err);
      });
  });
}

function goalDistance(bot: Bot, goal: any): number | null {
  if (!Number.isFinite(goal?.x) || !Number.isFinite(goal?.z)) {
    return Number.isFinite(goal?.y) ? Math.abs(bot.entity.position.y - goal.y) : null;
  }
  return bot.entity.position.distanceTo(
    new Vec3(goal.x, Number.isFinite(goal?.y) ? goal.y : bot.entity.position.y, goal.z),
  );
}

/** Return to a verified entrance/safe point, with local dig-out as the fallback. */
export async function recoverToSafePoint(bot: Bot): Promise<boolean> {
  const entries = [
    getSharedStructure(`mine-entrance-${bot.username}`),
    getSharedStructure(`safe-point-${bot.username}`),
  ]
    .filter((entry) => entry?.status === "verified" && entry.position)
    .sort((a, b) => {
      const ap = a!.position!;
      const bp = b!.position!;
      return (
        bot.entity.position.distanceTo(new Vec3(ap.x, ap.y, ap.z)) -
        bot.entity.position.distanceTo(new Vec3(bp.x, bp.y, bp.z))
      );
    });
  const destination = entries[0]?.position;
  if (destination) {
    const moves = new Movements(bot);
    moves.canDig = true;
    moves.allow1by1towers = bot.inventory
      .items()
      .some((item) => item.name.endsWith("_planks") || ["dirt", "cobblestone", "stone"].includes(item.name));
    moves.maxDropDown = 1;
    bot.pathfinder.setMovements(moves);
    try {
      await safeGoto(bot, new goals.GoalNear(destination.x, destination.y, destination.z, 2), 35_000);
      return bot.entity.position.distanceTo(new Vec3(destination.x, destination.y, destination.z)) <= 3;
    } catch {
      // Continue with local geometry recovery.
    }
  }
  return digOutIfStuck(bot);
}

/**
 * Walk over nearby dropped items so they enter the inventory. Digging a block
 * only spawns a drop — without this, bots "gather" wood that stays on the
 * ground (the root cause of phantom inventory reports).
 */
export async function collectNearbyDrops(bot: Bot, radius = 8, maxMs = 8000): Promise<void> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 800)); // let drops finish falling
  const tried = new Set<number>();
  while (Date.now() - start < maxMs) {
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === "item" && !tried.has(e.id) && e.position.distanceTo(bot.entity.position) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    tried.add(drop.id);
    try {
      // Stand exactly on the drop's block — GoalNear(r=1) can stop just outside
      // the pickup radius. An unreachable drop falls through to the next one.
      await Promise.race([
        bot.collectBlock.collect(drop, { ignoreNoPath: true }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("drop pickup timeout")), 6500)),
      ]);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      // Drop lodged in the canopy? Punch out the leaf it rests on/in so it
      // falls to walkable ground, then allow one retry. Leaf-lodged drops were
      // the top wood-loss cause (78% of chopped logs never collected).
      try {
        const at = bot.blockAt(drop.position.floored());
        const under = bot.blockAt(drop.position.floored().offset(0, -1, 0));
        const leaf = [at, under].find((b) => b && b.name.includes("leaves"));
        if (leaf && bot.entity.position.distanceTo(leaf.position) < 5) {
          await Promise.race([
            bot.dig(leaf),
            new Promise<void>((_, rej) =>
              setTimeout(() => {
                try {
                  bot.stopDigging();
                } catch {
                  /* not digging */
                }
                rej(new Error("leaf dig timeout"));
              }, 5000),
            ),
          ]);
          tried.delete(drop.id); // it can fall now — retry on a later pass
          await new Promise((r) => setTimeout(r, 600)); // let it fall
        }
      } catch {
        /* leaf out of reach — leave the drop */
      }
      continue;
    }
  }
}

/**
 * Self-extract from a hole the bot dug itself into. Bots with non-digging
 * movement get boxed into 1-wide pits (4 walls at head height) and soft-lock.
 * This is NOT a teleport cheat — the bot digs its own staircase out with its
 * hands, exactly like a player would. Returns true if it attempted an escape.
 */
export async function digOutIfStuck(bot: Bot): Promise<boolean> {
  const pos = bot.entity.position;
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let walls = 0;
  for (const [dx, dz] of dirs) {
    const head = bot.blockAt(pos.offset(dx, 1, dz));
    if (head && head.boundingBox === "block") walls++;
  }
  if (walls < 3) return false; // not boxed in — nothing to do

  // Dig a staircase up and out using digging-capable movement (the bot's own
  // pickaxe/hands), then walk clear. Targets ~3 blocks up to clear the pit rim.
  const moves = new Movements(bot);
  moves.canDig = true;
  moves.allow1by1towers = true;
  bot.pathfinder.setMovements(moves);
  try {
    await safeGoto(bot, new goals.GoalY(Math.floor(pos.y) + 3), 15000);
    // then move laterally onto open ground away from the pit
    await safeGoto(bot, new goals.GoalNear(Math.floor(pos.x) + 5, Math.floor(pos.y) + 3, Math.floor(pos.z), 2), 15000);
  } catch {
    /* best effort — try again next cycle */
  } finally {
    bot.pathfinder.setMovements(safeMoves(bot));
  }
  return true;
}

/**
 * Anti-drown self-rescue. ~90% of all deaths were bots drowning in a water pit
 * by the stash: they path in, can't climb out, and drown. When the bot's HEAD
 * is submerged, swim up (jump) for air and head for the nearest dry shore. This
 * is the bot's own swimming — self-preservation, not a cheat. Called on a fast
 * timer from the brain. Returns true if it took rescue action.
 */
export async function escapeWaterIfDrowning(bot: Bot): Promise<boolean> {
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  if (!head || head.name !== "water") return false; // head not submerged → breathing fine

  // When air is actually running out, this reflex must WIN the controls: the
  // pathfinder re-asserts movement every tick, so 1.2s rescue bursts lost the
  // tug-of-war against an underwater goal (Blade drowned 16x in one run
  // mining lake-bed iron — rescued, shoved back down, drowned). Stop the
  // pathfinder + any dig before swimming; the brain re-plans afterwards.
  const air = bot.oxygenLevel ?? 20;
  if (air < 12) {
    try {
      bot.pathfinder.stop();
    } catch {
      /* best effort */
    }
    try {
      bot.stopDigging();
    } catch {
      /* wasn't digging */
    }
  }

  // Find the nearest dry shore: a solid block with air above, scanned over fixed
  // offset rings (NOT a findBlock predicate that calls blockAt — that silently
  // matches nothing). Prefer the closest.
  const base = bot.entity.position.floored();
  let shore = null as ReturnType<typeof bot.blockAt> | null;
  for (let r = 1; r <= 8 && !shore; r++) {
    for (let dx = -r; dx <= r && !shore; dx++) {
      for (let dz = -r; dz <= r && !shore; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // ring perimeter only
        for (let dy = -1; dy <= 1; dy++) {
          const b = bot.blockAt(base.offset(dx, dy, dz));
          const above = bot.blockAt(base.offset(dx, dy + 1, dz));
          if (b && b.boundingBox === "block" && b.name !== "water" && above && above.name === "air") {
            shore = b;
            break;
          }
        }
      }
    }
  }

  try {
    bot.setControlState("jump", true); // swim upward toward the surface for air
    if (shore && shore.position) {
      await bot.lookAt(shore.position.offset(0.5, 1.5, 0.5));
      bot.setControlState("forward", true);
    }
    await bot.waitForTicks(24); // ~1.2s of swimming up/out; the timer re-runs if still under
  } catch {
    /* best effort — timer retries */
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("jump", false);
  }
  return true;
}
