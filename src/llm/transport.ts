/** Ollama's raw /api/chat endpoint streams NDJSON by default. Force one JSON
 * response object so the HTTP transport can parse it atomically. */
export function nonStreamingChatPayload<T extends Record<string, unknown>>(request: T): T & { stream: false } {
  return { ...request, stream: false };
}
