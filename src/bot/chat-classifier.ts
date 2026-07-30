/** Command confirmations are delivered through Mineflayer's chat event with a
 * username, but they are server output, not a player asking the bots a question. */
const SERVER_FEEDBACK_PATTERNS = [
  /^Gamerule\b/i,
  /^Set spawn\b/i,
  /^Teleported\b/i,
  /^Spread \d+ entit(?:y|ies)(?:\/entities)? around\b/i,
];

export function isServerFeedbackMessage(message: string): boolean {
  const normalized = message.trim();
  return SERVER_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}
