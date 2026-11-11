/**
 * Event-driven decision engine — replaces the 500ms polling loop.
 *
 * Instead of asking the LLM every 500ms, the brain listens for game events
 * and routes them to the appropriate handler with a focused prompt:
 *
 * - HOSTILE detected  → reactive prompt (fast model, ~300 tokens)
 * - Damage taken      → reactive prompt
 * - Low health/hunger → reactive prompt
 * - Chat received     → chat response (fast model)
 * - Action completed  → critic check (fast model) → next step or re-plan
 * - Idle timeout      → strategic planning (strong model, ~1200 tokens)
 *
 * This cuts LLM calls from ~120/min/bot to ~6-10/min/bot and lets us use
 * the strong model (32b) for the decisions that matter.
 */

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import { config } from "../config.js";
import { BotRoleConfig, SETTLEMENT_STRUCTURE_RADIUS } from "./role.js";
import { queryStrategic, queryReactive, queryCritic, chatWithLLM, type LLMMessage } from "../llm/index.js";
import type { RoleContext } from "../llm/prompts.js";
import { getWorldContext, isHostile } from "./perception.js";
import { executeAction } from "./actions.js";
import { digOutIfStuck, escapeWaterIfDrowning } from "./navigation.js";
import { updateOverlay, addChatMessage, setCurrentBot } from "../stream/overlay.js";
import { filterContent, filterChatMessage, filterViewerMessage } from "../safety/filter.js";
import { abortActiveSkill, isSkillRunning, getActiveSkillName } from "../skills/executor.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { getAllMemoryStores } from "./memory-registry.js";
import { buildProgressionView, reconcileProgression, renderProgressionReport } from "./progression-runtime.js";
import { observeProgression } from "./progression-observer.js";
import { evaluateProgression } from "./progression-tree.js";
import { updateBulletin, formatTeamBulletin, getTeamStatus } from "./bulletin.js";
import { createLogger } from "../util/logger.js";
import { recordAction, recordSkillResult, checkInventoryMilestones } from "./scoreboard.js";
import { recordTrajectory } from "./trajectory.js";
import { actionResultSucceeded } from "./action-result.js";
import { buildStrategicPrompt } from "../llm/prompts.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import {
  assessGoal,
  assessWoodGatherDecision,
  formatItemRequirement,
  formatWoodRequirement,
  HOUSE_WOOD_TARGET,
  inventoryCounts,
  type GoalAssessment,
} from "./goal-requirements.js";
import { buildActionMenu, validateDecisionAgainstMenu, type ActionOption } from "./action-menu.js";
import { getStashSummary } from "../skills/stash-ledger.js";
import { getTeamEstablishedFarmSites, getTeamFarmSites, inspectFarmLedger } from "../skills/farm-ledger.js";
import {
  buildObjectiveDecisionMenu,
  getAutomaticSubobjectiveDecision,
  isObjectiveId,
  reconcileObjectiveCommitment,
  renderObjectiveTreeReport,
  type ObjectiveSnapshot,
  type ObjectiveTreeView,
  type StructureProgress,
} from "./objective-tree.js";

export interface ChatMessage {
  source: "minecraft" | "twitch" | "youtube";
  username: string;
  message: string;
  timestamp: number;
}

export interface BrainEvents {
  onThought: (thought: string) => void;
  onAction: (action: string, result: string) => void;
  onChat: (message: string) => void;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(key(value), value);
  return [...unique.values()];
}

// ─── Event types ────────────────────────────────────────────────────────────

type EventType = "strategic" | "reactive" | "chat" | "critic";

interface BrainEvent {
  type: EventType;
  priority: number; // Lower = higher priority (0 = most urgent)
  data?: any;
  timestamp: number;
}

// ─── Brain ──────────────────────────────────────────────────────────────────

export class BotBrain {
  private bot: Bot;
  private roleConfig: BotRoleConfig;
  private events: BrainEvents;
  private memStore: BotMemoryStore;
  private log;

  // Processing state
  private processing = false;
  private stopped = false;
  private rescuingFromWater = false;
  private eventQueue: BrainEvent[] = [];

  // Timers
  private idleTimer: NodeJS.Timeout | null = null;
  private hostileScanner: NodeJS.Timeout | null = null;
  private overlayInterval: NodeJS.Timeout | null = null;

  // Decision state (migrated from the old decide() function)
  private currentGoal = "";
  private goalStepsLeft = 0;
  private goalWoodTargetOverride: number | undefined;
  private lastAction = "";
  private lastResultSig = "";
  private sameResultCount = 0;
  private lastResult = "";
  private lastActionWasSuccess = false;
  private lastActionWasExecuted = true;
  private repeatCount = 0;
  private recentHistory: LLMMessage[] = [];
  private pendingChatMessages: ChatMessage[] = [];
  private explicitSkillRequests = new Map<string, number>();
  private objectiveAutoSteps = 0;
  private objectiveAutoFailures = 0;
  private lastAutomaticSubobjective = "";
  private objectiveRecoveryCycles = 0;
  private objectiveRetryAt = 0;
  private objectiveRetryTimer: NodeJS.Timeout | null = null;

  /** Allocation-safe counters for the once-per-minute memory monitor. */
  getDiagnostics(): Record<string, unknown> {
    return {
      processing: this.processing,
      stopped: this.stopped,
      eventQueue: this.eventQueue.length,
      recentHistory: this.recentHistory.length,
      pendingChat: this.pendingChatMessages.length,
      explicitSkillRequests: this.explicitSkillRequests.size,
      recentFailures: this.recentFailures.size,
      failureCounts: this.failureCounts.size,
      objectiveAutoSteps: this.objectiveAutoSteps,
      objectiveAutoFailures: this.objectiveAutoFailures,
      objectiveRecoveryCycles: this.objectiveRecoveryCycles,
      objectiveRetryInSec: Math.max(0, Math.ceil((this.objectiveRetryAt - Date.now()) / 1000)),
    };
  }

  private rememberHistory(message: LLMMessage): void {
    this.recentHistory.push(message);
    if (this.recentHistory.length > 12) {
      this.recentHistory.splice(0, this.recentHistory.length - 8);
    }
  }

  // Failure tracking
  private recentFailures = new Map<string, string>();
  // recentFailures entries EXPIRE. They used to live forever, and a blocked
  // action can never run again to clear itself — so over a long run the
  // blacklist saturated (eat/explore/go_to/mine_block all blocked) and all 5
  // bots stood frozen churning "Blocked:" x357/15min at hour ~20 of run 118.
  // Transient failures (no path, no food HERE, no mobs NOW) age out fast; the
  // world changes. Structural blocks (wrong-role action, retired skill,
  // hallucinated name) persist long.
  private failureExpiry = new Map<string, number>();
  private objectiveFailureState = new Map<string, string>();
  private static readonly FAILURE_TTL_TRANSIENT_MS = 120_000;
  private static readonly FAILURE_TTL_STRUCTURAL_MS = 3_600_000;

  private blockAction(key: string, msg: string, ttlMs: number = BotBrain.FAILURE_TTL_TRANSIENT_MS): void {
    this.recentFailures.set(key, msg);
    if (key.startsWith("objective:")) {
      this.objectiveFailureState.set(key, this.objectiveStateSignature());
      this.failureExpiry.set(key, Date.now() + BotBrain.FAILURE_TTL_STRUCTURAL_MS);
    } else {
      this.failureExpiry.set(key, Date.now() + ttlMs);
    }
  }

  private purgeExpiredFailures(): void {
    const now = Date.now();
    for (const [k, exp] of this.failureExpiry.entries()) {
      const stateChanged =
        k.startsWith("objective:") &&
        this.objectiveFailureState.has(k) &&
        this.objectiveFailureState.get(k) !== this.objectiveStateSignature();
      if (now > exp || stateChanged) {
        this.failureExpiry.delete(k);
        this.objectiveFailureState.delete(k);
        this.recentFailures.delete(k);
        this.failureCounts.delete(k);
      }
    }
  }

  private objectiveStateSignature(): string {
    const snapshot = this.buildObjectiveSnapshot();
    return JSON.stringify({
      inventory: snapshot.inventory,
      stashInventory: snapshot.stashInventory,
      stashFreeSlots: snapshot.stashFreeSlots,
      structures: snapshot.structures,
      animals: snapshot.nearbyAnimals,
      farmLedgerReady: snapshot.farmLedgerReady,
      farmPlotsTotal: snapshot.farmPlotsTotal,
      farmPlotsNeedingRepair: snapshot.farmPlotsNeedingRepair,
      matureWheatNearby: snapshot.matureWheatNearby,
      nearFarm: snapshot.nearFarm,
      visibleTrees: snapshot.visibleTrees,
      position: {
        x: Math.floor(this.bot.entity.position.x / 8),
        y: Math.floor(this.bot.entity.position.y / 4),
        z: Math.floor(this.bot.entity.position.z / 8),
      },
    });
  }
  private failureCounts = new Map<string, number>();
  private successesSinceLastExpiry = 0;

  // Leash
  private homePos: { x: number; y: number; z: number } | null;

  // Chat dedup — the 8B anchors on its own last thought and re-sends the
  // same demand every strategic cycle ("Give me the logs!" x7 in 2 min)
  private lastChatSent = "";
  private lastChatSentMs = 0;

  // Cooldowns — prevent spamming the same event type
  private lastReactiveMs = 0;
  private lastStrategicMs = 0;
  private lastHostileSeen = "";

  // Configuration
  private IDLE_INTERVAL_MS: number;
  private HOSTILE_CHECK_MS = 2000;
  private REACTIVE_COOLDOWN_MS = 3000;
  private STRATEGIC_COOLDOWN_MS = 8000;
  private CRITIC_ENABLED: boolean;

  constructor(bot: Bot, roleConfig: BotRoleConfig, events: BrainEvents, memStore: BotMemoryStore) {
    this.bot = bot;
    this.roleConfig = roleConfig;
    this.events = events;
    this.memStore = memStore;
    this.log = createLogger(roleConfig.name);
    this.homePos = roleConfig.homePos ?? null;
    this.IDLE_INTERVAL_MS = config.bot.idleIntervalMs ?? 10_000;
    this.CRITIC_ENABLED = config.bot.criticEnabled;

    // Pre-populate failure blacklist from memory
    for (const [skill, msg] of memStore.getSessionPreconditionBlocks()) {
      this.blockAction(`skill:${skill}`, msg, BotBrain.FAILURE_TTL_STRUCTURAL_MS);
    }
    if (this.recentFailures.size > 0) {
      this.log.debug("Brain", `Pre-populated ${this.recentFailures.size} blacklist entries from memory`);
    }
  }

  /**
   * Auto-equip the best armor the bot is carrying. Bots had no behavior to
   * WEAR armor, so bootstrapped/crafted iron armor sat unworn in inventory
   * while they fought unprotected and died. Runs periodically; idempotent.
   */
  private async equipBestArmor(): Promise<void> {
    if (isSkillRunning(this.bot)) return;
    const TIER = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
    const slots: [string, string, number][] = [
      ["head", "_helmet", 5],
      ["torso", "_chestplate", 6],
      ["legs", "_leggings", 7],
      ["feet", "_boots", 8],
    ];
    // (The old "attempting equip" diagnostic is gone: it fired every cycle
    // even when the armor was already WORN — inventory.items() includes the
    // armor slots — producing thousands of noise lines. The "equipped" /
    // "equip FAILED" lines below are the real signals, and they confirmed the
    // system works: Atlas, Forge, and Flora all equipped iron chestplates.)
    for (const [dest, suffix, slotIdx] of slots) {
      const cands = this.bot.inventory.items().filter((i) => i.name.endsWith(suffix));
      if (!cands.length) continue;
      cands.sort((a, b) => {
        const ta = TIER.findIndex((t) => a.name.includes(t));
        const tb = TIER.findIndex((t) => b.name.includes(t));
        return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
      });
      const best = cands[0];
      const worn = this.bot.inventory.slots[slotIdx];
      // Compare TIERS, not names: inventory.items() excludes worn armor, so a
      // bot wearing iron while carrying a leather spare sees best=leather,
      // fails the name check, and swaps — then swaps back next cycle. Flora
      // flip-flopped iron<->leather helmets 149 times in an hour this way.
      // Only equip when the carried candidate strictly beats what's worn.
      const tierOf = (n: string) => {
        const t = TIER.findIndex((tier) => n.includes(tier));
        return t < 0 ? 99 : t;
      };
      if (worn && tierOf(worn.name) <= tierOf(best.name)) continue; // worn is same or better
      try {
        await this.bot.equip(best, dest as any);
        this.log.info("Armor", `equipped ${best.name}`);
      } catch (e: any) {
        this.log.warn("Armor", `equip ${best.name} FAILED: ${e?.message || e}`);
      }
    }
  }

  /** Start the event-driven brain. Call after spawn safety completes. */
  start(): void {
    this.log.info("Brain", `Starting (idle interval: ${this.IDLE_INTERVAL_MS}ms)`);

    // 1. Idle timer — triggers strategic planning when nothing else is happening
    this.resetIdleTimer();

    // 0. Auto-equip armor on spawn and every 20s thereafter
    this.equipBestArmor().catch(() => {});
    const armorTimer = setInterval(() => this.equipBestArmor().catch(() => {}), 20_000);
    armorTimer.unref?.();

    // 0b. Self-unstick: if boxed into a hole, dig out (own hands, not a TP).
    // Skip while a skill runs (e.g. strip_mine intentionally digs down).
    const unstickTimer = setInterval(() => {
      if (!this.processing && !isSkillRunning(this.bot)) digOutIfStuck(this.bot).catch(() => {});
    }, 25_000);
    unstickTimer.unref?.();

    // 0c. Anti-drown: ~90% of all deaths were bots drowning in the stash water
    // pit. Drowning kills in ~15s, so check often and swim out even mid-action
    // (this overrides whatever the bot is doing — staying alive comes first).
    const drownTimer = setInterval(() => {
      if (this.rescuingFromWater) return;
      this.rescuingFromWater = true;
      escapeWaterIfDrowning(this.bot)
        .catch(() => {})
        .finally(() => {
          this.rescuingFromWater = false;
        });
    }, 3000);
    drownTimer.unref?.();

    // 2. Hostile scanner — checks for nearby threats every 2s
    this.hostileScanner = setInterval(() => this.scanHostiles(), this.HOSTILE_CHECK_MS);

    // 3. Health/hunger monitoring via mineflayer events
    this.bot.on("health", () => this.checkVitals());

    // Recheck live supplies after respawn while retaining world progress and intent.
    this.bot.on("respawn", () => {
      this.resetObjectiveRecovery();
      this.objectiveAutoSteps = 0;
      this.objectiveAutoFailures = 0;
      this.recentFailures.clear();
      this.failureCounts.clear();
      this.scheduleHierarchicalContinuation(1500);
    });

    // 4. Entity hurt — react when bot takes damage
    this.bot.on("entityHurt", (entity: Entity) => {
      if (entity === this.bot.entity) {
        this.pushEvent({
          type: "reactive",
          priority: 0,
          data: { reason: "took_damage", health: this.bot.health },
          timestamp: Date.now(),
        });
      }
    });

    // 5. Overlay updates every 2s
    this.overlayInterval = setInterval(() => {
      setCurrentBot(this.roleConfig.name);
      const overlayData: any = {
        health: this.bot.health,
        food: this.bot.food,
        position: {
          x: this.bot.entity.position.x,
          y: this.bot.entity.position.y,
          z: this.bot.entity.position.z,
        },
        time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
        inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
        seasonGoal: this.memStore.getSeasonGoal() ?? undefined,
      };
      if (isSkillRunning(this.bot)) {
        overlayData.action = `[SKILL] ${getActiveSkillName(this.bot)}`;
      }
      updateOverlay(overlayData);
    }, 2000);

    // Trigger first strategic decision immediately
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  /** Stop the brain — clears all timers. */
  stop(): void {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hostileScanner) clearInterval(this.hostileScanner);
    if (this.overlayInterval) clearInterval(this.overlayInterval);
    if (this.objectiveRetryTimer) clearTimeout(this.objectiveRetryTimer);
  }

  /** Queue a chat message for processing. */
  queueChat(msg: ChatMessage): void {
    const viewerFilter = filterViewerMessage(msg.message);
    if (!viewerFilter.safe) {
      this.log.debug("Brain", `Filtered viewer message from ${msg.username}: ${viewerFilter.reason}`);
      msg.message = viewerFilter.cleaned;
    }
    this.rememberExplicitSkillRequests(msg.message);
    this.pendingChatMessages.push(msg);
    if (this.pendingChatMessages.length > 10) this.pendingChatMessages.shift();

    // Push chat event — paid messages are higher priority
    const isPaid = (msg as any).tier === "paid";
    this.pushEvent({
      type: isPaid ? "strategic" : "chat", // Paid messages trigger full re-planning
      priority: isPaid ? 1 : 4,
      data: msg,
      timestamp: Date.now(),
    });
  }

  /** Force immediate strategic re-evaluation. */
  triggerReplan(): void {
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  // ─── Event queue management ─────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
      this.resetIdleTimer();
    }, this.IDLE_INTERVAL_MS);
  }

  private pushEvent(event: BrainEvent): void {
    if (this.stopped) return;

    // Deduplicate: don't queue same type if already pending with equal/higher priority
    const existingIdx = this.eventQueue.findIndex((e) => e.type === event.type);
    if (existingIdx !== -1) {
      if (event.priority < this.eventQueue[existingIdx].priority) {
        this.eventQueue.splice(existingIdx, 1); // Replace with higher priority
      } else {
        return; // Already have an equal/higher priority event of this type
      }
    }

    this.eventQueue.push(event);
    this.eventQueue.sort((a, b) => a.priority - b.priority);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.stopped) return;
    const event = this.eventQueue.shift();
    if (!event) return;

    this.processing = true;
    setCurrentBot(this.roleConfig.name);

    try {
      // Skip if a skill is running (let it finish)
      if (isSkillRunning(this.bot) && event.type !== "reactive") {
        // Re-queue non-urgent events to process after skill completes
        if (event.type === "strategic") {
          setTimeout(() => this.pushEvent(event), 3000);
        }
        return;
      }

      switch (event.type) {
        case "reactive":
          await this.handleReactive(event);
          break;
        case "chat":
          await this.handleChat(event);
          break;
        case "strategic":
          await this.handleStrategic(event);
          break;
        case "critic":
          await this.handleCritic(event);
          break;
      }
    } catch (err) {
      this.log.error(`Brain:${event.type}`, "Error:", err);
    } finally {
      this.processing = false;
      this.resetIdleTimer();
      // Process next queued event
      if (this.eventQueue.length > 0 && !this.stopped) {
        setImmediate(() => this.processNext());
      }
    }
  }

  // ─── Hostile scanning ─────────────────────────────────────────────────────

  private scanHostiles(): void {
    if (this.processing || this.stopped) return;
    if (isSkillRunning(this.bot)) return; // Don't interrupt skills

    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    const hostiles = Object.values(this.bot.entities).filter(
      (e) => e !== this.bot.entity && isHostile(e) && e.position.distanceTo(this.bot.entity.position) < 16,
    );

    if (hostiles.length === 0) return;

    // A real threat is present — clear any stale "no mobs / attack failed"
    // blacklist so the bot can actually engage. Without this, the no-target
    // failures that pile up while safe (Peaceful, or just daytime) permanently
    // block attack/neural_combat, so Blade could never fight when mobs finally
    // appeared — he had 0 kills all session.
    for (const key of ["attack", "neural_combat", "skill:neural_combat"]) {
      this.recentFailures.delete(key);
      this.failureCounts.delete(key);
    }

    // Don't spam for the same hostile
    const hostileKey = hostiles.map((h) => `${h.name}:${Math.round(h.position.x)}`).join(",");
    if (hostileKey === this.lastHostileSeen && now - this.lastReactiveMs < 10_000) return;
    this.lastHostileSeen = hostileKey;

    this.pushEvent({
      type: "reactive",
      priority: 1,
      data: { reason: "hostile_nearby", entities: hostiles },
      timestamp: now,
    });
  }

  private checkVitals(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    if (this.bot.health <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 0,
        data: { reason: "low_health", health: this.bot.health },
        timestamp: now,
      });
    } else if (this.bot.food <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 2,
        data: { reason: "low_hunger", food: this.bot.food },
        timestamp: now,
      });
    }
  }

  // ─── Safety overrides ─────────────────────────────────────────────────────

  /** Check for water/underground and handle before LLM query. Returns true if override handled. */
  private async runSafetyOverrides(): Promise<boolean> {
    // Teleport-based water/buried escapes are interventions — off by default so
    // bots must swim/dig out themselves (or die; keepInventory protects progress).
    if (!config.bot.allowInterventions) return false;
    const pos = this.bot.entity.position;

    // Water escape
    const feetBlock = this.bot.blockAt(pos);
    const headBlock = this.bot.blockAt(pos.offset(0, 1, 0));
    if (feetBlock?.name === "water" || headBlock?.name === "water") {
      // Wait 3s for natural swim-out
      await new Promise((r) => setTimeout(r, 3000));
      const feetNow = this.bot.blockAt(this.bot.entity.position);
      const headNow = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
      if (feetNow?.name !== "water" && headNow?.name !== "water") return false;

      if (this.roleConfig.safeSpawn) {
        const { x, z } = this.roleConfig.safeSpawn;
        this.log.debug("Brain", `In water — TPing to safeSpawn (${x},80,${z})`);
        // spreadplayers lands on the topmost safe block — a raw /tp X 80 Z
        // materialized bots inside hills taller than Y=80 (suffocation deaths)
        this.bot.chat(`/spreadplayers ${x} ${z} 0 2 false ${this.bot.username}`);
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
      return false;
    }

    // Underground/buried escape
    const isInsideSolid =
      feetBlock &&
      feetBlock.name !== "air" &&
      feetBlock.name !== "cave_air" &&
      feetBlock.name !== "water" &&
      feetBlock.diggable &&
      pos.y < 55;
    if (isInsideSolid) {
      const tx = Math.floor(pos.x);
      const tz = Math.floor(pos.z);
      this.log.debug("Brain", `Buried in ${feetBlock?.name} at Y=${pos.y.toFixed(1)} — escaping`);
      this.bot.chat(`/spreadplayers ${tx} ${tz} 0 2 false ${this.bot.username}`);
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }

    return false;
  }

  // ─── Context building ─────────────────────────────────────────────────────

  private nearbyCraftingTable(): boolean {
    try {
      return !!this.bot.findBlock({
        matching: (block) => block.name === "crafting_table",
        maxDistance: 32,
      });
    } catch {
      return false;
    }
  }

  private assessActiveGoal(action?: string, result?: string): GoalAssessment {
    if (!this.currentGoal) return { goalComplete: false };
    return assessGoal(this.currentGoal, inventoryCounts(this.bot.inventory.items()), {
      action,
      result,
      nearbyCraftingTable: this.nearbyCraftingTable(),
      woodTargetOverride: this.goalWoodTargetOverride,
    });
  }

  private clearActiveGoal(reason: string): void {
    if (!this.currentGoal) return;
    this.log.info("Brain:goal", `Goal "${this.currentGoal}" cleared: ${reason}. Re-planning.`);
    this.currentGoal = "";
    this.goalStepsLeft = 0;
    this.goalWoodTargetOverride = undefined;
  }

  /**
   * Models often repeat the same `goal` field on every decision. Resetting its
   * step budget each time made stale goals immortal, so only a genuinely new
   * goal gets a fresh budget.
   */
  private activateGoal(goal: string | undefined, steps?: number): void {
    const next = goal?.trim();
    if (!next) return;
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^\w]+/g, " ")
        .trim();
    if (this.currentGoal && normalize(this.currentGoal) === normalize(next)) return;
    this.currentGoal = next;
    this.goalStepsLeft = Math.max(1, Math.min(Number(steps) || 5, 20));
    this.goalWoodTargetOverride = undefined;
    this.log.debug("Brain:goal", `New goal "${next}" (${this.goalStepsLeft} steps)`);
  }

  private reconcileActiveGoal(action?: string, result?: string): GoalAssessment {
    if (!this.currentGoal) return { goalComplete: false };
    const assessment = this.assessActiveGoal(action, result);
    if (assessment.goalComplete) {
      this.clearActiveGoal(assessment.goalCompleteReason ?? "deterministic requirement satisfied");
    }
    return assessment;
  }

  private inventoryRecord(items: { name: string; count: number }[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return counts;
  }

  private belongsToCurrentSettlement(structure: { type: string; x: number; z: number }): boolean {
    if (!["house", "warehouse", "workshop", "mine", "furnace", "animal_pen"].includes(structure.type)) return true;
    const anchor = this.roleConfig.stashPos;
    if (!anchor) return true;
    return Math.hypot(structure.x - anchor.x, structure.z - anchor.z) <= SETTLEMENT_STRUCTURE_RADIUS;
  }

  private buildObjectiveSnapshot(): ObjectiveSnapshot {
    const carried = this.inventoryRecord(this.bot.inventory.items());
    const teamInventory: Record<string, number> = { ...carried };
    const teammates = getTeamStatus(this.roleConfig.name);
    const freshTeammates = teammates.filter((teammate) => Date.now() - teammate.timestamp <= 30_000);
    for (const teammate of freshTeammates) {
      for (const [name, count] of Object.entries(teammate.inventory ?? {})) {
        teamInventory[name] = (teamInventory[name] ?? 0) + count;
      }
    }

    const stores = getAllMemoryStores();
    const structures = uniqueBy(
      stores
        .flatMap((store) => [...store.getStructures()])
        .filter((structure) => this.belongsToCurrentSettlement(structure)),
      (structure) =>
        `${structure.type}|${structure.x}|${structure.y}|${structure.z}|${structure.builtAt}|${structure.notes ?? ""}`,
    );
    const structureProgress = (type: "house" | "farm" | "warehouse" | "workshop" | "mine"): StructureProgress => {
      const matching = structures.filter((structure) => structure.type === type);
      if (matching.some((structure) => !(structure.notes ?? "").toLowerCase().includes("partial"))) {
        return "complete";
      }
      return matching.length > 0 ? "partial" : "missing";
    };
    const farm = structures.find(
      (structure) => structure.type === "farm" && !(structure.notes ?? "").toLowerCase().includes("partial"),
    );
    const house = structures.find(
      (structure) => structure.type === "house" && !(structure.notes ?? "").toLowerCase().includes("partial"),
    );
    const mine = structures.find(
      (structure) => structure.type === "mine" && !(structure.notes ?? "").toLowerCase().includes("partial"),
    );
    const animalPens = new Set(
      structures
        .filter((structure) => structure.type === "animal_pen" && /status=established/i.test(structure.notes ?? ""))
        .map((structure) => /species=([a-z_]+)/i.exec(structure.notes ?? "")?.[1])
        .filter((species): species is string => !!species),
    );
    const rememberedFarmSite = getTeamFarmSites()
      .filter((site) => site.status === "reachable" || site.status === "planted")
      .sort((a, b) => {
        const rank = { planted: 3, reachable: 2, discovered: 1 } as const;
        const statusDifference = rank[b.status as keyof typeof rank] - rank[a.status as keyof typeof rank];
        if (statusDifference !== 0) return statusDifference;
        return (
          this.bot.entity.position.distanceTo(new Vec3(a.approach.x, a.approach.y, a.approach.z)) -
          this.bot.entity.position.distanceTo(new Vec3(b.approach.x, b.approach.y, b.approach.z))
        );
      })[0];
    const establishedFarmSites = getTeamEstablishedFarmSites().sort(
      (a, b) =>
        this.bot.entity.position.distanceTo(new Vec3(a.approach.x, a.approach.y, a.approach.z)) -
        this.bot.entity.position.distanceTo(new Vec3(b.approach.x, b.approach.y, b.approach.z)),
    );
    const farmLedgerReady =
      establishedFarmSites.length > 0 && establishedFarmSites.every((site) => (site.plots?.length ?? 0) > 0);
    const farmInspection = inspectFarmLedger(this.bot, establishedFarmSites);

    const allSkillHistory = uniqueBy(
      stores.flatMap((store) => store.getSkillHistory()),
      (attempt) =>
        `${attempt.skill}|${attempt.success}|${attempt.durationSeconds}|${attempt.timestamp}|${attempt.notes}`,
    );
    const scoutedSectors = new Set(
      stores
        .flatMap((store) => [...store.getScoutSectors()])
        .filter(
          (record) =>
            !this.roleConfig.stashPos ||
            Math.hypot(
              record.waypoint.x - this.roleConfig.stashPos.x,
              record.waypoint.z - this.roleConfig.stashPos.z,
            ) <= 100,
        )
        .map((record) => record.id),
    );
    const safetyZones = new Set(
      stores
        .flatMap((store) => [...store.getSafetyZones()])
        .filter(
          (record) =>
            !this.roleConfig.stashPos ||
            Math.hypot(record.center.x - this.roleConfig.stashPos.x, record.center.z - this.roleConfig.stashPos.z) <=
              SETTLEMENT_STRUCTURE_RADIUS,
        )
        .map((record) => record.zone),
    );
    const currentMineStartedAt = structures
      .filter((structure) => structure.type === "mine")
      .map((structure) => Date.parse(structure.builtAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const ironToolEstablished = allSkillHistory.some(
      (attempt) =>
        attempt.success &&
        attempt.skill === "craft_gear" &&
        /\b(?:iron|diamond|netherite)_pickaxe\b/i.test(attempt.notes) &&
        Number.isFinite(currentMineStartedAt) &&
        Date.parse(attempt.timestamp) >= currentMineStartedAt,
    );
    const furnaceEstablished =
      structures.some(
        (structure) => structure.type === "furnace" && !(structure.notes ?? "").toLowerCase().includes("partial"),
      ) ||
      allSkillHistory.some(
        (attempt) =>
          attempt.success &&
          attempt.skill === "smelt_ores" &&
          Number.isFinite(currentMineStartedAt) &&
          Date.parse(attempt.timestamp) >= currentMineStartedAt,
      );
    const stashSummary = getStashSummary();
    const stashExists =
      stashSummary.chestCount > 0 ||
      allSkillHistory.some((attempt) => attempt.skill === "setup_stash" && attempt.success);
    const shelterLit = safetyZones.has("lodge");

    let nearbyWater = false;
    let visibleTrees = false;
    let nearbyCraftingTable = false;
    let matureWheatNearby = 0;
    const nearbyAnimals: Record<string, number> = { cow: 0, sheep: 0, chicken: 0, pig: 0 };
    try {
      nearbyWater = !!this.bot.findBlock({
        matching: (block) => block.name === "water",
        maxDistance: 48,
      });
      visibleTrees = !!this.bot.findBlock({
        matching: (block) =>
          block.name.endsWith("_log") || block.name.endsWith("_stem") || block.name.endsWith("_hyphae"),
        maxDistance: 64,
      });
      nearbyCraftingTable = !!this.bot.findBlock({
        matching: (block) => block.name === "crafting_table",
        maxDistance: 32,
      });
      matureWheatNearby = farmInspection.maturePlots;
      for (const entity of Object.values(this.bot.entities)) {
        if (!entity?.position || this.bot.entity.position.distanceTo(entity.position) > 96) continue;
        const name = String((entity as any).name ?? (entity as any).mobType ?? "").toLowerCase();
        if (name in nearbyAnimals) nearbyAnimals[name]++;
      }
    } catch {
      // Missing chunks mean "not observed", never a fabricated positive fact.
    }

    const primaryEstablishedFarm = establishedFarmSites[0];
    const farmLocation = primaryEstablishedFarm
      ? { ...primaryEstablishedFarm.water }
      : farm
        ? { x: farm.x, y: farm.y, z: farm.z }
        : rememberedFarmSite
          ? { ...rememberedFarmSite.water }
          : undefined;
    const houseLocation = house ? { x: house.x + 4, y: house.y + 1, z: house.z + 4 } : undefined;
    const mineLocation = mine ? { x: mine.x, y: mine.y, z: mine.z } : undefined;
    const nearFarm = establishedFarmSites.some(
      (site) => this.bot.entity.position.distanceTo(new Vec3(site.water.x, site.water.y, site.water.z)) <= 48,
    );
    const inventoryItems = Object.values(carried).reduce((total, count) => total + count, 0);

    return {
      botName: this.roleConfig.name,
      role: this.roleConfig.role,
      position: {
        x: Math.floor(this.bot.entity.position.x),
        y: Math.floor(this.bot.entity.position.y),
        z: Math.floor(this.bot.entity.position.z),
      },
      settlementAnchor: this.roleConfig.stashPos ? { ...this.roleConfig.stashPos } : undefined,
      inventory: carried,
      teamInventory,
      stashInventory: stashSummary.items,
      structures: {
        house: structureProgress("house"),
        farm: structureProgress("farm"),
        warehouse: structureProgress("warehouse"),
        workshop: structureProgress("workshop"),
        mine: structureProgress("mine"),
      },
      stashExists,
      progressionStorage: {
        chestCount: Math.ceil(stashSummary.totalSlots / 27),
        deposited: stores.some((store) => store.getProgressionStorage().deposited),
        retrieved: stores.some((store) => store.getProgressionStorage().retrieved),
      },
      stashFreeSlots: stashSummary.totalSlots > 0 ? stashSummary.freeSlots : null,
      stashTotalSlots: stashSummary.totalSlots > 0 ? stashSummary.totalSlots : null,
      shelterLit,
      ironToolEstablished,
      furnaceEstablished,
      usableFarmSite: !!farm || !!rememberedFarmSite,
      nearbyWater,
      visibleTrees,
      nearbyCraftingTable,
      nearFarm,
      farmLocation,
      houseLocation,
      mineLocation,
      scoutedSectors: scoutedSectors.size,
      safetyZones,
      nearbyAnimals,
      animalPens,
      farmLedgerReady,
      farmPlotsTotal: farmInspection.totalPlots,
      farmPlotsNeedingRepair: farmInspection.repairPlots,
      matureWheatNearby,
      inventoryStacks: this.bot.inventory.items().length,
      inventoryItems,
      recentlyFailed: new Set(this.recentFailures.keys()),
      teamCommitments: freshTeammates.map((teammate) => ({
        name: teammate.name,
        objectiveId: teammate.objectiveId,
        subobjectiveId: teammate.subobjectiveId,
      })),
    };
  }

  private objectiveTreeView(reconcile = true): ObjectiveTreeView {
    this.purgeExpiredFailures();
    const stores = [...new Set([this.memStore, ...getAllMemoryStores()])];
    const previous = { completedObjectives: [...new Set(stores.flatMap((store) => store.getProgressionObjectives()))] };
    const anchor = this.roleConfig.stashPos ?? this.homePos ?? this.bot.entity.position;
    const state = reconcileProgression(previous, observeProgression(this.bot, anchor));
    const newlyVerified = state.completedObjectives.filter((id) => !previous.completedObjectives.includes(id));
    for (const store of stores) store.saveProgressionObjectives(state.completedObjectives);
    if (newlyVerified.length) {
      const priorLocked = new Set(
        evaluateProgression(previous)
          .filter((stage) => stage.status === "locked")
          .map((stage) => stage.id),
      );
      const unlocked = evaluateProgression(state).filter(
        (stage) => stage.status !== "locked" && priorLocked.has(stage.id),
      );
      const message = `Verified team milestones: ${newlyVerified.join(", ")}${unlocked.length ? `. Unlocked: ${unlocked.map((stage) => stage.label).join(", ")}` : ""}`;
      this.log.info("Brain:progression", message);
      this.events.onAction("progression", message);
    }
    let view = buildProgressionView(this.buildObjectiveSnapshot(), state, this.memStore.getObjectiveCommitment());
    if (!reconcile || !view.commitment) return view;

    const reconciled = reconcileObjectiveCommitment(view);
    if (!reconciled.reason) return view;

    this.log.info("Brain:objective", reconciled.reason);
    if (!reconciled.commitment) {
      this.memStore.clearObjectiveCommitment(reconciled.reason);
    } else {
      this.memStore.replaceObjectiveCommitment(reconciled.commitment);
    }
    view = buildProgressionView(this.buildObjectiveSnapshot(), state, this.memStore.getObjectiveCommitment());
    return view;
  }

  /** Build the world context string for strategic decisions. */
  private buildContext(): string {
    // Re-check against current inventory before every strategic call. This
    // catches items received from teammates or crafted/placed between turns.
    if (this.currentGoal && this.goalStepsLeft <= 0) {
      this.clearActiveGoal("step budget exhausted");
    } else {
      this.reconcileActiveGoal();
    }

    const worldContext = getWorldContext(this.bot);
    let ctx = `CURRENT STATE:\n${worldContext}`;

    // Pending chat messages
    if (this.pendingChatMessages.length > 0) {
      const chatStr = this.pendingChatMessages.map((m) => `[${m.source}] ${m.username}: ${m.message}`).join("\n");
      ctx += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
      this.pendingChatMessages.length = 0;
    }

    // Hierarchical settlement state replaces the old one-line inventory ladder.
    // It exposes needs and choices without selecting an objective for the LLM.
    ctx += `\n\n${renderObjectiveTreeReport(this.objectiveTreeView())}`;
    ctx += `\n\n${renderProgressionReport({ completedObjectives: this.memStore.getProgressionObjectives() })}`;

    // Current goal
    if (this.currentGoal && this.goalStepsLeft > 0) {
      ctx += `\n\nCURRENT GOAL: "${this.currentGoal}" (${this.goalStepsLeft} steps left). Continue.`;
      const assessment = this.assessActiveGoal();
      if (assessment.wood) ctx += `\n${formatWoodRequirement(assessment.wood)}`;
      if (assessment.item) ctx += `\n${formatItemRequirement(assessment.item)}`;
    }

    // Last action result
    if (this.lastAction && this.lastResult) {
      ctx += `\n\nLAST ACTION: ${this.lastAction} → ${this.lastResult}`;
    }

    // Leash enforcement
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 0.8) {
        ctx += `\n\nLEASH WARNING: ${dist.toFixed(0)} blocks from home (max: ${this.roleConfig.leashRadius}). Head back to (${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}).`;
      }
    }

    // Stash position
    if (this.roleConfig.stashPos) {
      const { x, y, z } = this.roleConfig.stashPos;
      ctx += `\n\nTHE STASH: Shared chest area at (${x}, ${y}, ${z}).`;
    }

    // Team bulletin
    const teamStatus = formatTeamBulletin(this.roleConfig.name);
    if (teamStatus) ctx += `\n${teamStatus}`;

    if (this.roleConfig.allowedSkills.includes("build_structure")) {
      const structures = getAllMemoryStores()
        .flatMap((store) => [...store.getStructures()])
        .filter((structure) => this.belongsToCurrentSettlement(structure));
      const status = (type: "house" | "warehouse" | "workshop") => {
        const matches = structures.filter((structure) => structure.type === type);
        if (matches.some((structure) => !(structure.notes ?? "").includes("(partial)"))) return "complete";
        if (matches.length > 0) return "PARTIAL — resume it";
        return "missing";
      };
      ctx += `\n\nSETTLEMENT PROJECTS: house=${status("house")}; warehouse=${status("warehouse")}; workshop=${status("workshop")}. Build in that order and finish partial projects first.`;
    }

    // Recent failures
    this.purgeExpiredFailures();
    if (this.recentFailures.size > 0) {
      const lines: string[] = [];
      for (const [k, v] of this.recentFailures.entries()) {
        lines.push(`- ${k.replace(/^skill:/, "")}: ${v}`);
      }
      ctx += `\n\nRECENTLY FAILED (do NOT retry):\n${lines.join("\n")}`;
    }

    ctx += "\n\nWhat should you do next? Respond with JSON.";
    return ctx;
  }

  /** Flat mechanical affordances used as leaves beneath the objective tree. */
  private baseActionMenu(): ActionOption[] {
    this.purgeExpiredFailures();
    this.rememberExplicitSkillRequests(this.memStore.getSeasonGoal() ?? "");
    const now = Date.now();
    for (const [name, expiresAt] of this.explicitSkillRequests) {
      if (expiresAt <= now) this.explicitSkillRequests.delete(name);
    }
    const completeStructures = new Set<string>();
    const knownLocations: { x: number; y: number; z: number; label: string }[] = [];
    for (const store of getAllMemoryStores()) {
      for (const structure of store.getStructures()) {
        if (!this.belongsToCurrentSettlement(structure)) continue;
        if (!(structure.notes ?? "").includes("(partial)")) {
          completeStructures.add(structure.type);
          knownLocations.push({
            x: structure.x,
            y: structure.y,
            z: structure.z,
            label: structure.type,
          });
        }
      }
      for (const site of store.getFarmSites()) {
        if (site.status === "blocked") continue;
        knownLocations.push({
          ...site.approach,
          label: `farm shore (${site.status})`,
        });
      }
    }
    if (this.roleConfig.stashPos) {
      knownLocations.unshift({ ...this.roleConfig.stashPos, label: "stash/base" });
    }
    if (this.homePos) {
      knownLocations.push({ ...this.homePos, label: "home" });
    }
    const assessment = this.currentGoal ? this.assessActiveGoal() : { goalComplete: false as const };
    return buildActionMenu(this.bot, {
      roleName: this.roleConfig.name,
      role: this.roleConfig.role,
      preferredActions: this.roleConfig.allowedActions,
      preferredSkills: this.roleConfig.allowedSkills,
      goal: this.currentGoal,
      recentlyFailed: new Set(this.recentFailures.keys()),
      stashPos: this.roleConfig.stashPos,
      structures: completeStructures,
      woodNeeded: assessment.wood ? !assessment.wood.satisfied : false,
      pendingPlayerMessage: this.pendingChatMessages.length > 0,
      explicitlyRequestedSkills: new Set(this.explicitSkillRequests.keys()),
      knownLocations: knownLocations.filter(
        (location, index, all) =>
          all.findIndex(
            (candidate) => candidate.x === location.x && candidate.y === location.y && candidate.z === location.z,
          ) === index,
      ),
    });
  }

  /** One canonical hierarchical menu feeds the model and final execution gate. */
  private currentActionMenu(): ActionOption[] {
    const base = this.baseActionMenu();
    return buildObjectiveDecisionMenu(this.objectiveTreeView(), base);
  }

  private rememberExplicitSkillRequests(text: string): void {
    const normalize = (value: string) =>
      value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const normalizedText = normalize(text);
    if (!normalizedText) return;
    for (const name of getDynamicSkillNames()) {
      const normalizedName = normalize(name);
      if (normalizedName.length >= 6 && normalizedText.includes(normalizedName)) {
        this.explicitSkillRequests.set(name, Date.now() + 10 * 60_000);
      }
    }
  }

  private publishBulletin(action: string, thought: string, result: string): void {
    const commitment = this.memStore.getObjectiveCommitment();
    updateBulletin({
      name: this.roleConfig.name,
      action,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      thought,
      health: this.bot.health,
      food: this.bot.food,
      timestamp: Date.now(),
      goal: this.currentGoal || commitment?.objectiveId,
      lastResult: result.slice(0, 120),
      inventory: this.inventoryRecord(this.bot.inventory.items()),
      objectiveId: commitment?.objectiveId,
      subobjectiveId: commitment?.subobjectiveId,
    });
  }

  private scheduleHierarchicalContinuation(delayMs = 250): void {
    // Objective/sub-objective descent is one logical decision cycle. Bypass
    // the ordinary strategic cooldown so it does not add 8-10 seconds between
    // selecting a branch and Mineflayer starting its deterministic procedure.
    this.lastStrategicMs = 0;
    setTimeout(() => this.triggerReplan(), delayMs);
  }

  private resetObjectiveRecovery(): void {
    this.objectiveRecoveryCycles = 0;
    this.objectiveRetryAt = 0;
    if (this.objectiveRetryTimer) clearTimeout(this.objectiveRetryTimer);
    this.objectiveRetryTimer = null;
  }

  private scheduleObjectiveRetry(delayMs: number): void {
    this.objectiveRetryAt = Math.max(this.objectiveRetryAt, Date.now() + delayMs);
    if (this.objectiveRetryTimer) return;
    this.objectiveRetryTimer = setTimeout(
      () => {
        this.objectiveRetryTimer = null;
        if (this.stopped) return;
        this.triggerReplan();
      },
      Math.max(250, this.objectiveRetryAt - Date.now()),
    );
    this.objectiveRetryTimer.unref?.();
  }

  private deferActiveSubobjective(subobjectiveId: string, reason: string, delayMs: number): void {
    this.objectiveRecoveryCycles++;
    this.objectiveAutoSteps = 0;
    this.objectiveAutoFailures = 0;

    // Give deterministic recovery several bounded chances without paying for
    // another objective/sub-objective LLM round every six seconds. After five
    // unchanged recovery windows, release and cooldown the branch so another
    // genuinely useful objective can be chosen.
    if (this.objectiveRecoveryCycles >= 5) {
      this.blockAction(`objective:${subobjectiveId}`, `${subobjectiveId} blocked after recovery: ${reason}`);
      this.memStore.clearObjectiveSubobjective();
      this.lastResult = `${subobjectiveId} released after five deterministic recovery windows: ${reason}`;
      this.resetObjectiveRecovery();
      this.events.onAction("objective_blocked", this.lastResult);
      this.scheduleHierarchicalContinuation();
      return;
    }

    this.lastResult = `${subobjectiveId} paused for deterministic recovery (${this.objectiveRecoveryCycles}/5): ${reason}`;
    this.lastActionWasSuccess = false;
    this.lastActionWasExecuted = false;
    this.events.onAction("objective_recovery", this.lastResult);
    this.scheduleObjectiveRetry(delayMs);
  }

  private rejectObjectiveControl(action: string, reason: string): void {
    const result = `Rejected before execution: ${reason}`;
    this.events.onAction(action, result);
    this.lastAction = action;
    this.lastResult = result;
    this.lastActionWasSuccess = false;
    this.lastActionWasExecuted = false;
    this.rememberHistory({
      role: "assistant",
      content: `My proposed ${action} was rejected before execution: ${reason}`,
    });
    this.scheduleHierarchicalContinuation();
  }

  private handleObjectiveControlDecision(
    decision: {
      thought: string;
      action: string;
      params: Record<string, any>;
    },
    advertisedMenu: readonly ActionOption[],
  ): void {
    const params = { ...(decision.params ?? {}) };
    const validation = validateDecisionAgainstMenu(this.bot, { action: decision.action, params }, advertisedMenu);
    if (!validation.ok) {
      this.rejectObjectiveControl(decision.action, validation.reason ?? "invalid objective choice");
      return;
    }

    let result = "";
    if (decision.action === "choose_objective") {
      const objective = String(params.objective ?? "");
      if (!isObjectiveId(objective)) {
        this.rejectObjectiveControl(decision.action, `"${objective}" is not a known objective.`);
        return;
      }
      this.clearActiveGoal("hierarchical project selected");
      this.memStore.chooseObjective(objective, decision.thought);
      this.objectiveAutoSteps = 0;
      this.objectiveAutoFailures = 0;
      this.lastAutomaticSubobjective = "";
      this.resetObjectiveRecovery();
      result = `Committed to objective: ${objective}. Choose an approach next.`;
    } else if (decision.action === "choose_subobjective") {
      const subobjective = String(params.subobjective ?? "");
      const commitment = this.memStore.chooseSubobjective(subobjective);
      if (!commitment) {
        this.rejectObjectiveControl(decision.action, "Choose a high-level objective first.");
        return;
      }
      this.objectiveAutoSteps = 0;
      this.objectiveAutoFailures = 0;
      this.lastAutomaticSubobjective = subobjective;
      this.resetObjectiveRecovery();
      result = `Committed to sub-objective: ${subobjective}. Mineflayer will execute its procedure automatically.`;
    } else {
      const reason = String(params.reason ?? decision.thought ?? "reprioritized");
      this.memStore.clearObjectiveCommitment(reason);
      this.objectiveAutoSteps = 0;
      this.objectiveAutoFailures = 0;
      this.lastAutomaticSubobjective = "";
      this.resetObjectiveRecovery();
      result = `Left the active objective: ${reason}`;
    }

    this.lastAction = decision.action;
    this.lastResult = result;
    this.lastActionWasSuccess = true;
    this.lastActionWasExecuted = false;
    this.events.onAction(decision.action, result);
    this.publishBulletin(decision.action, decision.thought, result);
    this.rememberHistory({
      role: "assistant",
      content: `${decision.thought}. ${result}`,
    });
    this.scheduleHierarchicalContinuation();
  }

  private async runActiveSubobjective(): Promise<void> {
    const view = this.objectiveTreeView();
    const subobjective = view.activeSubobjective;
    if (!subobjective) {
      this.scheduleHierarchicalContinuation();
      return;
    }

    if (this.lastAutomaticSubobjective !== subobjective.id) {
      this.lastAutomaticSubobjective = subobjective.id;
      this.objectiveAutoSteps = 0;
      this.objectiveAutoFailures = 0;
      this.resetObjectiveRecovery();
    }
    if (this.objectiveRetryAt > Date.now()) {
      this.scheduleObjectiveRetry(this.objectiveRetryAt - Date.now());
      return;
    }
    if (this.objectiveAutoSteps >= 12) {
      const reason = `${subobjective.label} made twelve automatic steps without reaching its completion evidence.`;
      this.deferActiveSubobjective(subobjective.id, reason, 120_000);
      return;
    }

    const baseMenu = this.baseActionMenu();
    const advertisedMenu = buildObjectiveDecisionMenu(view, baseMenu);
    const automatic = getAutomaticSubobjectiveDecision(view, baseMenu);
    if (!automatic) {
      const reason = `${subobjective.label} has no executable procedure in the current state. Choose another approach.`;
      this.deferActiveSubobjective(subobjective.id, reason, 120_000);
      return;
    }

    this.objectiveAutoSteps++;
    this.events.onThought(`[${subobjective.label}] ${automatic.thought}`);
    await this.executeDecision(automatic, "objective", advertisedMenu);
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private async handleReactive(event: BrainEvent): Promise<void> {
    this.lastReactiveMs = Date.now();
    const { reason, entities, health, food } = event.data ?? {};

    // Build a tiny situation description
    let situation: string;
    if (reason === "hostile_nearby" && entities?.length) {
      const hostileList = entities
        .slice(0, 3)
        .map((e: Entity) => `${e.name || "mob"} (${e.position.distanceTo(this.bot.entity.position).toFixed(0)} blocks)`)
        .join(", ");
      const equipment =
        this.bot.inventory
          .items()
          .filter((i) => i.name.includes("sword") || i.name.includes("shield") || i.name.includes("bow"))
          .map((i) => i.name)
          .join(", ") || "bare hands";
      const foodItems =
        this.bot.inventory
          .items()
          .filter((i) =>
            ["bread", "cooked_beef", "cooked_porkchop", "apple", "cooked_chicken", "baked_potato"].includes(i.name),
          )
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "none";
      situation = `THREAT: ${hostileList}\nHealth: ${this.bot.health}/20, Food: ${this.bot.food}/20\nEquipment: ${equipment}\nFood items: ${foodItems}`;
    } else if (reason === "took_damage") {
      situation = `TOOK DAMAGE! Health: ${this.bot.health}/20. Check for nearby threats and react.`;
    } else if (reason === "low_health") {
      situation = `LOW HEALTH: ${this.bot.health}/20. Eat food or flee to safety.`;
    } else if (reason === "low_hunger") {
      situation = `LOW HUNGER: ${this.bot.food}/20. Eat something before starving.`;
    } else {
      situation = `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20. Assess situation.`;
    }

    const reactiveMenu = this.currentActionMenu().filter((option) =>
      ["eat", "flee", "attack", "neural_combat"].includes(option.action),
    );
    const decision = await queryReactive(this.roleConfig.name, situation, reactiveMenu);
    await this.executeDecision(decision, "llm", reactiveMenu);
    if (this.objectiveTreeView().activeSubobjective) {
      this.scheduleHierarchicalContinuation();
    }
  }

  private async handleChat(event: BrainEvent): Promise<void> {
    const msg = event.data as ChatMessage;
    if (!msg) return;

    const activity = `${this.lastAction || "exploring"} (${this.currentGoal || "no specific goal"})`;
    const response = await chatWithLLM(`[${msg.source}] ${msg.username}: ${msg.message}`, activity, {
      name: this.roleConfig.name,
    });

    const chatFilter = filterChatMessage(response);
    const safeResponse = chatFilter.safe ? response : chatFilter.cleaned;

    this.bot.chat(safeResponse);
    this.events.onChat(safeResponse);
    addChatMessage(this.roleConfig.name, safeResponse, "bot");
  }

  private async handleStrategic(event: BrainEvent): Promise<void> {
    const now = Date.now();
    if (now - this.lastStrategicMs < this.STRATEGIC_COOLDOWN_MS) return;
    this.lastStrategicMs = now;

    // Safety overrides first
    if (await this.runSafetyOverrides()) return;

    // Survival override: starvation was killing the team (whole roster at
    // hunger 0, 286 failed "eat" attempts in one run). If hungry with no food
    // on hand, withdraw food from the stash so auto-eat has fuel — no waiting
    // on the LLM to figure out the farm→bake→eat loop.
    const FOOD_NAMES = [
      "bread",
      "cooked_beef",
      "cooked_porkchop",
      "cooked_chicken",
      "cooked_mutton",
      "apple",
      "carrot",
      "baked_potato",
    ];
    if (config.bot.allowInterventions && this.bot.food <= 10 && this.roleConfig.stashPos) {
      const hasFood = this.bot.inventory.items().some((i) => FOOD_NAMES.some((f) => i.name.includes(f)));
      if (!hasFood) {
        // Survival safety net. Routing starving bots to a chest proved
        // hopeless — withdraw_stash's pathfinding fails ("Path was stopped")
        // even after teleporting them onto the stash, so distant bots starved
        // to death on loop (Atlas repeatedly hit hunger 0). Like keepInventory
        // and the safety teleports, this is a survival floor, not a gameplay
        // mechanic: give a small ration directly (bots are ops) so auto-eat
        // has fuel. The farm/cooking economy still runs for real food.
        // Saturation EFFECT, not an item: /give depends on inventory + auto-eat
        // timing and left Forge stuck at hunger 4. The effect refills hunger
        // directly with zero dependencies — the bulletproof survival floor.
        // Also hand over a few cooked_beef so they have reserves to eat normally.
        this.log.info("Brain", `SURVIVAL: hungry (${this.bot.food}/20), no food — saturation ration`);
        this.bot.chat(`/effect give ${this.bot.username} minecraft:saturation 2 3 true`);
        this.bot.chat(`/give ${this.bot.username} minecraft:cooked_beef 4`);
        await new Promise((r) => setTimeout(r, 600));
        this.events.onAction("eat", "Survival ration — recovered hunger.");
        this.lastAction = "eat";
        this.lastResult = "Recovered hunger with a ration.";
        return;
      }
    }

    // Leash hard override — skip LLM entirely if way too far from home
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 1.5) {
        this.log.info("Brain", `LEASH: ${dist.toFixed(0)} blocks away — forcing return home`);
        const directDistance = this.bot.entity.position.distanceTo(
          new Vec3(this.homePos.x, this.homePos.y, this.homePos.z),
        );
        const returnTarget =
          directDistance <= 190
            ? this.homePos
            : {
                x: Math.round(
                  this.bot.entity.position.x + (this.homePos.x - this.bot.entity.position.x) * (180 / directDistance),
                ),
                y: Math.round(this.bot.entity.position.y),
                z: Math.round(
                  this.bot.entity.position.z + (this.homePos.z - this.bot.entity.position.z) * (180 / directDistance),
                ),
              };
        const result = await executeAction(this.bot, "go_to", returnTarget);
        this.events.onAction("go_to", result);
        return;
      }
    }

    // Once the LLM has selected a sub-objective, it is no longer asked to
    // choose individual skills. Resume the stored deterministic procedure
    // directly (including after a restart) until it completes or blocks.
    if (this.objectiveTreeView().activeSubobjective) {
      await this.runActiveSubobjective();
      return;
    }

    const actionOptions = this.currentActionMenu();
    const hierarchySelection = actionOptions.some(
      (option) =>
        option.action === "choose_objective" ||
        option.action === "choose_subobjective" ||
        option.action === "leave_objective",
    );
    if (hierarchySelection) {
      this.clearActiveGoal("the objective tree is awaiting a strategic selection");
    }

    const context = this.buildContext();
    const memoryCtx = this.memStore.getMemoryContext();
    const queryMemoryCtx = hierarchySelection ? "" : memoryCtx;
    const role: RoleContext = {
      name: this.roleConfig.name,
      personality: this.roleConfig.personality,
      role: this.roleConfig.role,
      seasonGoal: this.memStore.getSeasonGoal(),
      allowedActions: this.roleConfig.allowedActions,
      allowedSkills: this.roleConfig.allowedSkills,
      priorities: this.roleConfig.priorities,
      actionOptions,
    };

    // Old action history is actively misleading while the model is choosing
    // an objective level: it contains gather/craft/build calls that are
    // intentionally unavailable here. Give this small choice a clean turn.
    const decision = await queryStrategic(context, hierarchySelection ? [] : this.recentHistory, queryMemoryCtx, role);
    await this.executeDecision(decision, "llm", actionOptions);

    // Capture the trajectory for fine-tuning: exact prompt -> decision -> outcome
    recordTrajectory({
      bot: this.roleConfig.name,
      system: buildStrategicPrompt(role),
      context: queryMemoryCtx ? `YOUR MEMORY:\n${queryMemoryCtx}\n${context}` : context,
      decision: { thought: decision.thought, action: decision.action, params: decision.params, goal: decision.goal },
      result: this.lastResult,
      success: this.lastActionWasSuccess,
      executed: this.lastActionWasExecuted,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleCritic(event: BrainEvent): Promise<void> {
    if (!this.CRITIC_ENABLED) return;
    // The critic may evaluate ordinary LLM actions, but it must never turn
    // into a second skill selector inside an active deterministic procedure.
    if (this.objectiveTreeView().activeSubobjective) return;
    const { action, result, goal } = event.data ?? {};
    if (!action || !result) return;

    // Skip critic for trivial actions
    if (["idle", "chat", "respond_to_chat"].includes(action)) return;

    const criticContext = [
      `Action: ${action}`,
      `Result: ${result}`,
      goal ? `Goal: ${goal} (${this.goalStepsLeft} steps left)` : "No active goal.",
      `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20`,
      `Inventory: ${
        this.bot.inventory
          .items()
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "empty"
      }`,
    ].join("\n");

    const criticMenu = this.currentActionMenu();
    const verdict = await queryCritic(this.roleConfig.name, criticContext, criticMenu);

    // Update thought display
    if (verdict.thought) {
      this.events.onThought(`[critic] ${verdict.thought}`);
    }

    if (verdict.goalComplete) {
      this.clearActiveGoal("critic verified completion");
      // Trigger strategic re-plan after a brief pause
      setTimeout(() => this.triggerReplan(), 1000);
    } else if (verdict.nextAction && verdict.success) {
      // Critic suggests next step — execute directly without full LLM call
      this.log.debug("Brain:critic", `Next step: ${verdict.nextAction}`);
      await this.executeDecision(
        {
          thought: verdict.thought,
          action: verdict.nextAction,
          params: verdict.nextParams,
        },
        "llm",
        criticMenu,
      );
    } else if (!verdict.success) {
      // Action failed — trigger strategic re-plan
      this.log.info("Brain:critic", "Action failed. Re-planning.");
      setTimeout(() => this.triggerReplan(), 500);
    }
  }

  // ─── Action execution ─────────────────────────────────────────────────────

  private async executeDecision(
    decision: {
      thought: string;
      action: string;
      params: Record<string, any>;
      goal?: string;
      goalSteps?: number;
    },
    source: "llm" | "objective" = "llm",
    advertisedMenu?: readonly ActionOption[],
  ): Promise<void> {
    // Only set true immediately before a validated Mineflayer execution.
    // Strategic telemetry can then distinguish rejected/no-op proposals from
    // real gameplay successes and failures.
    this.lastActionWasExecuted = false;

    // Filter thought for safety
    const thoughtFilter = filterContent(decision.thought);
    if (!thoughtFilter.safe) {
      decision.thought = thoughtFilter.cleaned;
    }

    // Filter chat actions
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && decision.params?.message) {
      const chatFilter = filterChatMessage(decision.params.message);
      if (!chatFilter.safe) {
        decision.params.message = chatFilter.cleaned;
      }
    }

    // Display thought
    this.events.onThought(decision.thought);
    this.log.info("Brain", `"${decision.thought}" → ${decision.action}`);
    this.log.debug("Brain", "Decision params:", JSON.stringify(decision.params));

    // Update overlay
    updateOverlay({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      thought: decision.thought,
      action: decision.action,
      actionResult: "...",
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // Speech narration disabled; thoughts remain visible in the overlay and logs.

    // Unwrap invoke_skill aliasing a built-in action (e.g. {"skill":"deposit_stash"})
    // so gating and param injection below see the real action.
    const BUILTIN_VIA_SKILL = new Set(["deposit_stash", "withdraw_stash", "gather_wood", "eat", "flee", "explore"]);
    if (decision.action === "invoke_skill" && BUILTIN_VIA_SKILL.has(decision.params?.skill)) {
      decision.action = decision.params.skill;
      delete decision.params.skill;
    }

    if (["choose_objective", "choose_subobjective", "leave_objective"].includes(decision.action)) {
      this.handleObjectiveControlDecision(decision, advertisedMenu ?? this.currentActionMenu());
      return;
    }

    if (
      source === "llm" &&
      this.objectiveTreeView().activeSubobjective &&
      !["eat", "flee", "attack", "neural_combat"].includes(decision.action)
    ) {
      this.rejectObjectiveControl(
        decision.action,
        "An active sub-objective owns its internal actions; only an immediate survival action may interrupt it.",
      );
      return;
    }

    // Activate before execution so a newly proposed gather action can be
    // checked against inventory immediately. Repeated copies of the same goal
    // do not refresh its countdown.
    this.activateGoal(decision.goal, decision.goalSteps);

    // Never spend a pathfinding/action cycle gathering wood that this
    // objective no longer needs. For a pure gather goal this also clears the
    // goal; for a house/farm/tool project it retains the project and asks the
    // planner to perform the actual build/craft or address a non-wood blocker.
    if (decision.action === "gather_wood" && source === "llm") {
      const goalForAssessment = this.currentGoal || "gather wood";
      const assessment = assessWoodGatherDecision(goalForAssessment, inventoryCounts(this.bot.inventory.items()), {
        nearbyCraftingTable: this.nearbyCraftingTable(),
        woodTargetOverride: this.goalWoodTargetOverride,
      });
      if (assessment.goalComplete || assessment.wood?.satisfied) {
        const msg = assessment.goalComplete
          ? `Skipped gather_wood: ${assessment.goalCompleteReason ?? "the current goal is already complete"}. Choose a new objective.`
          : `Skipped gather_wood: wood is already sufficient for ${assessment.wood?.purpose ?? "the current objective"}. Continue the actual objective or obtain its non-wood requirements.`;
        this.log.info("Brain:goal", msg);
        this.events.onAction("gather_wood", msg);
        this.lastAction = "gather_wood";
        this.lastResult = msg;
        this.lastActionWasSuccess = true;
        if (assessment.goalComplete) {
          this.clearActiveGoal(assessment.goalCompleteReason ?? "wood target reached");
        }
        setTimeout(() => this.triggerReplan(), 250);
        return;
      }
    }

    // Small output goals are especially prone to inventory-blind repetition
    // ("craft sticks" with ten stacks already held, or "craft torches" while
    // carrying torches). Check the requested item itself even when the model
    // attached the craft action to an unrelated high-level goal.
    if (decision.action === "craft") {
      const rawItem = String(decision.params?.item ?? (decision as Record<string, any>).item ?? "").toLowerCase();
      if (rawItem === "stick" || rawItem === "torch") {
        const rawCount = Number(decision.params?.count ?? (decision as Record<string, any>).count);
        const impliedGoal = `craft ${Number.isFinite(rawCount) && rawCount > 0 ? `${rawCount} ` : ""}${rawItem}`;
        const activeAssessment = this.currentGoal ? this.assessActiveGoal() : { goalComplete: false as const };
        const itemAssessment =
          activeAssessment.item?.item === rawItem
            ? activeAssessment
            : assessGoal(impliedGoal, inventoryCounts(this.bot.inventory.items()));
        if (itemAssessment.item?.satisfied) {
          const requirement = itemAssessment.item;
          const msg = `Skipped craft ${rawItem}: already have ${requirement.current}/${requirement.target}. Continue the objective without making more.`;
          this.log.info("Brain:goal", msg);
          this.events.onAction("craft", msg);
          this.lastAction = "craft";
          this.lastResult = msg;
          this.lastActionWasSuccess = true;
          if (itemAssessment.goalComplete) {
            this.clearActiveGoal(itemAssessment.goalCompleteReason ?? `${rawItem} target reached`);
          }
          setTimeout(() => this.triggerReplan(), 250);
          return;
        }
        if (itemAssessment.item && itemAssessment.item.deficit > 0) {
          // `craft` count means desired output items (the action converts that
          // to recipe executions). Fill only the missing amount, rounded by
          // Minecraft's recipe batch size inside craftItem.
          decision.params = {
            ...(decision.params ?? {}),
            item: rawItem,
            count: itemAssessment.item.deficit,
          };
        }
      }
    }

    // Roles are behavioral guidance, not capability restrictions. Every bot
    // may attempt every action implemented by executeAction and every skill in
    // the shared registry. Unknown names flow through the executor, produce a
    // normal classified failure, and are then suppressed by recentFailures.

    // ── Blacklist check ──
    this.purgeExpiredFailures();
    const actionKey = this.getActionKey(decision);
    if (this.recentFailures.has(actionKey)) {
      const blockMsg = `Blocked: "${actionKey}" recently failed. Try something else.`;
      this.log.debug("Brain", blockMsg);
      this.events.onAction(decision.action, blockMsg);
      this.lastAction = decision.action;
      this.lastResult = blockMsg;
      this.lastActionWasSuccess = false;
      // Trigger re-plan since this action was blocked
      setTimeout(() => this.triggerReplan(), 500);
      return;
    }

    // ── Normalize params ──
    const normalizedParams = { ...(decision.params ?? {}) };
    const rawDecision = decision as Record<string, any>;
    for (const field of [
      "direction",
      "skill",
      "item",
      "block",
      "blockType",
      "count",
      "x",
      "y",
      "z",
      "message",
      "objective",
      "subobjective",
      "reason",
    ]) {
      if (rawDecision[field] !== undefined && normalizedParams[field] === undefined) {
        normalizedParams[field] = rawDecision[field];
      }
    }

    // The exact menu advertised to the model remains the authority for this
    // decision. Rebuilding it here introduced a race: a teammate bulletin or
    // live inventory observation could change the hierarchy between response
    // generation and validation, rejecting a choice that was valid when shown.
    // Recipe and coordinate validation still inspect the live bot state.
    const executionMenu = advertisedMenu ?? this.currentActionMenu();
    const validation = validateDecisionAgainstMenu(
      this.bot,
      { action: decision.action, params: normalizedParams },
      executionMenu,
    );
    if (!validation.ok) {
      const msg = `Rejected before execution: ${validation.reason}`;
      this.log.info("Brain:gate", msg);
      this.events.onAction(decision.action, msg);
      this.lastAction = decision.action;
      this.lastResult = msg;
      this.lastActionWasSuccess = false;
      if (
        executionMenu.some((option) => option.action === "choose_objective" || option.action === "choose_subobjective")
      ) {
        this.clearActiveGoal("invalid legacy action proposed during hierarchical selection");
      }
      this.rememberHistory({
        role: "assistant",
        content: `My proposed ${decision.action} was rejected before execution: ${validation.reason}`,
      });
      setTimeout(() => this.triggerReplan(), 250);
      return;
    }

    // Chat dedup — refuse to re-broadcast a near-identical message
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && normalizedParams.message) {
      const sig = String(normalizedParams.message).slice(0, 40);
      if (sig === this.lastChatSent && Date.now() - this.lastChatSentMs < 180_000) {
        const msg =
          "You already said that. Talking won't make it happen — ACT instead (check your inventory first; you may already have what you asked for).";
        this.events.onAction(decision.action, msg);
        this.lastAction = decision.action;
        this.lastResult = msg;
        this.lastActionWasSuccess = false;
        return;
      }
      this.lastChatSent = sig;
      this.lastChatSentMs = Date.now();
    }

    if (decision.action === "gather_wood" && this.roleConfig.stashPos) {
      normalizedParams.settlementAnchor = this.roleConfig.stashPos;
    }

    // Inject stash config
    if ((decision.action === "deposit_stash" || decision.action === "withdraw_stash") && this.roleConfig.stashPos) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
      normalizedParams.keepItems = this.roleConfig.keepItems;
    }

    // Protect the village site from being strip-mined into bot-trapping pits
    if (decision.action === "mine_block" && this.roleConfig.stashPos) {
      normalizedParams.protectPos = this.roleConfig.stashPos;
    }

    // Build only at a confirmed remembered shore. A base-coordinate fallback
    // made an underground pool near the settlement masquerade as a farm site.
    const isBuildFarm =
      decision.action === "build_farm" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_farm");
    if (isBuildFarm && normalizedParams.x === undefined) {
      const farmLocation = this.buildObjectiveSnapshot().farmLocation;
      if (farmLocation) {
        normalizedParams.x = farmLocation.x;
        normalizedParams.y = farmLocation.y;
        normalizedParams.z = farmLocation.z;
      }
    }
    // build_farm pools seeds before construction and wheat before baking.
    if (isBuildFarm && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    const isMaintainFarm =
      decision.action === "maintain_farm" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "maintain_farm");
    if (isMaintainFarm && normalizedParams.farmLocation === undefined) {
      const farmLocation = this.buildObjectiveSnapshot().farmLocation;
      if (farmLocation) normalizedParams.farmLocation = farmLocation;
    }
    if (isMaintainFarm && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    const isLocateFarm =
      decision.action === "locate_farm_site" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "locate_farm_site");
    if (isLocateFarm && this.roleConfig.stashPos && normalizedParams.settlementAnchor === undefined) {
      normalizedParams.settlementAnchor = this.roleConfig.stashPos;
    }

    const isSurveyRegion =
      decision.action === "survey_region" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "survey_region");
    if (isSurveyRegion && this.roleConfig.stashPos && normalizedParams.settlementAnchor === undefined) {
      normalizedParams.settlementAnchor = this.roleConfig.stashPos;
    }

    const isAnimalPen =
      decision.action === "establish_animal_pen" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "establish_animal_pen");
    if (isAnimalPen) {
      const snapshot = this.buildObjectiveSnapshot();
      if (snapshot.farmLocation && normalizedParams.farmLocation === undefined) {
        normalizedParams.farmLocation = snapshot.farmLocation;
      }
      if (this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
        normalizedParams.stashPos = this.roleConfig.stashPos;
      }
    }

    // Inject stash coordinates into setup_stash — the LLM invents garbage coords otherwise
    const isSetupStash =
      decision.action === "setup_stash" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "setup_stash");
    if (isSetupStash && this.roleConfig.stashPos) {
      normalizedParams.x = this.roleConfig.stashPos.x;
      normalizedParams.y = this.roleConfig.stashPos.y;
      normalizedParams.z = this.roleConfig.stashPos.z;
    }

    // Give smelt_ores the stash position so it can withdraw ore/fuel the team
    // already mined. Bots kept invoking smelt empty-handed ("Nothing to smelt"
    // / "No fuel") because the miner deposits ore+coal and a different bot
    // smelts — this connects them via the shared stash.
    const isSmelt =
      decision.action === "smelt_ores" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "smelt_ores");
    if (isSmelt && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Give craft_gear the stash position so it can withdraw iron ingots the team
    // already smelted (the stash is the shared warehouse — use it, per design).
    const isCraftGear =
      decision.action === "craft_gear" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "craft_gear");
    if (isCraftGear && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Every miner returns to the same recorded entrance. The skill derives its
    // actual site relative to this anchor and persists branch progress.
    const isStripMine =
      decision.action === "strip_mine" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "strip_mine");
    if (isStripMine && this.roleConfig.stashPos && normalizedParams.settlementAnchor === undefined) {
      normalizedParams.settlementAnchor = this.roleConfig.stashPos;
    }

    // build_house pulls planks/logs from the stash so the builder isn't blocked
    // chopping a whole house's worth of wood from scratch.
    const isBuildHouse =
      decision.action === "build_house" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_house");
    if (isBuildHouse && this.roleConfig.stashPos) {
      if (normalizedParams.stashPos === undefined) normalizedParams.stashPos = this.roleConfig.stashPos;
      if (normalizedParams.settlementAnchor === undefined) {
        normalizedParams.settlementAnchor = this.roleConfig.stashPos;
      }
    }

    const isBuildStructure =
      decision.action === "build_structure" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_structure");
    if (isBuildStructure && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // light_area pulls torches from the stash (or crafts them) so it stops
    // failing "No torches" — lit caves cut the top death cause (cave mobs).
    const isLightArea =
      decision.action === "light_area" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "light_area");
    if (isLightArea && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }
    if (isLightArea && normalizedParams.x === undefined) {
      const snapshot = this.buildObjectiveSnapshot();
      const zone = String(normalizedParams.safetyZone ?? "");
      const target =
        zone === "lodge"
          ? snapshot.houseLocation
          : zone === "farm"
            ? snapshot.farmLocation
            : zone === "mine"
              ? snapshot.mineLocation
              : this.roleConfig.stashPos;
      if (target) {
        normalizedParams.x = target.x;
        normalizedParams.y = target.y;
        normalizedParams.z = target.z;
      }
    }

    // ── Execute ──
    this.lastActionWasExecuted = true;
    this.publishBulletin(decision.action, decision.thought, "In progress...");
    const bulletinHeartbeat = setInterval(
      () => this.publishBulletin(decision.action, decision.thought, "Still in progress..."),
      10_000,
    );
    bulletinHeartbeat.unref?.();
    let result: string;
    const inventoryBefore = this.inventoryRecord(this.bot.inventory.items());
    try {
      result = await executeAction(this.bot, decision.action, normalizedParams);
    } finally {
      clearInterval(bulletinHeartbeat);
    }
    this.lastAction = decision.action;
    this.lastResult = result;
    this.events.onAction(decision.action, result);
    this.log.info("Brain", `Result: ${result}`);

    // Update team bulletin, including the persistent objective commitment.
    this.publishBulletin(decision.action, decision.thought, result);

    // Update overlay with result
    updateOverlay({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      actionResult: result,
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // ── Scoreboard ──
    // (isSuccess computed below — record after it)
    const isSuccess = actionResultSucceeded(result);
    if (isSuccess && ["deposit_stash", "withdraw_stash"].includes(decision.action)) {
      const inventoryAfter = this.inventoryRecord(this.bot.inventory.items());
      const changed = Object.keys({ ...inventoryBefore, ...inventoryAfter }).some((name) =>
        decision.action === "deposit_stash"
          ? (inventoryAfter[name] ?? 0) < (inventoryBefore[name] ?? 0)
          : (inventoryAfter[name] ?? 0) > (inventoryBefore[name] ?? 0),
      );
      if (changed)
        this.memStore.recordProgressionStorage(decision.action === "deposit_stash" ? "deposited" : "retrieved");
    }
    this.lastActionWasSuccess = isSuccess;
    recordAction(this.roleConfig.name, decision.action, result, isSuccess);
    if (decision.action === "invoke_skill" || skillRegistry.has(decision.action)) {
      recordSkillResult(this.roleConfig.name, isSuccess);
    }
    checkInventoryMilestones(this.bot, this.roleConfig.name);

    // Track repeats
    if (decision.action !== "idle") {
      if (actionKey === this.lastAction) {
        this.repeatCount++;
      } else {
        this.repeatCount = 1;
      }
    }

    // General repeat-breaker: the same action producing the SAME result 3x in
    // a row is a stuck loop — even if the action reports "success" (e.g. Flora
    // "withdrew" planks 6x that never arrived, or chat begging). Blacklist it
    // briefly and force a re-plan so no buggy effector can trap a bot forever.
    const resultSig = `${actionKey}|${result.slice(0, 60)}`;
    if (decision.action !== "idle" && resultSig === this.lastResultSig) {
      this.sameResultCount++;
      if (this.sameResultCount >= 2) {
        this.blockAction(actionKey, `Stuck repeating "${decision.action}" with no change — do something different.`);
        this.sameResultCount = 0;
        this.lastResultSig = "";
        setTimeout(() => this.triggerReplan(), 300);
      }
    } else {
      this.sameResultCount = 0;
      this.lastResultSig = resultSig;
    }

    // Failure tracking
    this.trackFailure(actionKey, decision, result, isSuccess);

    // Legacy free-text goals remain available only outside the hierarchical
    // objective executor. Persistent projects use observed completion evidence
    // from objectiveTreeView instead of a model-authored step countdown.
    // If the overall project is not complete, attempted non-trivial actions
    // consume its finite step budget. Counting failures too prevents an
    // impossible or badly phrased goal from persisting forever. A later goal
    // can independently request wood again
    // because every assessment uses the live inventory rather than a flag.
    if (source === "llm") {
      const partialHouse = result.match(/\bHouse partially built \((\d+)\/(\d+) blocks\)/i);
      if (
        partialHouse &&
        /\b(build|finish|complete|repair)\b/i.test(this.currentGoal) &&
        /\b(house|home|shelter)\b/i.test(this.currentGoal)
      ) {
        const placed = Number(partialHouse[1]);
        // Up to eight reported placements may be doors/table/torches rather
        // than plank blocks. Discount them before reducing the target so the
        // estimate cannot leave a resumed build short.
        const definitelyPlacedPlanks = Math.max(0, placed - 8);
        this.goalWoodTargetOverride = Math.max(0, HOUSE_WOOD_TARGET - definitelyPlacedPlanks);
      }
      const goalAssessment = this.reconcileActiveGoal(decision.action, result);
      if (goalAssessment.goalComplete) {
        setTimeout(() => this.triggerReplan(), 250);
      } else if (this.goalStepsLeft > 0 && !["idle", "chat", "respond_to_chat"].includes(decision.action)) {
        this.goalStepsLeft--;
        if (this.goalStepsLeft <= 0) {
          this.clearActiveGoal("step budget exhausted before proven completion");
          setTimeout(() => this.triggerReplan(), 250);
        }
      }
    }

    // Lock home position when first house built
    if (isSuccess && decision.action === "build_house" && !this.homePos) {
      const p = this.roleConfig.stashPos ?? this.bot.entity.position;
      this.homePos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      this.log.debug("Brain", `Home locked at ${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}`);
    }

    // Track history
    this.rememberHistory({
      role: "assistant",
      content:
        source === "objective"
          ? `My selected sub-objective automatically ran ${decision.action}. Result: ${result}`
          : `I decided to ${decision.action}: ${decision.thought}. Result: ${result}`,
    });

    if (source === "objective") {
      const active = this.memStore.getObjectiveCommitment();
      const subobjectiveId = active?.subobjectiveId;
      if (!isSuccess && subobjectiveId) {
        this.objectiveAutoFailures++;
        const missingPrecondition =
          /missing:|need \d|no (?:trees|water|seeds|food|hoe|torches?|fuel|coal|iron|pickaxe|furnace)|can't craft|not enough|could not find|no executable|terrain/i.test(
            result,
          );
        // A prerequisite miss gets one immediate reconciliation pass. Chunk
        // observations, collected drops, and stash summaries often land just
        // after the action result; abandoning on the first miss discarded a
        // viable work order before the new state became visible. The resolver
        // will select withdraw/craft/mine on the next pass when appropriate.
        const failureLimit = missingPrecondition ? 3 : 2;
        if (this.objectiveAutoFailures >= failureLimit) {
          this.deferActiveSubobjective(subobjectiveId, result.slice(0, 160), missingPrecondition ? 60_000 : 120_000);
          return;
        }
      } else if (isSuccess && ["expand_stash", "light_settlement"].includes(subobjectiveId ?? "")) {
        // These one-shot maintenance operations may not immediately update a
        // remotely observed capacity/light fact, but one successful run has
        // completed the selected task.
        this.memStore.clearObjectiveSubobjective();
      } else {
        this.objectiveAutoFailures = 0;
        this.resetObjectiveRecovery();
        this.objectiveTreeView(); // reconcile live completion evidence
      }
      this.scheduleHierarchicalContinuation();
      return;
    }

    // ── Trigger critic ──
    if (this.CRITIC_ENABLED && !["idle", "chat", "respond_to_chat"].includes(decision.action)) {
      this.pushEvent({
        type: "critic",
        priority: 6,
        data: {
          action: decision.action,
          result,
          goal: this.currentGoal,
        },
        timestamp: Date.now(),
      });
    }
  }

  // ─── Failure tracking ─────────────────────────────────────────────────────

  private getActionKey(decision: { action: string; params: Record<string, any> }): string {
    if (decision.action === "invoke_skill" && decision.params?.skill) {
      return `skill:${decision.params.skill}`;
    }
    if (skillRegistry.has(decision.action)) {
      return `skill:${decision.action}`;
    }
    if (decision.action === "craft" && decision.params?.item) {
      return `craft:${decision.params.item}`;
    }
    return decision.action;
  }

  private trackFailure(
    actionKey: string,
    decision: { action: string; params: Record<string, any> },
    result: string,
    isSuccess: boolean,
  ): void {
    // Hallucinated action names
    if (result.startsWith("Unknown action:")) {
      this.blockAction(decision.action, "Unknown action", BotBrain.FAILURE_TTL_STRUCTURAL_MS);
      return;
    }

    // Retired skills — put them straight into the do-NOT-retry prompt list
    // so the LLM stops re-picking them from conversation history.
    if (result.includes("is RETIRED")) {
      this.blockAction(
        actionKey,
        "Retired — proven broken, use basic actions instead",
        BotBrain.FAILURE_TTL_STRUCTURAL_MS,
      );
      return;
    }

    const isSkillAction =
      skillRegistry.has(decision.action) ||
      decision.action === "invoke_skill" ||
      decision.action === "neural_combat" ||
      decision.action === "generate_skill" ||
      decision.action === "craft";

    if (!isSkillAction) {
      // Track "attack" no-target failures
      if (decision.action === "attack" && /no mobs to attack nearby/i.test(result)) {
        const prevCount = (this.failureCounts.get("attack") ?? 0) + 1;
        this.failureCounts.set("attack", prevCount);
        if (prevCount >= 3) {
          this.blockAction("attack", "No mobs nearby — explore first");
        }
      } else if (decision.action === "attack" && isSuccess) {
        this.failureCounts.delete("attack");
        this.recentFailures.delete("attack");
      }
    }

    if (isSkillAction) {
      if (!isSuccess) {
        const isAlreadyRunning = result.startsWith("Already running skill");
        const isPreconditionFailure =
          /missing:|need \d|no water|no (?:reachable|usable) (?:surface water|farm shore)|farm shore|remembered farm shore|no seeds|no trees|no coal|no iron|no pickaxe|Can't craft|could not find|not enough|need to (mine|craft|find|smelt)|Can't sleep|terrain too rough|not nighttime|already sleeping|zzz/i.test(
            result,
          );

        if (!isAlreadyRunning && !isPreconditionFailure) {
          const prevCount = (this.failureCounts.get(actionKey) ?? 0) + 1;
          this.failureCounts.set(actionKey, prevCount);
          if (prevCount >= 2) {
            this.blockAction(actionKey, result.slice(0, 120));
          }
        } else if (!isAlreadyRunning && /no trees/i.test(result)) {
          this.blockAction(actionKey, "No trees — explore first");
        } else if (!isAlreadyRunning && /no water/i.test(result)) {
          this.blockAction(actionKey, "No water — explore first");
        }
      } else {
        this.failureCounts.delete(actionKey);
        this.recentFailures.delete(actionKey);
      }
    }

    // Expire old failures every 8 successes
    if (isSuccess) {
      this.successesSinceLastExpiry++;
      if (this.successesSinceLastExpiry >= 8 && this.recentFailures.size > 0) {
        this.successesSinceLastExpiry = 0;
        for (const [firstKey, firstMsg] of this.recentFailures.entries()) {
          if (!/no water found/i.test(firstMsg) && !/need 3 wool/i.test(firstMsg)) {
            this.recentFailures.delete(firstKey);
            break;
          }
        }
      }
    }

    // Dynamic precondition clearing
    for (const [key, msg] of this.recentFailures.entries()) {
      if (/missing.*coal/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "coal")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*stick/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "stick")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*wood|missing.*log|missing.*plank/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name.includes("log") || i.name.includes("planks"))
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/no torch/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "torch")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      }
    }
  }
}
