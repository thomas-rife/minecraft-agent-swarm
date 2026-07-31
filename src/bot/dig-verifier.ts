import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";

function blockChanged(bot: Bot, block: Block): boolean {
  const current = bot.blockAt(block.position);
  return !current || current.name === "air" || current.name !== block.name;
}

async function waitForBlockChange(bot: Bot, block: Block, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (blockChanged(bot, block)) return true;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return blockChanged(bot, block);
}

/**
 * Dig a concrete coordinate and do not return until the server-observed block
 * state changes. Interrupted animations and client-only completion are retried
 * against a fresh Block instance at the same position.
 */
export async function digBlockVerified(bot: Bot, target: Block, timeoutMs = 12_000, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (blockChanged(bot, target)) return;
    const current = bot.blockAt(target.position);
    if (!current || current.name === "air") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bot.dig(current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DIG_ATTEMPT_TIMEOUT")), timeoutMs);
        }),
      ]);
    } catch {
      try {
        bot.stopDigging();
      } catch {
        // Best effort cleanup before retrying the exact coordinate.
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (await waitForBlockChange(bot, target, 1_500)) return;
  }

  throw new Error(
    `BLOCK_NOT_BROKEN:${target.name}@${target.position.x},${target.position.y},${target.position.z}`,
  );
}
