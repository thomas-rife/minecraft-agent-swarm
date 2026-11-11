import type { Bot } from "mineflayer";

/** Keep every skill on dry paths, including skills that create custom Movements. */
export function installLiquidAvoidance(bot: Bot): void {
  const pathfinder = bot.pathfinder;
  const setMovements = pathfinder.setMovements.bind(pathfinder);
  pathfinder.setMovements = (movements) => {
    for (const name of ["water", "flowing_water", "lava", "flowing_lava"]) {
      const block = bot.registry.blocksByName[name];
      if (block) movements.blocksToAvoid.add(block.id);
    }
    // Free-motion shortcuts can bypass the normal block-by-block path checks.
    movements.allowFreeMotion = false;
    movements.dontCreateFlow = true;
    setMovements(movements);
  };
  // Cover the initial pathfinder defaults as well as future replacements.
  pathfinder.setMovements(pathfinder.movements);
}
