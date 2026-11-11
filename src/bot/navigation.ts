import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
const { goals, Movements } = pkg;

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const LIQUID_BLOCKS = new Set(["water", "lava"]);

export interface SurfaceState {
  hasDirectSky: boolean;
  skyKnown: boolean;
  ceilingDistance: number | null;
  inWater: boolean;
}

export interface SurfaceEscapeResult {
  escaped: boolean;
  attempted: boolean;
  method: "already_outside" | "normal_exit" | "controlled_dig" | "none";
  detail: string;
}

function isPassable(block: ReturnType<Bot["blockAt"]>): boolean {
  return !!block && !LIQUID_BLOCKS.has(block.name) && (AIR_BLOCKS.has(block.name) || block.boundingBox === "empty");
}

function flooredPosition(position: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
}

/**
 * A single source of truth for "can this position see open sky?".
 *
 * Elevation is deliberately irrelevant: a house at Y=77 is covered, while an
 * open ravine at Y=40 can have sky access. Null blocks mean the column is not
 * fully loaded, so callers get an explicit unknown result instead of a false
 * claim that the bot is underground.
 */
export function getSurfaceState(bot: Bot, position = bot.entity.position): SurfaceState {
  const floored = flooredPosition(position);
  const feet = bot.blockAt(floored);
  const head = bot.blockAt(floored.offset(0, 1, 0));
  const inWater = feet?.name === "water" || head?.name === "water";
  const game = bot.game as typeof bot.game & { minY?: number; height?: number };
  const worldTop = (game?.minY ?? -64) + (game?.height ?? 384) - 1;
  const startY = Math.floor(position.y) + 2;

  for (let y = startY; y <= worldTop; y++) {
    const block = bot.blockAt(new Vec3(Math.floor(position.x), y, Math.floor(position.z)));
    if (!block) {
      return { hasDirectSky: false, skyKnown: false, ceilingDistance: null, inWater };
    }
    if (!AIR_BLOCKS.has(block.name)) {
      return {
        hasDirectSky: false,
        skyKnown: true,
        ceilingDistance: y - Math.floor(position.y),
        inWater,
      };
    }
  }

  return { hasDirectSky: true, skyKnown: true, ceilingDistance: null, inWater };
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

/** Movement config for exploring on dry paths. */
export function explorerMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
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
 * - Cancels if bot hasn't moved more than 0.3 blocks in 5 seconds after a path exists
 * - `stallStartDelayMs` is retained as a fallback for lightweight test/mocked bots
 *   that do not emit path_update; real bots activate the timer from path_update
 */
export async function safeGoto(bot: Bot, goal: any, timeoutMs = 15000, stallStartDelayMs = 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let lastPos = bot.entity.position.clone();
    let stallTicks = 0;
    const supportsPathEvents = typeof bot.on === "function" && typeof bot.removeListener === "function";
    let stallActive = !supportsPathEvents && stallStartDelayMs === 0;
    let settled = false;
    const STALL_CHECK_MS = 1000;
    const STALL_THRESHOLD = 5; // 5 checks of 1s = 5 seconds without progress

    const onPathUpdate = (result: { path?: unknown[] }) => {
      if (!stallActive && Array.isArray(result?.path) && result.path.length > 0) {
        stallActive = true;
        lastPos = bot.entity.position.clone();
        stallTicks = 0;
      }
    };
    if (supportsPathEvents) bot.on("path_update", onPathUpdate as any);

    // Mock/test fallback. Real Mineflayer bots wait for a path_update containing
    // an actual path, so a slow A* calculation is never mislabeled "stuck".
    const stallDelayTimer =
      !supportsPathEvents && stallStartDelayMs > 0
        ? setTimeout(() => {
            stallActive = true;
            lastPos = bot.entity.position.clone();
            stallTicks = 0;
          }, stallStartDelayMs)
        : null;

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      if (stallDelayTimer) clearTimeout(stallDelayTimer);
      if (supportsPathEvents) bot.removeListener("path_update", onPathUpdate as any);
    };

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      const err = new Error(`Navigation timed out after ${(timeoutMs / 1000).toFixed(1)}s.`);
      err.name = "NavigationTimeout";
      finish(err);
      bot.pathfinder.stop();
    }, timeoutMs);

    const stallCheck = setInterval(() => {
      if (!stallActive) return;
      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);
      if (moved < 0.3) {
        stallTicks++;
        if (stallTicks >= STALL_THRESHOLD) {
          const err = new Error("A path was found, but the bot made no progress for 5 seconds.");
          err.name = "NavigationStalled";
          finish(err);
          bot.pathfinder.stop();
        }
      } else {
        stallTicks = 0;
      }
      lastPos = currentPos.clone();
    }, STALL_CHECK_MS);

    bot.pathfinder
      .goto(goal)
      .then(() => {
        finish();
      })
      .catch((err: any) => {
        finish(err);
      });
  });
}

function findOutdoorStandPositions(bot: Bot, radius = 32, maxResults = 48): Vec3[] {
  const origin = flooredPosition(bot.entity.position);
  const results: Vec3[] = [];
  const seen = new Set<string>();
  const yOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, 10, 12];

  for (let radiusNow = 1; radiusNow <= radius && results.length < maxResults; radiusNow++) {
    for (let dx = -radiusNow; dx <= radiusNow && results.length < maxResults; dx++) {
      for (let dz = -radiusNow; dz <= radiusNow && results.length < maxResults; dz++) {
        if (Math.abs(dx) !== radiusNow && Math.abs(dz) !== radiusNow) continue;
        for (const dy of yOffsets) {
          const stand = origin.offset(dx, dy, dz);
          const key = `${stand.x},${stand.y},${stand.z}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const feet = bot.blockAt(stand);
          const head = bot.blockAt(stand.offset(0, 1, 0));
          const ground = bot.blockAt(stand.offset(0, -1, 0));
          if (!feet || !head || !isPassable(feet) || !isPassable(head) || !ground || ground.boundingBox !== "block")
            continue;
          if (LIQUID_BLOCKS.has(ground.name)) continue;
          // Skylight is a cheap prefilter. Exact vertical scanning below avoids
          // treating light through glass or a partial roof as an outdoor exit.
          if (typeof feet.skyLight === "number" && feet.skyLight < 15) continue;
          if (!getSurfaceState(bot, stand).hasDirectSky) continue;
          results.push(stand);
          break;
        }
      }
    }
  }

  return results;
}

async function openNearbyExitDoors(bot: Bot): Promise<number> {
  if (typeof bot.findBlocks !== "function" || typeof bot.activateBlock !== "function") return 0;
  const positions = bot.findBlocks({
    matching: (block) =>
      (block.name.endsWith("_door") && block.name !== "iron_door") ||
      (block.name.endsWith("_fence_gate") && !block.name.startsWith("iron_")),
    maxDistance: 6,
    count: 16,
  });
  const blocks = positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is NonNullable<typeof block> => !!block)
    .filter((block) => block.position.distanceTo(bot.entity.position) <= 5)
    .filter((block) => {
      const properties = block.getProperties();
      return properties.open !== true && properties.open !== "true" && properties.half !== "upper";
    })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

  let opened = 0;
  for (const block of blocks.slice(0, 4)) {
    try {
      await bot.activateBlock(block);
      opened++;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch {
      // Another bot may have changed it, or it may be just outside reach.
    }
  }
  return opened;
}

const NATURAL_ESCAPE_BLOCKS = new Set([
  "stone",
  "deepslate",
  "dirt",
  "grass_block",
  "coarse_dirt",
  "rooted_dirt",
  "podzol",
  "mycelium",
  "clay",
  "mud",
  "moss_block",
  "tuff",
  "calcite",
  "dripstone_block",
  "granite",
  "diorite",
  "andesite",
]);

function mayBreakForEscape(name: string): boolean {
  return NATURAL_ESCAPE_BLOCKS.has(name) || name.endsWith("_leaves") || name.endsWith("_ore");
}

function controlledEscapeMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = true;
  moves.canOpenDoors = true; // Mineflayer currently applies this to fence gates.
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  moves.maxDropDown = 3;
  moves.allowParkour = false;
  moves.dontCreateFlow = true;
  moves.dontMineUnderFallingBlock = true;
  moves.exclusionAreasBreak.push((block) => (mayBreakForEscape(block.name) ? 0 : 100));
  return moves;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Leave a roofed/enclosed position in escalating, player-like stages:
 *  1. open a nearby wooden door/gate and path to any known outdoor stand cell
 *  2. if no non-destructive path exists, dig only natural terrain toward one
 *  3. for a shallow natural ceiling with no scanned outdoor cell, climb a
 *     short staircase by targeting a higher Y (never tower straight upward)
 */
export async function escapeToSurface(bot: Bot, radius = 32): Promise<SurfaceEscapeResult> {
  const initial = getSurfaceState(bot);
  if (initial.hasDirectSky) {
    return { escaped: true, attempted: false, method: "already_outside", detail: "Already has direct sky access." };
  }

  const outdoorPositions = findOutdoorStandPositions(bot, radius);
  const outdoorGoal =
    outdoorPositions.length > 0
      ? new goals.GoalCompositeAny(
          outdoorPositions.map((position) => new goals.GoalBlock(position.x, position.y, position.z)),
        )
      : null;
  let lastError = initial.skyKnown ? "No non-destructive exit was reachable." : "Sky column was not fully loaded.";

  if (outdoorGoal) {
    const opened = await openNearbyExitDoors(bot);
    const moves = explorerMoves(bot);
    moves.canOpenDoors = true;
    bot.pathfinder.setMovements(moves);
    try {
      await safeGoto(bot, outdoorGoal, 20000);
      if (getSurfaceState(bot).hasDirectSky) {
        return {
          escaped: true,
          attempted: true,
          method: "normal_exit",
          detail:
            opened > 0 ? `Opened ${opened} nearby exit block(s) and walked outside.` : "Walked to an outdoor exit.",
        };
      }
      lastError = "Reached the exit goal but still had no direct sky access.";
    } catch (err) {
      lastError = describeError(err);
    }
  }

  const digGoal =
    outdoorGoal ??
    (initial.skyKnown && initial.ceilingDistance !== null && initial.ceilingDistance <= 12
      ? new goals.GoalY(Math.floor(bot.entity.position.y) + Math.max(3, initial.ceilingDistance + 2))
      : null);
  if (!digGoal) {
    bot.pathfinder.setMovements(safeMoves(bot));
    return { escaped: false, attempted: true, method: "none", detail: lastError };
  }

  bot.pathfinder.setMovements(controlledEscapeMoves(bot));
  try {
    await safeGoto(bot, digGoal, 25000);
    if (getSurfaceState(bot).hasDirectSky) {
      return {
        escaped: true,
        attempted: true,
        method: "controlled_dig",
        detail: "Reached open sky using a protected natural-terrain escape route.",
      };
    }
    lastError = "Controlled escape moved upward but did not reach open sky.";
  } catch (err) {
    lastError = describeError(err);
  } finally {
    bot.pathfinder.setMovements(safeMoves(bot));
  }

  return { escaped: false, attempted: true, method: "controlled_dig", detail: lastError };
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
      const p = drop.position.floored();
      await safeGoto(bot, new goals.GoalBlock(p.x, p.y, p.z), 6000);
      await new Promise((r) => setTimeout(r, 400)); // pickup tick
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
