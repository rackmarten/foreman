// one live Claude session per chat thread, replacing chat.ts's
// spawn-per-turn bridge.
//
// What was wrong with a process per turn: every turn re-paid session startup,
// `--resume` re-read the whole transcript off disk (and sometimes failed,
// which chat.ts had to paper over by replaying the conversation into a fresh
// prompt), the operator saw nothing at all until the turn was completely
// finished, and a permission prompt had to be a chat message answered in
// prose because there was no live process to ask. A single `query()` held
// open with streaming input fixes all four: the session stays warm between
// turns, its messages stream out as they happen, and canUseTool is just a
// function call (see chat-permissions.ts).
//
// Two deliberate constraints on this file:
//
//  - The SDK is imported for TYPES ONLY. The real `query` arrives as an
//    injected dependency, loaded lazily the first time a session actually
//    starts, so the unit tests never load the SDK bundle and never risk
//    spawning a Claude process.
//  - Everything with logic worth checking (message -> event translation,
//    idle timeout, the input queue) is a pure function or a small class
//    with injected timers, tested separately from the session itself.

import type { HookCallback, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatEventBatcher, type PendingChatEvent } from "./chat-events.js";
import { createCanUseTool, type OperatorAnswer, type OperatorDecision } from "./chat-permissions.js";
import {
  listPermissionRules,
  patchChatThread,
  postChatEvents,
  postChatMessage,
  postChatUsage,
  postPermissionRule,
  revokePermissionRule,
  type ChatPermissionRule,
  type ChatPermissionRuleInput,
} from "./pinboard.js";
import { inheritedEnv, type SpawnEnv } from "./spawn-env.js";
import { evaluate as evaluateGate, hookOutput } from "./permission-gate.js";

// A session with no operator activity for this long is torn down: a live
// `query()` holds a Claude process, and a thread the operator wandered away
// from should not keep one. The next message simply starts a new session,
// resuming the stored claudeSessionId - so an idle teardown costs a warm
// start, never the conversation.
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type TimerHandle = unknown;

// ---------------------------------------------------------------------------
// Streaming input
// ---------------------------------------------------------------------------

// The SDK takes an AsyncIterable of user messages as its prompt; this is the
// writable end of one. Kept generic and dependency-free because the awkward
// cases (a push arriving before anything iterates, a push arriving while the
// consumer is parked awaiting the next item, ending mid-await) are exactly
// the ones a live chat hits and exactly the ones worth a unit test.
export class PushableStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

// ---------------------------------------------------------------------------
// SDK message -> pinboard events
// ---------------------------------------------------------------------------

export interface TranslatedMessage {
  events: PendingChatEvent[];
  /** Assistant text completed in this message, for the final agent message. */
  text: string;
  /** Session id the SDK reported, when this message carries one. */
  sessionId?: string;
  /** Set on a `result` message. `interim` means background work was still
   *  running when it arrived, so it is NOT the end of the turn - see
   *  translateSdkMessage's note on a past task. */
  result?: { isError: boolean; text: string; costUsd: number; durationMs: number; numTurns: number; interim: boolean };
  /** the SDK's running estimate of thinking tokens, during the
   *  redacted-thinking phase where there is no text to stream. */
  thinkingTokens?: number;
  /** every live background task after a membership change.
   *  REPLACE semantics - the SDK emits the whole set, not a delta. */
  backgroundTasks?: string[];
  /** the SDK's authoritative "this turn is genuinely over". */
  sessionIdle?: boolean;
}

export interface TranslateOptions {
  /** True when a background task (an async subagent) is still running, which
   *  makes an arriving `result` interim rather than final. */
  backgroundWork?: boolean;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string";
    })
    .map((block) => block.text)
    .join("");
}

// Pure, and the only place that knows the SDK's message shapes. Everything a
// reader of the thread should see during a turn is derived here; anything not
// recognised is deliberately dropped rather than forwarded as a raw blob,
// since the PWA renders these by kind.
export function translateSdkMessage(
  message: SDKMessage,
  turn: number,
  opts: TranslateOptions = {},
): TranslatedMessage {
  const events: PendingChatEvent[] = [];
  const msg = message as Record<string, unknown>;
  const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
  const base: TranslatedMessage = { events, text: "", ...(sessionId ? { sessionId } : {}) };

  if (message.type === "stream_event") {
    const event = message.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
    if (event?.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        events.push({ kind: "text_delta", payload: { text: event.delta.text }, turn });
      } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
        // only when there is actually text. During the API's
        // redacted-thinking phase a thinking_delta carries token counters and
        // an EMPTY `thinking` string - 39 of thread #32's 82 events were
        // those, every one rendering as nothing and every one still counting
        // against the 2000-event retention cap, which pushed real transcript
        // out. The progress those frames carry is picked up from the SDK's
        // own digested `thinking_tokens` message below instead.
        events.push({ kind: "thinking", payload: { text: event.delta.thinking }, turn });
      }
    }
    return base;
  }

  if (message.type === "assistant") {
    const content = (message.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as { type?: string; id?: string; name?: string; input?: unknown };
        if (block.type === "tool_use") {
          events.push({
            kind: "tool_start",
            payload: { toolUseId: block.id, name: block.name, input: block.input },
            turn,
          });
        }
      }
    }
    // Text deltas already streamed the same text; this is only collected for
    // the final agent message posted at the end of the turn.
    return { ...base, text: textOfContent(content) };
  }

  if (message.type === "user") {
    const content = (message.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (block.type === "tool_result") {
          const text = textOfContent(block.content) || (typeof block.content === "string" ? block.content : "");
          events.push({
            kind: "tool_end",
            payload: {
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              // Truncated on purpose: a tool_result can be an entire file,
              // and this is a progress view, not the transcript the model
              // sees.
              preview: text.slice(0, 2000),
            },
            turn,
          });
        }
      }
    }
    return base;
  }

  // The CLI's own retry notices. Dropped until 2026-09-19, which is what
  // made thread #40 look frozen: api.anthropic.com stopped answering for
  // most of two hours, the CLI sat in its 10-attempt retry ladder (each
  // attempt waiting out a ~300s request timeout or a 181s first-byte
  // window), and because nothing here translated a `system` message the
  // operator saw an empty transcript and no reason at all. The retry is the
  // right behaviour; hiding it is not. Emitted as `error` rather than a new
  // kind so this needs no pinboard/PWA change - the PWA renders an `error`
  // item inline and, since it carries no `interrupted` flag, leaves the turn
  // running, which is exactly what a retry is.
  if (message.type === "system") {
    const system = message as unknown as {
      subtype?: string;
      // SDKAPIRetryMessage: `error` is a reason enum ('overloaded',
      // 'server_error', ...), not an object.
      error?: unknown;
      attempt?: unknown;
      max_retries?: unknown;
      retry_delay_ms?: unknown;
      error_status?: unknown;
      no_response?: { waited_ms?: unknown };
      // The CLI's own transcript writes the same event with these names.
      // Cheap to accept, and it keeps this working for anything reading a
      // session's .jsonl rather than the live stream.
      retryAttempt?: unknown;
      maxRetries?: unknown;
      retryInMs?: unknown;
    };
    // A past task, the other half of the redacted-thinking problem: the SDK
    // digests those content-free thinking_delta frames into this, a running
    // estimate for the current thinking block. Not an event of its own -
    // one per second would be as much retention noise as the blanks were -
    // so it is handed to the session, which throttles it (see
    // THINKING_PROGRESS_INTERVAL_MS).
    if (system.subtype === "thinking_tokens") {
      const tokens = (message as unknown as { estimated_tokens?: unknown }).estimated_tokens;
      return typeof tokens === "number" ? { ...base, thinkingTokens: tokens } : base;
    }

    // the level signal behind the early-turn_end bug. A turn that
    // launches an async subagent gets a `result` the moment the MAIN model's
    // reply is done, while the subagent is still working - thread #32's turn
    // 2 ended at $0.11 and then streamed 40 more events, finishing at $0.40.
    // The SDK's own advice is to REPLACE the set on every payload rather than
    // pair start/stop edges, so a missed bookend cannot wedge the indicator.
    // `ambient` entries are housekeeping, not work, and are excluded.
    if (system.subtype === "background_tasks_changed") {
      const tasks = (message as unknown as { tasks?: { task_id?: unknown; ambient?: boolean }[] }).tasks;
      const ids = Array.isArray(tasks)
        ? tasks.filter((t) => t?.ambient !== true && typeof t?.task_id === "string").map((t) => t.task_id as string)
        : [];
      return { ...base, backgroundTasks: ids };
    }

    // "'idle' fires after heldBackResult flushes and the bg-agent
    // do-while exits - authoritative turn-over signal", per the SDK's own
    // documentation. This is what releases a held result.
    if (system.subtype === "session_state_changed") {
      const state = (message as unknown as { state?: unknown }).state;
      return state === "idle" ? { ...base, sessionIdle: true } : base;
    }

    if (system.subtype !== "api_retry" && system.subtype !== "api_error") return base;

    const num = (...values: unknown[]): number | null => {
      for (const value of values) if (typeof value === "number") return value;
      return null;
    };
    const attempt = num(system.attempt, system.retryAttempt);
    const max = num(system.max_retries, system.maxRetries);
    const retryIn = num(system.retry_delay_ms, system.retryInMs);
    const status = num(system.error_status);
    const waited = num(system.no_response?.waited_ms);

    const errorObject = system.error as { formatted?: unknown; message?: unknown } | undefined;
    const detail =
      (typeof system.error === "string" && system.error) ||
      (typeof errorObject?.formatted === "string" && errorObject.formatted) ||
      (typeof errorObject?.message === "string" && errorObject.message) ||
      "unknown API error";

    const parts = [status === null ? detail : `${detail} (HTTP ${status})`];
    // The first-byte case is the one that reads as a freeze: a single
    // attempt can sit for three minutes before it is even called a failure.
    if (waited !== null) parts.push(`no response for ${Math.round(waited / 1000)}s`);
    if (attempt !== null) parts.push(max !== null ? `retry ${attempt}/${max}` : `retry ${attempt}`);
    if (retryIn !== null) parts.push(`next in ${Math.round(retryIn / 100) / 10}s`);

    events.push({
      kind: "error",
      payload: {
        subtype: "api_retry",
        message: `API error - ${parts.join(", ")}`,
        // Not an interrupt: the turn is still open and the CLI is retrying.
        retrying: true,
        ...(attempt === null ? {} : { retryAttempt: attempt }),
        ...(max === null ? {} : { maxRetries: max }),
      },
      turn,
    });
    return base;
  }

  if (message.type === "result") {
    const result = message as unknown as {
      subtype: string;
      is_error?: boolean;
      result?: string;
      errors?: string[];
      total_cost_usd?: number;
      duration_ms?: number;
      num_turns?: number;
    };
    const isError = result.subtype !== "success" || result.is_error === true;
    const text = typeof result.result === "string" ? result.result : (result.errors ?? []).join("\n");
    if (isError) {
      events.push({ kind: "error", payload: { subtype: result.subtype, message: text }, turn });
    }
    // The cost tick is emitted either way - `cost` is documented as a running
    // total so spend is visible before the turn ends, and an interim result's
    // figure is exactly that. `turn_end` is not: claiming the turn is over
    // while a subagent is still streaming is the bug, and it also
    // made the per-turn cost the figure as of the subagent STARTING.
    const interim = opts.backgroundWork === true;
    events.push({
      kind: "cost",
      payload: {
        costUsd: result.total_cost_usd ?? 0,
        durationMs: result.duration_ms ?? 0,
        numTurns: result.num_turns ?? 0,
        ...(interim ? { interim: true } : {}),
      },
      turn,
    });
    if (!interim) events.push({ kind: "turn_end", payload: { isError }, turn });
    return {
      ...base,
      result: {
        isError,
        text,
        costUsd: result.total_cost_usd ?? 0,
        durationMs: result.duration_ms ?? 0,
        numTurns: result.num_turns ?? 0,
        interim,
      },
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Idle teardown
// ---------------------------------------------------------------------------

export class IdleTimer {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
    private readonly setTimer: (fn: () => void, ms: number) => TimerHandle = (fn, ms) => {
      const t = setTimeout(fn, ms);
      // A chat session must never be the reason `work chat daemon` cannot
      // exit on SIGTERM.
      if (typeof t.unref === "function") t.unref();
      return t;
    },
    private readonly clearTimerFn: (handle: TimerHandle) => void = (handle) => clearTimeout(handle as NodeJS.Timeout),
  ) {}

  /** Any activity - a message sent, a message received - defers teardown. */
  poke(): void {
    this.cancel();
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.onIdle();
    }, this.timeoutMs);
  }

  cancel(): void {
    if (this.handle === null) return;
    this.clearTimerFn(this.handle);
    this.handle = null;
  }

  get armed(): boolean {
    return this.handle !== null;
  }
}

// ---------------------------------------------------------------------------
// Stall heartbeat
// ---------------------------------------------------------------------------

// The other half of thread #40's silence. Surfacing the CLI's api_error
// notices covers the retries it tells us about, but there are windows where
// nothing arrives at all - 8.5 minutes between a turn starting and the first
// retry notice, in that thread - and an operator watching a transcript that
// has not moved cannot tell "thinking hard" from "wedged".
//
// So: while a turn is open, if no SDK message has arrived for `intervalMs`,
// say so, and keep saying so until something does. Deliberately separate
// from IdleTimer, which answers a different question (should this session
// still be holding a Claude process at all) with a much longer fuse and a
// teardown instead of a notice.
export class StallWatchdog {
  private handle: TimerHandle | null = null;
  private quietSince = 0;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onStall: (quietMs: number) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: (fn: () => void, ms: number) => TimerHandle = (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === "function") t.unref();
      return t;
    },
    private readonly clearTimerFn: (handle: TimerHandle) => void = (handle) => clearTimeout(handle as NodeJS.Timeout),
  ) {}

  /** Start (or restart) watching - called when a turn begins. */
  start(): void {
    this.stop();
    this.running = true;
    this.quietSince = this.now();
    this.arm(this.intervalMs);
  }

  /** Any SDK message, resetting the quiet clock. Re-arming off `quietSince`
   *  rather than re-scheduling a whole interval on every message keeps a
   *  chatty turn from being free - the report still lands `intervalMs` after
   *  the last thing that happened, whenever that was. */
  poke(): void {
    if (!this.running) return;
    this.quietSince = this.now();
  }

  stop(): void {
    this.running = false;
    if (this.handle === null) return;
    this.clearTimerFn(this.handle);
    this.handle = null;
  }

  private arm(ms: number): void {
    this.handle = this.setTimer(() => {
      this.handle = null;
      if (!this.running) return;
      const quiet = this.now() - this.quietSince;
      // A poke since this timer was set means the turn is alive; sleep the
      // remainder of its interval instead of reporting a stall that isn't one.
      if (quiet < this.intervalMs) {
        this.arm(this.intervalMs - quiet);
        return;
      }
      this.onStall(quiet);
      // Reported: the next report is another full interval of silence away,
      // so a long outage is a steady drip rather than one line lost at the top.
      this.quietSince = this.now();
      this.arm(this.intervalMs);
    }, ms);
  }

  get armed(): boolean {
    return this.handle !== null;
  }
}

// Long enough that an ordinary extended-thinking block or a slow test run
// does not generate chatter, short enough that the operator learns something
// is wrong well before the CLI's retry ladder has burned half an hour.
export const DEFAULT_STALL_NOTICE_MS = 5 * 60 * 1000;

// how often a redacted thinking block reports its token estimate.
// The SDK emits one frame per second or so; one transcript row per second is
// what made the blanks a retention problem in the first place, and the
// operator only needs enough to see the number climbing.
export const THINKING_PROGRESS_INTERVAL_MS = 5_000;

// the backstop for a held result. `session_state_changed` is the
// authoritative turn-over signal and is what normally releases one, but a CLI
// that does not emit it would otherwise leave the turn open forever. So once
// the last background task is gone, a result is held only until the session
// has been quiet this long - long enough for the model to resume after a
// subagent hands back, short enough that a stuck turn is not a mystery.
export const DEFAULT_TURN_DRAIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Spawning as another licence's Linux user
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ChatSessionDeps {
  query: QueryFn;
  postEvents: typeof postChatEvents;
  postMessage: typeof postChatMessage;
  postUsage: typeof postChatUsage;
  patchThread: typeof patchChatThread;
  listRules: typeof listPermissionRules;
  postRule: typeof postPermissionRule;
  revokeRule: typeof revokePermissionRule;
  waitForDecision: (requestId: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<OperatorDecision | null>;
  waitForAnswer: (requestId: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<OperatorAnswer | null>;
}

export interface ChatSessionOptions {
  threadId: number;
  cwd: string;
  model: string;
  effort?: string;
  systemPrompt: string;
  /** Null for the planning persona - see chat.ts's resolvePersona. */
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: "auto" | "bypassPermissions";
  resumeSessionId?: string | null;
  // Where this session's turn numbering picks up. A thread outlives any one
  // session (idle teardown, a foreman restart), so starting back at 1 would
  // make `turn` ambiguous for anything reading a thread's events as a whole -
  // and would let a turn-scoped permission rule from an earlier session
  // silently apply to a later one. Seeded from the thread's own history.
  startingTurn?: number;
  /** the license's OAuth token override, see spawn-env.ts. */
  spawnEnv?: SpawnEnv;
  idleTimeoutMs?: number;
  /** How long an open turn may produce nothing before it says so. */
  stallNoticeMs?: number;
  /** How long a result held behind background work waits for the session to
   *  go idle before being released anyway. */
  drainMs?: number;
  maxWaitMs?: number;
  /** Called once the session has torn itself down, so the daemon can forget
   *  it - a new message then starts a fresh one. */
  onClosed?: (threadId: number) => void;
}

// The SDK is loaded here and nowhere else, and only when a session really
// starts: importing it costs a multi-megabyte bundle, and no unit test in
// this repo should pay that (or risk spawning a CLI).
let cachedQuery: QueryFn | null = null;
export async function defaultQuery(): Promise<QueryFn> {
  if (!cachedQuery) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    cachedQuery = sdk.query as unknown as QueryFn;
  }
  return cachedQuery;
}

export class ChatSession {
  private readonly input = new PushableStream<SDKUserMessage>();
  private readonly batcher: ChatEventBatcher;
  private readonly idle: IdleTimer;
  private readonly stall: StallWatchdog;
  private readonly abort = new AbortController();
  private query: Query | null = null;
  private pump: Promise<void> | null = null;
  private turn = 0;
  private assistantText = "";
  private sessionId: string | null;
  // Keyed by turn, because pinboard's ?turn= filter is what decides whether a
  // turn-scoped rule is in the answer at all - a set cached from turn 3 would
  // wrongly carry turn 3's "allow just this once" into turn 4.
  private rules: { turn: number; rules: ChatPermissionRule[] } | null = null;
  private closing = false;
  // A past task's turn-end state. `backgroundTasks` is a REPLACE-semantics
  // mirror of the SDK's own set; `heldResult` is a result that arrived while
  // that set was non-empty and so is not the end of the turn yet.
  private backgroundTasks = new Set<string>();
  private heldResult: NonNullable<TranslatedMessage["result"]> | null = null;
  private readonly drain: IdleTimer;
  private lastThinkingEmit = 0;
  // One turn ends exactly once. Two independent paths can reach the end of a
  // turn - the SDK's own final `result`, and the drain fuse releasing a held
  // one - and they are on different call stacks, so without this a result
  // arriving just after the fuse fired would post a second agent reply and
  // charge the turn's cost twice. Same protection PendingReplies.resolve
  // gives a late or duplicate operator reply.
  private turnFinished = false;

  constructor(
    private readonly opts: ChatSessionOptions,
    private readonly deps: ChatSessionDeps,
  ) {
    this.sessionId = opts.resumeSessionId ?? null;
    this.turn = opts.startingTurn ?? 0;
    this.batcher = new ChatEventBatcher({
      send: (events) => this.deps.postEvents(this.opts.threadId, events),
    });
    this.idle = new IdleTimer(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, () => {
      void this.close("idle");
    });
    this.stall = new StallWatchdog(opts.stallNoticeMs ?? DEFAULT_STALL_NOTICE_MS, (quietMs) => {
      const minutes = Math.round(quietMs / 60000);
      this.batcher.add({
        kind: "error",
        payload: {
          subtype: "stalled",
          message: `No activity for ${minutes}m - the turn is still open, waiting on the API or a long-running tool.`,
          retrying: true,
          quietMs,
        },
        turn: this.turn,
      });
      // Straight out rather than on the batch timer: the whole point is to
      // reach an operator staring at a transcript that has not moved.
      void this.batcher.flush();
    });
    // Re-uses IdleTimer purely for its poke/cancel shape: any SDK message
    // re-arms it, so the fuse only burns while the session is genuinely quiet.
    this.drain = new IdleTimer(opts.drainMs ?? DEFAULT_TURN_DRAIN_MS, () => {
      if (!this.heldResult) return;
      console.warn(
        `chat: thread #${this.opts.threadId} releasing a held result - background work finished but the session never reported idle`,
      );
      void this.releaseHeldResult();
    });
  }

  get threadId(): number {
    return this.opts.threadId;
  }

  get isClosed(): boolean {
    return this.closing;
  }

  get currentTurn(): number {
    return this.turn;
  }

  /** Queue an operator message. The first call starts the session; later ones
   *  are folded into the live one, which is the whole point of holding it
   *  open. */
  async send(text: string): Promise<void> {
    if (this.closing) throw new Error(`chat session for thread #${this.opts.threadId} is closed`);
    // A new operator message is proof the previous turn is over, whatever the
    // SDK did or did not report - release anything still held rather than
    // leaving a turn open forever behind it.
    if (this.heldResult) await this.releaseHeldResult();
    this.turn += 1;
    this.assistantText = "";
    this.backgroundTasks.clear();
    this.lastThinkingEmit = 0;
    this.turnFinished = false;
    this.idle.poke();
    this.stall.start();
    this.batcher.add({ kind: "turn_start", payload: { text }, turn: this.turn });
    if (!this.query) await this.start();
    this.input.push(userMessage(text));
  }

  async interrupt(): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.interrupt();
    } catch (err) {
      // An interrupt racing the end of a turn is normal, not an error worth
      // surfacing to the operator.
      console.error(
        `chat: thread #${this.opts.threadId} interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closing) return;
    // The flag first, so a second close() racing this one returns rather than
    // running the teardown twice - but the held result is flushed before the
    // batcher is closed below, or the turn's reply and cost are lost.
    this.closing = true;
    if (this.heldResult) await this.releaseHeldResult();
    this.idle.cancel();
    this.stall.stop();
    this.drain.cancel();
    this.input.end();
    try {
      this.query?.close();
    } catch {
      // Already gone.
    }
    this.abort.abort();
    await this.batcher.close();
    this.opts.onClosed?.(this.opts.threadId);
    if (reason !== "idle") console.log(`chat: thread #${this.opts.threadId} session closed (${reason})`);
  }

  private async loadRules(): Promise<ChatPermissionRule[]> {
    // Cached per turn, and updated in place whenever a rule is saved or
    // revoked - a canUseTool call is on the critical path of every tool the
    // model runs, and re-reading the whole rule set per call would add a
    // pinboard round-trip to each one.
    if (this.rules === null || this.rules.turn !== this.turn) {
      this.rules = { turn: this.turn, rules: await this.deps.listRules(this.opts.threadId, { turn: this.turn }) };
    }
    return this.rules.rules;
  }

  private async saveRule(rule: ChatPermissionRuleInput): Promise<void> {
    const saved = await this.deps.postRule(this.opts.threadId, rule);
    if (this.rules) this.rules.rules.push(saved);
    else this.rules = { turn: this.turn, rules: [saved] };
  }

  private async revokeRule(ruleId: number): Promise<void> {
    const revoked = await this.deps.revokeRule(this.opts.threadId, ruleId);
    if (!this.rules) return;
    // Replace rather than drop: decidePermission already skips a row with a
    // revokedAt, and keeping it makes a stale cache fail closed instead of
    // looking like the rule was never there.
    this.rules.rules = this.rules.rules.map((rule) => (rule.id === ruleId ? revoked : rule));
  }

  private async start(): Promise<void> {
    const canUseTool = createCanUseTool({
      threadId: this.opts.threadId,
      loadRules: () => this.loadRules(),
      saveRule: (rule) => this.saveRule(rule),
      revokeRule: (ruleId) => this.revokeRule(ruleId),
      emit: (kind, payload) => this.batcher.add({ kind, payload, turn: this.turn }),
      flush: () => this.batcher.flush(),
      waitForDecision: (requestId, opts) => this.deps.waitForDecision(requestId, opts),
      waitForAnswer: (requestId, opts) => this.deps.waitForAnswer(requestId, opts),
      currentTurn: () => this.turn,
      ...(this.opts.maxWaitMs === undefined ? {} : { maxWaitMs: this.opts.maxWaitMs }),
    });

    // Deliberately NOT pre-seeded with the thread's saved allow rules (the
    // SDK's `settings.permissions.allow` would take them): a rule the CLI
    // auto-allows never reaches canUseTool. An operator who once said "don't
    // ask again" for something the floor covers would otherwise have
    // switched the floor off for that call, permanently and invisibly.

    // A past task's always-ask floor, as a PreToolUse hook - which is what it
    // was before this rewrite, and the reason it has to be restored here.
    //
    // Found live on 2026-09-17, on the first real turn through this daemon:
    // `git push --dry-run` ran completely unattended. Carrying the floor
    // only inside canUseTool is not equivalent, because `permissionMode:
    // "auto"` decides with its own model classifier first and simply never
    // calls canUseTool for a call it approves - so the floor was silently
    // absent for exactly the commands it exists to catch. A PreToolUse hook
    // runs *before* that decision and forces the call back onto the approval
    // surface, which is why #145 used one.
    //
    // Kept in addition to the canUseTool gate rather than instead of it:
    // they cover different paths (this one everything, that one whatever
    // still reaches an explicit prompt), and the floor is the wrong place to
    // be economical.
    // An empty object is "no opinion, carry on" - the same thing
    // permission-gate.ts's stdio form says by writing nothing at all.
    const gateHook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const output = hookOutput(evaluateGate(input.tool_name, input.tool_input));
      return output ? (JSON.parse(output) as Awaited<ReturnType<HookCallback>>) : {};
    };

    const options: Options = {
      cwd: this.opts.cwd,
      hooks: { PreToolUse: [{ hooks: [gateHook] }] },
      model: this.opts.model,
      ...(this.opts.effort ? { effort: this.opts.effort as Options["effort"] } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: this.opts.systemPrompt },
      permissionMode: this.opts.permissionMode,
      // The SDK refuses bypassPermissions without this explicit opt-in. Only
      // the read-only planning persona uses that mode (see chat.ts's
      // resolvePersona); the host persona runs `auto` with the always-ask
      // floor under it, exactly as a past task left it.
      ...(this.opts.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      includePartialMessages: true,
      abortController: this.abort,
      ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
      ...(this.opts.disallowedTools ? { disallowedTools: this.opts.disallowedTools } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      env: {
        ...inheritedEnv(),
        ...this.opts.spawnEnv,
        WORK_ACTOR_TYPE: "agent",
        WORK_ACTOR_NAME: "foreman-chat",
      },
    };
    this.query = this.deps.query({ prompt: this.input, options });
    this.pump = this.consume().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`chat: thread #${this.opts.threadId} session error: ${message}`);
      this.batcher.add({ kind: "error", payload: { message }, turn: this.turn });
      void this.close("error");
    });
  }

  private async consume(): Promise<void> {
    const query = this.query;
    if (!query) return;
    for await (const message of query) {
      await this.handleMessage(message);
      if (this.closing) return;
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    this.idle.poke();
    this.stall.poke();
    // Any message re-arms the drain fuse: it exists for a session that has
    // gone quiet holding a result, not for one that is still working.
    if (this.heldResult && this.drain.armed) this.drain.poke();
    const translated = translateSdkMessage(message, this.turn, { backgroundWork: this.backgroundTasks.size > 0 });
    // A result for a turn that is already over carries a `turn_end` of its
    // own; forwarding it would put a second one on the transcript.
    const lateResult = translated.result !== undefined && this.turnFinished;
    for (const event of translated.events) {
      if (lateResult && event.kind === "turn_end") continue;
      this.batcher.add(event);
    }
    if (translated.text) this.assistantText = translated.text;
    if (translated.thinkingTokens !== undefined) this.emitThinkingProgress(translated.thinkingTokens);
    if (translated.backgroundTasks) this.setBackgroundTasks(translated.backgroundTasks);
    if (translated.sessionId && translated.sessionId !== this.sessionId) {
      this.sessionId = translated.sessionId;
      try {
        await this.deps.patchThread(this.opts.threadId, { claudeSessionId: translated.sessionId });
      } catch (err) {
        console.error(
          `chat: thread #${this.opts.threadId} could not store session id: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (lateResult) {
      // The drain fuse already ended this turn. Its cost tick above still
      // lands, since that figure is the more accurate one, but the turn is
      // not ended a second time.
      console.warn(
        `chat: thread #${this.opts.threadId} turn ${this.turn} produced a result after it had already been closed out`,
      );
    } else if (translated.result) {
      if (translated.result.interim) {
        // Held, not dropped: if the SDK never reports idle and no later
        // result arrives, this is what the drain fuse releases so the turn
        // still ends with a real cost and a real reply.
        this.heldResult = translated.result;
      } else {
        await this.endTurn(translated.result);
      }
    }
    // The authoritative turn-over signal, and the normal way a held result is
    // released - it fires after the SDK's own held-back result flushes and
    // the background-agent loop exits.
    if (translated.sessionIdle && this.heldResult) await this.releaseHeldResult();
  }

  // Throttled: the SDK reports a thinking-token estimate about once a second,
  // and one transcript row per second is exactly the retention problem the
  // empty thinking deltas were. The payload carries no `text`, so the PWA's
  // fold treats it as progress rather than as content.
  private emitThinkingProgress(estimatedTokens: number): void {
    const now = Date.now();
    if (now - this.lastThinkingEmit < THINKING_PROGRESS_INTERVAL_MS) return;
    this.lastThinkingEmit = now;
    this.batcher.add({ kind: "thinking", payload: { estimatedTokens }, turn: this.turn });
  }

  private setBackgroundTasks(ids: string[]): void {
    this.backgroundTasks = new Set(ids);
    if (!this.heldResult) return;
    // The last background task just went away. Do not end the turn here: the
    // model normally resumes a beat later (the subagent's handback is a tool
    // result it then replies to) and produces the turn's real result. Arm the
    // fuse instead, and let either that result or `session_state_changed`
    // beat it.
    if (this.backgroundTasks.size === 0) this.drain.poke();
    else this.drain.cancel();
  }

  private async releaseHeldResult(): Promise<void> {
    const held = this.heldResult;
    if (!held) return;
    // translateSdkMessage emitted no turn_end for an interim result, so this
    // path has to write it itself.
    await this.endTurn(held, { emitTurnEnd: true });
  }

  /** The one place a turn is closed out, so it can only happen once. */
  private async endTurn(
    result: NonNullable<TranslatedMessage["result"]>,
    opts: { emitTurnEnd?: boolean } = {},
  ): Promise<void> {
    if (this.turnFinished) return;
    this.turnFinished = true;
    this.heldResult = null;
    this.drain.cancel();
    if (opts.emitTurnEnd) this.batcher.add({ kind: "turn_end", payload: { isError: result.isError }, turn: this.turn });
    await this.finishTurn(result);
  }

  private async finishTurn(result: NonNullable<TranslatedMessage["result"]>): Promise<void> {
    this.stall.stop();
    await this.batcher.flush();

    // The transcript the PWA and every later fresh session read is still the
    // messages table - events are the live view of a turn, not its record.
    const body = result.text || this.assistantText || "(no reply produced)";
    try {
      await this.deps.postMessage(this.opts.threadId, "agent", body);
    } catch (err) {
      console.error(
        `chat: thread #${this.opts.threadId} could not post the reply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // A past task's gap closed: a turn that produced a cost is charged even when
    // it ended in an error, because it spent real money either way.
    if (result.costUsd > 0 || result.durationMs > 0) {
      try {
        await this.deps.postUsage(this.opts.threadId, { costUsd: result.costUsd, durationMs: result.durationMs });
      } catch (err) {
        console.error(
          `chat: thread #${this.opts.threadId} usage not recorded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
