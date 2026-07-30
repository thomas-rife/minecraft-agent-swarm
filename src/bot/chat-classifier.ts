/** Command confirmations are delivered through Mineflayer's chat event with a
 * username, but they are server output, not a player asking the bots a question. */
const SERVER_FEEDBACK_PATTERNS = [
  /^Gamerule\b/i,
  /^Set spawn\b/i,
  /^Teleported\b/i,
  /^Spread \d+ entit(?:y|ies)(?:\/entities)? around\b/i,
];

const LEGACY_BOT_USERNAMES = new Set(["atlas", "flora", "forge"]);

export function isServerFeedbackMessage(message: string): boolean {
  const normalized = message.trim();
  return SERVER_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isLegacyBotUsername(username: string): boolean {
  return LEGACY_BOT_USERNAMES.has(username.trim().toLowerCase());
}
