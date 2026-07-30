# Minecraft Agent Swarm

A self-improving swarm of autonomous AI agents that play Minecraft together, powered by local LLMs (Ollama) with a hybrid skill system: hand-crafted TypeScript skills, 57 Voyager-style JavaScript skills, and dynamic skill generation at runtime.

The three bots divide exploration, farming, mining, building, and combat priorities while coordinating through shared context and a central resource stash.

**The bots earn everything in-game.** No item handouts, no teleport rescues, no scripted shortcuts that act on their behalf — progress comes from making the *agents* more capable (better prompts, skills, and action logic), not from cheating for them. Self-improvement is the whole point.

Designed for live streaming: includes a Mission Control dashboard, per-bot 3D viewers, OBS overlays, TTS, and Twitch integration.

> Formerly `mineflayer-chatgpt`. Renamed to reflect what it became: a multi-agent swarm running on local models, not a single ChatGPT bot.

📖 **Project page, devlogs, and live scoreboard stats:** [jesseweigel.com/workshop/minecraft-agent-swarm](https://jesseweigel.com/workshop/minecraft-agent-swarm)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              Event-Driven Brain (per bot, src/bot/brain.ts)   │
│  events: idle(10s)→strategic · hostiles/damage→reactive ·     │
│  action done→critic · chat→reply                              │
│  World Context + Team Bulletin + TECH TREE → LLM → Action     │
│            (single Ollama MoE: gpt-oss:20b)                   │
└────────────────────────┬─────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   TypeScript Skills  Voyager Skills  Neural Combat
   (build_house,      (57 JS skills   (Python TCP server
    craft_gear,        in vm sandbox)  heuristic policy)
    strip_mine, …)
          │              │              │
          └──────────────┴──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Per-Bot Memory (.json)  │
          │  (structures, deaths, ores, │
          │   skill success rates)      │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Team Bulletin (shared)  │
          │  (each bot's action, pos,   │
          │   thought — injected into   │
          │   every LLM prompt)         │
          └─────────────────────────────┘
```

### Bot Team

| Bot | Role | Specialty | Leash Radius |
|-----|------|-----------|-------------|
| **Milo** | Explorer / Guard | Scouts terrain, discovers resources, protects teammates | 500 blocks |
| **Ava** | Farmer / Crafter | Grows crops, crafts supplies, keeps the base stocked | 150 blocks |
| **Peter** | Miner / Builder | Mines and smelts resources, expands the shared base | 250 blocks |

Each bot has its own personality, allowed actions, allowed skills, memory file, and leash radius. They share a central stash of chests for resource exchange and see each other's status via the Team Bulletin.

The canonical shared home base and stash anchor is `(116, 66, 256)`. Farm and other work-site coordinates are not preconfigured: bots select them from observed terrain and share them only after world verification.

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Brain (decision engine) | `src/bot/brain.ts` | Event-driven: strategic/reactive/critic/chat handlers |
| Bot lifecycle | `src/bot/index.ts` | Connection, spawn safety, plugin loading |
| Scoreboard | `src/bot/scoreboard.ts` | Per-session metrics + tech milestones → `logs/sessions/` |
| Curriculum | `src/bot/curriculum.ts` | Inventory-driven tech-tree next-goal injection |
| Compact diagnostics | `src/util/diagnostic-log.ts` | Failures/crashes plus aggregated outcomes in `logs/diagnostics/` |
| Skill reliability | `src/skills/reliability.ts` | Team-wide success rates; auto-retires broken skills |
| Trajectory capture | `src/bot/trajectory.ts` | Optional full prompt data for fine-tuning (off by default) |
| Navigation helpers | `src/bot/navigation.ts` | safeGoto, drop collection, movement presets |
| Role configs | `src/bot/role.ts` | Per-bot personality, actions, skills, leash |
| Team bulletin | `src/bot/bulletin.ts` | Shared status between bots |
| World perception | `src/bot/perception.ts` | Builds context string for LLM |
| Action executor | `src/bot/actions.ts` | Routes JSON actions to implementations |
| LLM client | `src/llm/index.ts` | Ollama API with retry + JSON repair |
| Skill executor | `src/skills/executor.ts` | Runs skills with abort support |
| Voyager loader | `src/skills/dynamic-loader.ts` | Runs JS skills in vm sandbox |
| Skill generator | `src/skills/generator.ts` | LLM generates new JS skills |
| Memory | `src/bot/memory.ts` | Per-bot persistent JSON |
| Stash actions | `src/skills/stash.ts` | Deposit/withdraw from shared chests |
| Neural combat | `src/neural/combat.ts` | 50ms tick loop using TCP server |
| Neural server | `neural_server.py` | Python heuristic/VPT policy server |
| Dashboard | `src/stream/dashboard.ts` | Mission Control on port 3010 |
| Stream viewer | `src/stream/viewer.ts` | Per-bot prismarine-viewer |
| OBS overlay | `src/stream/overlay.ts` | Per-bot WebSocket overlay for OBS |
| TTS | `src/stream/tts.ts` | Text-to-speech for bot thoughts |
| Safety filter | `src/safety/filter.ts` | Blocks harmful chat/thoughts |

---

## Setup

### Requirements

- Node.js 20+
- [Ollama](https://ollama.ai) with `gpt-oss:20b` pulled (one MoE model serves all decision types — chosen by A/B trial over qwen3.6 and nemotron-3-nano for structured-output quality and speed)
- Minecraft Java Edition server (1.21.4) with 5+ player slots
- Python 3.10+ (for neural combat server)

### Install

```bash
git clone https://github.com/JesseRWeigel/minecraft-agent-swarm.git
cd minecraft-agent-swarm
npm install
pip install -r requirements.txt   # for neural server
```

### Configure

Create a `.env` file:

```env
# Minecraft server
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=Milo
MC_USERNAME_2=Ava
MC_USERNAME_3=Peter
MC_VERSION=1.21.4
MC_AUTH=offline

# LLM (Ollama)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gpt-oss:20b       # MoE: ~3.6B active params, ~200 tok/s on a 32GB GPU
OLLAMA_FAST_MODEL=gpt-oss:20b  # Same model — avoids VRAM eviction thrash between two residents
# Reasoning-native models (gpt-oss) run with think:"low"; qwen needs think:false (auto-detected in src/llm)

# Bot identity
BOT_NAME=Milo
BOT_IDLE_INTERVAL_MS=10000   # How often the brain re-plans when nothing is happening
BOT_CHAT_COOLDOWN_MS=3000

# Multi-bot mode
ENABLE_MULTI_BOT=true
BOT_COUNT=3                   # 1=Milo, 2=+Ava, 3=+Peter

# Long-run logging
DIAGNOSTIC_LOG_ENABLED=true
DIAGNOSTIC_SUMMARY_MINUTES=5  # Routine outcomes are aggregated
DIAGNOSTIC_MAX_MB=5           # Files rotate instead of growing forever
TRAJECTORY_LOG_MODE=off       # off | failures | all (full prompts are large)

# Autonomy
ALLOW_INTERVENTIONS=false     # false (default): LLM decides everything, no cheating.
                              # true: re-enable deterministic scaffolding (demos only)

# Twitch (optional)
TWITCH_CHANNEL=your_channel
TWITCH_BOT_USERNAME=your_bot
TWITCH_OAUTH_TOKEN=oauth:...
```

### Run

```bash
# Start Minecraft server first, then:
npm run dev
```

The bots will:
1. Connect to the Minecraft server (staggered 10s apart)
2. Start the neural combat server automatically
3. Start the unified 3D viewer at `http://localhost:3000` (switch bots with keys 1-3; per-bot ports are a fallback)
4. Start Mission Control dashboard at `http://localhost:3010`
5. Begin autonomous decision loops

> **Note:** All bot usernames must be operators on the server (for example `/op Milo`, `/op Ava`, and `/op Peter`) so they can use configured server commands.

> **Tip:** With `online-mode=false` you can join the world yourself — Direct Connect to `localhost:25565` with any username and watch the bots up close (`/gamemode spectator` for free-flight).

### Single-Bot Mode

To run just Milo:

```env
ENABLE_MULTI_BOT=false
```

---

## Features

### Multi-Bot Team Coordination

The three bots coordinate through **shared context**. Each bot's LLM prompt includes a Team Bulletin showing what every other bot is doing:

```
TEAM STATUS (live):
- Milo: exploring north at (450, 72, -280) — "Found a massive cave system!"
- Ava: running build_farm at (285, 65, -318) — "Planting wheat row 3"
- Peter: running strip_mine at (290, 11, -315) — "Mining iron ore vein"
```

This enables natural coordination: Ava sees Peter deposited raw iron and decides to smelt it; Peter sees Milo found a good building spot and heads there; Milo sees Ava farming at night and patrols nearby.

### Shared Stash

All bots share a central stash of categorized chests:

| Row | Category | Example Items |
|-----|----------|--------------|
| 1 | Building | logs, planks, cobblestone, glass |
| 2 | Metals & Ores | raw iron, iron ingots, copper, coal |
| 3 | Food & Farming | wheat, seeds, bread, cooked meat |
| 4 | Tools & Combat | swords, pickaxes, armor, arrows |
| 5+ | Overflow | anything else |

Any bot can bootstrap the first chest and expand storage because all verified skills are shared. Bots deposit excess items and withdraw what they need via `deposit_stash` / `withdraw_stash` actions.

### Mission Control Dashboard

Access at `http://localhost:3010` — a single page showing all bots at a glance:

- **Bot cards** at top: real-time health, current action, last thought, position
- **3D viewer** in center: click any bot to switch the live view
- **Stash status** sidebar: inventory summary across all stash chests
- **Auto-cycle** button: toggles automatic switching between bots (30s each)
- **Keyboard shortcuts**: 1-3 to select a bot, C to toggle auto-cycle

### Port Allocation

All bots share the unified viewer at `:3000`. Per-bot ports below are the legacy fallback when the unified viewer is unavailable:

| Bot | 3D Viewer (fallback) | Overlay |
|-----|-----------|---------|
| Milo | :3000 | :3001 |
| Ava | :3002 | :3003 |
| Peter | :3004 | :3025 |
| Dashboard | :3010 | — |

### Autonomous Decision Making

The brain is **event-driven**, not a polling loop:
- **Strategic** (every ~10s idle, or on goal completion): full world context + team bulletin + memory + tech-tree curriculum → goal-setting decision
- **Reactive** (hostiles spotted, damage taken, low health/hunger): tiny prompt, fast response
- **Critic** (after every action): verifies the result, suggests the next step or triggers a re-plan
- **Chat** (player/viewer/teammate message): in-character reply

Each decision executes a gated action, records its typed outcome, and updates memory, the team bulletin, the scoreboard, and compact diagnostics. All three bots can invoke every verified built-in skill.

**Stuck detection:** If the same action fails 2+ times in a row, the bot is forced to choose a different approach. Failed actions are injected into the next prompt.

**Goal persistence:** The LLM can set goals, but typed world predicates—not step counters or result prose—complete them. Goal and task ownership state persist across decision cycles.

**Leash enforcement:** Each bot has a max distance from home. At 80% of leash radius, the LLM is warned. At 150%, the bot is force-navigated home.

**Autonomy — no cheating (default):** With `ALLOW_INTERVENTIONS=false` (the default) the LLM decides *everything*. There are no deterministic overrides that act for the bots or hand them resources. The only non-LLM helpers are reflexes a human player would do without thinking: auto-equipping the best armor a bot already owns, digging itself out when boxed in, and swimming to the surface when its head goes underwater (self-preservation, not item handouts). Setting `ALLOW_INTERVENTIONS=true` re-enables optional scaffolding (leash returns, water/buried escapes, stash bootstrap) for reliability demos — but the project's goal is capability that survives with interventions *off*.

### Skill System

**TypeScript skills** (all verified built-ins are accessible to every role; priorities still guide specialization):
- `build_house` — build a 7x7 shelter with doors, crafting table, torches
- `build_farm` — hoe dirt, plant wheat near water, harvest when ready
- `build_bridge` — bridge across water/gaps in facing direction
- `craft_gear` — craft the best available tool set (tries diamond→iron→stone→wood per tool)
- `strip_mine` — staircase down to Y=11, then tunnel — scans the surrounding walls and follows any ore vein it exposes
- `smelt_ores` — smelt raw ore into ingots, crafts a furnace from cobblestone if needed
- `light_area` — place torches in a radius
- `go_fishing` — cast and reel a fishing rod
- `setup_stash` — bootstrap shared chest area
- `neural_combat` — 50ms tick reactive combat via Python server

**Voyager JS skills** (57 skills, loaded only when `ENABLE_DYNAMIC_SKILLS=true`):
- Crafting: `craftWoodenPickaxe`, `craftIronPickaxe`, `craftCraftingTable`, `craftFurnace`, `craftChest`, `craftBucket`, and more
- Mining: `mineWoodLog`, `mineFiveCoalOres`, `mineFiveIronOres`, `mineTenCobblestone`, and more
- Smelting: `smeltFiveRawIron`, `smeltRawCopper`, and more
- Combat: `killOnePig`, `killOneZombie`, `killFourSheep`, and more
- Gathering: `collectBamboo`, `collectFiveCactusBlocks`, `fillBucketWithWater`

**Dynamic skill generation:** Disabled by default because generated/Voyager routines do not yet have objective contracts. `ENABLE_DYNAMIC_SKILLS=true` opts into the legacy loader and generator.

### Freeze Protection (Watchdogs)

A bot's brain loop awaits its current skill/action, so a single unbounded `await` on a server response (`pathfinder.goto` to an unreachable spot, `bot.dig` on a bad block state, a furnace GUI that never opens) used to freeze a bot **forever** — online and healthy-looking, but brain-dead. This is now impossible, enforced in layers:

- **Single operation controller** — every action, skill, and recovery has one owner, deadline, abort signal, and generation. Timeout/death/stop invalidates late results and clears movement, digging, controls, windows, and containers.
- **Typed postconditions** — success comes from observed inventory, position, container, or structure state; display messages are never parsed as machine truth.
- **Staged navigation recovery** — travel retries with fresh/wider goals, monitors positional progress, then escalates to deterministic trapped/safe-point recovery.
- **Bounded primitives** — every `pathfinder.goto` (8–30s), `bot.dig` (12s), `bot.craft` (20s), `openFurnace`/`openContainer` (10s) inside skills/actions is wrapped in a timeout race so failures are fast, not 4 minutes.
- **Aggregate loop budgets** — loops that repeat bounded travel (stash withdrawal item-types, per-tree wood gathering, wheat harvest passes) carry a wall-clock cap, because N bounded calls still sum past a watchdog.
- **Fail-fast reachability** — `deposit_stash` bails immediately if the bot didn't actually reach the stash instead of retrying every downstream step against the same unreachable spot.

The watchdogs are the backstop; the per-call bounds make skills fail in seconds with a useful error the LLM can re-plan on. Health monitoring compares each bot's last-decision timestamp against the newest log line — a hung brain is visible even though the bot never dies.

### Persistent Memory

Each bot has its own memory file (for example `memory-milo.json` and `memory-peter.json`):
- **Structures:** Location and type of every house/farm/furnace/mine built
- **Deaths:** Last 50 deaths with location and cause
- **Ore discoveries:** Locations of found ore veins
- **Skill history:** Success rate and average duration for every skill
- **Season goal:** Long-term mission set via `!goal set <text>` in-game
- **Broken skills:** Dynamic skills with 5+ failures permanently blocked
- **Shared state:** Verified structure registry, task leases/dependencies/evidence, and a two-sided stash transaction ledger in `data/`

### Neural Combat

A Python TCP server (`neural_server.py`) on port 12345 responds to combat observations with: `attack`, `strafe_left`, `strafe_right`, `flee`, `use_item`, or `idle`.

Combat ticks run at 50ms intervals for up to 10 seconds per engagement. If the neural server is unreachable, bots fall back to `mineflayer-pvp`. Milo prioritizes guard duty, and all three bots can use neural combat or flee.

### Live Streaming

- **Mission Control** — All-bot dashboard at `http://localhost:3010`
- **Per-bot 3D viewers** — prismarine-viewer with follow/first-person/orbit camera modes
- **OBS overlays** — Per-bot WebSocket overlay showing health, food, position, inventory, thought, action
- **TTS** — Bot thoughts converted to speech and played through overlay
- **Twitch integration** — Reads Twitch chat; viewers can interact with the bots

### Survival & Resource Loops

The bots run the real Minecraft progression loops end-to-end, using only their own faculties:

- **Iron chain:** `mine_block`/`strip_mine` vein-mine ore (the miner equips the best pickaxe and follows connected ore) → `smelt_ores` turns it into ingots in a self-built furnace → `craft_gear` upgrades tools (diamond→iron→stone→wood per tool, using whatever it has).
- **Food chain:** when no hostile threatens, `attack` hunts the nearest passive animal (cow/pig/sheep/chicken), then drops are collected off the ground and `eat` consumes the best food on hand — falling back to raw meat to avoid starvation. (A `cook_food` skill to multiply raw-meat value is on the roadmap.)
- **Drop collection:** mining, gathering, and kills all walk the bot over the dropped items — nothing is left on the ground.

### Self-Improvement Loop

The team measures and improves itself across sessions:

- **Compact diagnostics** (`logs/diagnostics/swarm-<id>.jsonl`): immediate failures, deaths, restarts, recoveries, and crashes, plus five-minute outcome summaries. Identical repeats are collapsed and files rotate at 5 MB by default.

- **Scoreboard** (`logs/sessions/<id>.json`): per-bot success rates, deaths, stash throughput, and tech-tree milestone timestamps (first log → first tool → first iron...). Compare sessions to see whether a code change helped — and revert it if not.
- **Skill curation**: skill success rates are aggregated team-wide. Skills with ≥8 real (non-precondition) failures and <10% success are retired; the prompt's skill list is ranked and annotated (`setup_stash (67% of 27)`) so the LLM prefers what works.
- **Tech-tree curriculum**: every strategic prompt includes the bot's current tech stage and a concrete next step computed from its real inventory.
- **Skill refinement** (Voyager-style): a dynamic skill that fails with a code error gets its source + error fed back to the LLM for a fixed version (old kept as `.bak`, 2 attempts/session).
- **Fine-tuning pipeline** (`finetune/`): full prompt trajectories are off by default to keep long runs small. Set `TRAJECTORY_LOG_MODE=all` to capture prompt/decision/outcome data, then use the extraction and LoRA tools described in `finetune/README.md`.

### Safety

All chat messages and bot thoughts are filtered:
- Blocks harmful/inappropriate content
- Detects and sanitizes prompt injection attempts from player chat
- Viewer messages filtered separately with tighter rules

---

## Models

The bots' decisions all run through a single local model that fits on one 32GB
GPU. That model has changed several times as stronger local options appeared.
This is the running record.

| Model | Era | Type | Notes |
|-------|-----|------|-------|
| OpenAI GPT-3.5 / GPT-4 | 2023, single-bot origin | Cloud API | The original `mineflayer-chatgpt`: one bot on a cloud model. |
| qwen3:32b + qwen3:8b | early multi-bot | Dense pair | Large model for strategy, small one for reactions. The two swapped in and out of VRAM and thrashed. |
| qwen3.6:35b-a3b | June 2026 | MoE | One MoE for every decision type. ~3B active params, ~147 tok/s. Ended the two-model swap. |
| qwen3-minecraft:8b | June 2026 | LoRA fine-tune | Qwen3-8B trained on the team's own successful games. 8.7GB, 138 tok/s. Played competently but did not beat the stock model. Reverted. |
| qwen3.6:27b | late June 2026 | Dense | Stock model that beat the fine-tune. Baseline for the July trial. |
| **gpt-oss:20b** | **July 2026 (current)** | **MoE** | **Won the three-way trial below. ~3.6B active params, ~200 tok/s, 13GB VRAM. Reasoning-native, runs at `think: "low"`.** |

### July 2026 three-way trial

Local-only, head to head, same world and prompts, with `qwen3.6:27b` as the baseline.

| Metric | gpt-oss:20b | nemotron-3-nano | qwen3.6:27b |
|--------|-------------|-----------------|-------------|
| Eats / hour | **10** | 1.6 | 0.7 |
| Action-failure rate | **31%** | n/a | 61% |
| Decisions / hour | **~1,700** (≈8× qwen) | n/a | baseline |
| VRAM | 13GB | n/a | n/a |

`gpt-oss:20b` won on food economy, action success, skill success, and decision
throughput. Deaths rose (2 → 5/hr) from sheer activity: about eight times more
actions per hour, though each individual decision is safer than before.

**Reasoning-native gotcha.** `qwen3.6` needs `think: false` or it burns its whole
token budget reasoning. `gpt-oss` is the reverse: with `think: false` under
`format: "json"` it terminates with empty content on roughly a third of queries
(14 of 44 in one run). `thinkFor(model)` in `src/llm/index.ts` picks the level
per model (`"low"` for gpt-oss, `false` for qwen). Same flag, opposite settings.

---

## Project Structure

```
minecraft-agent-swarm/
├── src/
│   ├── bot/
│   │   ├── index.ts         # Bot lifecycle (connection, spawn safety)
│   │   ├── brain.ts         # Event-driven decision engine
│   │   ├── scoreboard.ts    # Session metrics + tech milestones
│   │   ├── curriculum.ts    # Tech-tree next-goal proposal
│   │   ├── trajectory.ts    # Fine-tuning data capture
│   │   ├── navigation.ts    # safeGoto, drop collection, movements
│   │   ├── actions.ts       # Action implementations
│   │   ├── perception.ts    # World context builder
│   │   ├── memory.ts        # Per-bot persistent memory (BotMemoryStore)
│   │   ├── memory-registry.ts # Bot → memory store mapping
│   │   ├── role.ts          # BotRoleConfig + all 5 bot configs
│   │   └── bulletin.ts      # Team bulletin (shared status)
│   ├── llm/
│   │   └── index.ts         # Ollama client + JSON repair + system prompt
│   ├── skills/
│   │   ├── executor.ts      # Skill runner (abort support)
│   │   ├── reliability.ts   # Team-wide skill stats + retirement
│   │   ├── generator.ts     # Dynamic skill generator
│   │   ├── dynamic-loader.ts# Voyager vm sandbox
│   │   ├── registry.ts      # Skill registration
│   │   ├── stash.ts         # Deposit/withdraw stash actions
│   │   ├── setup-stash.ts   # Bootstrap shared chest area
│   │   ├── build-house.ts
│   │   ├── build-farm.ts
│   │   ├── build-bridge.ts
│   │   ├── craft-gear.ts
│   │   ├── go-fishing.ts
│   │   ├── light-area.ts
│   │   ├── smelt-ores.ts
│   │   └── strip-mine.ts
│   ├── neural/
│   │   ├── bridge.ts        # TCP client for neural server
│   │   └── combat.ts        # 50ms tick combat loop
│   ├── stream/
│   │   ├── viewer.ts        # Per-bot prismarine-viewer
│   │   ├── viewer-client.html # 3D viewer with camera modes
│   │   ├── overlay.ts       # Per-bot OBS WebSocket overlay
│   │   ├── dashboard.ts     # Mission Control server
│   │   └── tts.ts           # Text-to-speech
│   ├── safety/
│   │   └── filter.ts        # Content safety filter
│   ├── config.ts            # Env-based config
│   └── index.ts             # Entry point — launches all bots
├── dashboard/
│   └── index.html           # Mission Control frontend
├── overlay/
│   └── index.html           # OBS overlay frontend
├── skills/
│   ├── voyager/             # 57 Voyager-style JS skills
│   └── generated/           # LLM-generated skills (runtime)
├── finetune/                # LoRA fine-tuning pipeline (see finetune/README.md)
├── scripts/                 # Dataset extraction, skill downloads
├── logs/
│   ├── sessions/            # Scoreboard JSON per session (git-ignored)
│   ├── diagnostics/         # Compact rotated diagnostic JSONL (git-ignored)
│   └── trajectories/        # Optional fine-tuning JSONL (git-ignored)
├── neural_server.py         # Python combat policy server
├── memory-milo.json         # Milo memory (git-ignored)
├── memory-ava.json          # Ava memory (git-ignored)
├── memory-peter.json        # Peter memory (git-ignored)
└── .env                     # Local config (git-ignored)
```

---

## Known Issues

| Issue | Status |
|-------|--------|
| Ollama JSON-schema `format` ignored | qwen3.6 on ollama 0.20.x returns prose for schema-constrained requests; plain `format:"json"` works (used). Re-test after upgrading ollama |
| Pathfinder timeouts on some goals | Bounded + watchdog-backstopped (see Freeze Protection); bots recover via critic re-plan |
| Food supply can still fluctuate across 3 bots | Ava's farming can oscillate; bots survive (Easy floors starvation at 10 HP) but productivity drops during hungry stretches |
| Farms unbuilt unless water is near | `build_farm` needs water within range of the village site |
| Neural combat untested in survival | Server is implemented and running; needs hostile mob environment |
| Generated skills may fail on first run | Mitigated: code-error failures now trigger automatic LLM refinement |

---

## Development

```bash
npm run dev     # Run with tsx watch (hot reload)
npm test        # Run tests
npm run build   # Compile TypeScript
```

### Adding a New TypeScript Skill

1. Create `src/skills/my-skill.ts` implementing `async function mySkill(bot: Bot): Promise<string>`
2. Register it in `src/skills/registry.ts`
3. Add it to the appropriate bot's `allowedSkills` in `src/bot/role.ts`

### Adding a Voyager Skill

Drop a `.js` file into `skills/voyager/`. The function name must match the filename (camelCase). It will be loaded automatically by the dynamic loader.

### Adding a New Bot

1. Add a new `BotRoleConfig` in `src/bot/role.ts` with personality, allowed actions/skills, leash radius
2. Add the config to the bot roster array in `src/index.ts`
3. Add `MC_USERNAME_N` to `.env`
4. Increment `BOT_COUNT`

---

## Credits

- Originated as `mineflayer-chatgpt` by Jesse Weigel (a single ChatGPT-driven bot)
- Voyager skill library from [MineDreamer/Voyager](https://github.com/MineDreamer/Voyager)
- Autonomous multi-agent swarm, local-LLM brain, neural combat, self-improvement loop, and streaming features added 2024–2026
