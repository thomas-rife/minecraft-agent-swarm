/**
 * Infer whether a string action result represents useful completion.
 *
 * Action executors currently return human-readable strings rather than a
 * structured `{ success, message }` value. Keep this classifier conservative:
 * explicit/partial successes are recognized first, explicit failures win over
 * generic success verbs, and unknown messages are failures.
 */

const SUCCESS_WITH_WARNING_PATTERNS: RegExp[] = [
  // These actions made useful progress even when the message includes a
  // warning such as "couldn't fit" or "couldn't place second".
  /^Deposited [1-9]\d* items?\b/i,
  /^Withdrew [1-9]\d*x?\b/i,
  /^Placed 1 chest at stash\b/i,
  /^House partially built \([1-9]\d*\/\d+ blocks\)/i,
  /^Strip mine complete!\b/i,
  /^Shared mine descent advanced\b/i,
  /^Usable farm shore confirmed\b/i,
  /^Hit bedrock at step \d+! Mined \d+ blocks\./i,
  /^Stash already (?:exists|set up)\b/i,
  /^House already built\b/i,
  /^Already here!$/i,
  // The text after these prefixes is user/model-controlled and may contain
  // words such as "need", "stuck", or "failed". The action itself still
  // succeeded, so classify the fixed executor prefix before scanning content.
  /^(?:Said|Replied):\s*\S/i,
  /^Generated skill\b/i,
  /^Gave [1-9]\d*x?\b.*\bdelivery confirmed\b/i,
];

const FAILURE_PATTERNS: RegExp[] = [
  /^(?:Action failed|Blocked:|Unknown action:)/i,
  /\b(?:failed|failure|crashed|timed out|timeout|stuck|unreachable|aborted|interrupted|not allowed)\b/i,
  /^(?:Couldn't|Could not|Can't|Cannot|Unable|Didn't|Nothing to|Not enough|Missing|Need(?:ed)?\b|No\b|Invalid\b)/i,
  /^(?:Only crafted|Still missing|Could only get|Already running skill|All stash chests are full)\b/i,
  /^(?:That's \d+ blocks away|You don't have|What block|Just vibing|Ran in a random direction)\b/i,
  /^(?:Chased|Lost|Tried to withdraw|Bed disappeared|Have wool but no)\b/i,
  /\bneeds? (?:an?|the|to|\d+|more)\b/i,
  /\bdelivery NOT confirmed\b/i,
  /\bis RETIRED\b/i,
];

const SUCCESS_PATTERNS: RegExp[] = [
  /\bcomplete(?:d)?\b/i,
  /\bharvested\b/i,
  /\bbuilt\b/i,
  /\bplanted\b/i,
  /\bsmelted\b/i,
  /\bsmelting done\b/i,
  /\bcrafted\b/i,
  /\barrived\b/i,
  /\bgathered\b/i,
  /\bmined\b/i,
  /\bcaught\b/i,
  /\blit\b/i,
  /\bbridged\b/i,
  /\bchopped\b/i,
  /\bkilled\b/i,
  /\bdefeated\b/i,
  /^Hunted\b.*(?:collected|drops collected)\b/i,
  /\bate\b/i,
  /\bexplored\b/i,
  /\bsurveyed\b/i,
  /\bestablished\b/i,
  /\bsecured\b/i,
  /\bplaced\b/i,
  /\bfished\b/i,
  /\b(?:sleep|sleeping|slept)\b/i,
  /\bzzz\b/i,
  /^Fled from\b/i,
  /^All materials gathered!$/i,
  /^Stash bootstrapped!/i,
  /^Gear crafted!/i,
  /^Farm cycle continues!/i,
  /^Fishing trip done!/i,
];

export function actionResultSucceeded(result: string): boolean {
  const message = result.trim();
  if (!message) return false;

  if (SUCCESS_WITH_WARNING_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }

  if (FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  return SUCCESS_PATTERNS.some((pattern) => pattern.test(message));
}
