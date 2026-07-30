import test from "node:test";
import assert from "node:assert/strict";
import { nonStreamingChatPayload } from "./transport.js";

test("raw Ollama chat requests explicitly disable NDJSON streaming", () => {
  const request = { model: "qwen2.5:3b", messages: [{ role: "user", content: "plan" }] };
  const payload = nonStreamingChatPayload(request);

  assert.equal(payload.stream, false);
  assert.equal("stream" in request, false);
  assert.equal(JSON.parse(JSON.stringify(payload)).stream, false);
});
