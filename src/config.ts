import "dotenv/config";

export const config = {
  mc: {
    host: process.env.MC_HOST || "localhost",
    port: parseInt(process.env.MC_PORT || "25565"),
    username: process.env.MC_USERNAME || "AIBot",
    version: process.env.MC_VERSION || "1.21.4",
    auth: (process.env.MC_AUTH || "offline") as "offline" | "microsoft",
  },
  ollama: {
    host: process.env.OLLAMA_HOST || "http://localhost:11434",
    // qwen3.6:35b-a3b is an MoE (~3B active params): 35B-class quality at ~150 tok/s
    // on a single 32GB GPU. One model for both strategic and fast paths avoids
    // VRAM eviction thrash between two resident models.
    model: process.env.OLLAMA_MODEL || "qwen3.6:35b-a3b",
    fastModel: process.env.OLLAMA_FAST_MODEL || process.env.OLLAMA_MODEL || "qwen3.6:35b-a3b",
    contextLength: parseInt(process.env.OLLAMA_CONTEXT_LENGTH || "32768"),
    requestTimeoutMs: parseInt(process.env.OLLAMA_REQUEST_TIMEOUT_MS || "90000"),
    maxQueueWaitMs: parseInt(process.env.OLLAMA_MAX_QUEUE_WAIT_MS || "15000"),
  },
  twitch: {
    channel: process.env.TWITCH_CHANNEL || "",
    botUsername: process.env.TWITCH_BOT_USERNAME || "",
    oauthToken: process.env.TWITCH_OAUTH_TOKEN || "",
    enabled: !!process.env.TWITCH_CHANNEL,
  },
  bot: {
    name: process.env.BOT_NAME || "Milo",
    decisionIntervalMs: parseInt(process.env.BOT_DECISION_INTERVAL_MS || "500"),
    chatCooldownMs: parseInt(process.env.BOT_CHAT_COOLDOWN_MS || "3000"),
    /**
     * When false (default): NO interventions that act for the bots or hand them
     * unearned resources — deterministic skill overrides, survival rations, and
     * safety teleports are all disabled. The LLM decides everything and the
     * bots use only their own skills/navigation. Set ALLOW_INTERVENTIONS=true
     * to re-enable the scaffolding (e.g. for reliability demos).
     */
    allowInterventions: process.env.ALLOW_INTERVENTIONS === "true",
    /** Idle interval for event-driven brain — how often to re-plan when nothing happens. */
    idleIntervalMs: parseInt(process.env.BOT_IDLE_INTERVAL_MS || "10000"),
    /** Enable the critic step after each action (uses an extra LLM call per action). */
    criticEnabled: process.env.BOT_CRITIC_ENABLED !== "false",
    /** Unverified Voyager/generated routines stay unavailable until explicitly opted in. */
    dynamicSkillsEnabled: process.env.ENABLE_DYNAMIC_SKILLS === "true",
  },
  multiBot: {
    // The default swarm is all three roster members; set false for Milo-only mode.
    enabled: process.env.ENABLE_MULTI_BOT !== "false",
    count: parseInt(process.env.BOT_COUNT || "3"),
  },
};
