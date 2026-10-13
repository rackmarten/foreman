import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatSession,
  IdleTimer,
  PushableStream,
  StallWatchdog,
  translateSdkMessage,
  userMessage,
  type ChatSessionDeps,
  type QueryFn,
} from "./chat-session.js";
import type { OperatorAnswer } from "./chat-permissions.js";
import type { ChatEventInput, ChatPermissionRule, ChatPermissionRuleInput } from "./pinboard.js";
import type { PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// --- PushableStream --------------------------------------------------------

test("delivers items pushed before anything iterates", async () => {
  const stream = new PushableStream<number>();
  stream.push(1);
  stream.push(2);
  stream.end();
  const seen: number[] = [];
  for await (const item of stream) seen.push(item);
  assert.deepEqual(seen, [1, 2]);
});

test("delivers an item pushed while the consumer is parked", async () => {
  const stream = new PushableStream<number>();
  const iterator = stream[Symbol.asyncIterator]();
  const next = iterator.next();
  stream.push(7);
  assert.deepEqual(await next, { value: 7, done: false });
});

test("ending while the consumer is parked terminates the loop", async () => {
  const stream = new PushableStream<number>();
  const iterator = stream[Symbol.asyncIterator]();
  const next = iterator.next();
  stream.end();
  assert.equal((await next).done, true);
});

test("a push after end is dropped", async () => {
  const stream = new PushableStream<number>();
  stream.end();
  stream.push(1);
  assert.equal(stream.pending, 0);
});

test("userMessage builds a streaming-input user message", () => {
  assert.deepEqual(userMessage("hi"), {
    type: "user",
    message: { role: "user", content: "hi" },
    parent_tool_use_id: null,
  });
});

// --- translateSdkMessage ---------------------------------------------------

function streamEvent(delta: Record<string, unknown>): SDKMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "s1",
  } as unknown as SDKMessage;
}

test("a text delta becomes a text_delta event", () => {
  const { events } = translateSdkMessage(streamEvent({ type: "text_delta", text: "Hel" }), 2);
  assert.deepEqual(events, [{ kind: "text_delta", payload: { text: "Hel" }, turn: 2 }]);
});

test("a thinking delta becomes a thinking event", () => {
  const { events } = translateSdkMessage(streamEvent({ type: "thinking_delta", thinking: "hmm" }), 1);
  assert.deepEqual(events, [{ kind: "thinking", payload: { text: "hmm" }, turn: 1 }]);
});

test("an unrecognised stream delta produces nothing", () => {
  assert.deepEqual(translateSdkMessage(streamEvent({ type: "signature_delta", signature: "x" }), 1).events, []);
});

test("an assistant tool_use block becomes tool_start and text is collected", () => {
  const message = {
    type: "assistant",
    session_id: "s1",
    parent_tool_use_id: null,
    uuid: "u",
    message: {
      content: [
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
      ],
    },
  } as unknown as SDKMessage;
  const translated = translateSdkMessage(message, 3);
  assert.deepEqual(translated.events, [
    { kind: "tool_start", payload: { toolUseId: "toolu_1", name: "Bash", input: { command: "npm test" } }, turn: 3 },
  ]);
  assert.equal(translated.text, "Running it.");
  assert.equal(translated.sessionId, "s1");
});

test("a tool_result user message becomes tool_end with a truncated preview", () => {
  const message = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "x".repeat(3000) }],
    },
  } as unknown as SDKMessage;
  const { events } = translateSdkMessage(message, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_end");
  assert.deepEqual([events[0].payload.toolUseId, events[0].payload.isError], ["toolu_1", true]);
  assert.equal(String(events[0].payload.preview).length, 2000);
});

test("a successful result yields cost and turn_end but no error event", () => {
  const message = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All done.",
    total_cost_usd: 0.42,
    duration_ms: 1234,
    num_turns: 5,
    session_id: "s1",
  } as unknown as SDKMessage;
  const translated = translateSdkMessage(message, 4);
  assert.deepEqual(translated.events.map((e) => e.kind), ["cost", "turn_end"]);
  assert.deepEqual(translated.events[0].payload, { costUsd: 0.42, durationMs: 1234, numTurns: 5 });
  assert.deepEqual(translated.result, {
    isError: false,
    text: "All done.",
    costUsd: 0.42,
    durationMs: 1234,
    numTurns: 5,
    interim: false,
  });
});

test("an error result yields an error event and still reports its cost", () => {
  const message = {
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: true,
    errors: ["budget exhausted"],
    total_cost_usd: 2.01,
    duration_ms: 99,
    num_turns: 1,
    session_id: "s1",
  } as unknown as SDKMessage;
  const translated = translateSdkMessage(message, 1);
  assert.deepEqual(translated.events.map((e) => e.kind), ["error", "cost", "turn_end"]);
  assert.equal(translated.result?.isError, true);
  assert.equal(translated.result?.costUsd, 2.01);
});

test("a system message contributes only its session id", () => {
  const message = { type: "system", subtype: "init", session_id: "s9" } as unknown as SDKMessage;
  const translated = translateSdkMessage(message, 1);
  assert.deepEqual(translated.events, []);
  assert.equal(translated.sessionId, "s9");
});

// --- IdleTimer -------------------------------------------------------------

function fakeTimers() {
  let pending: (() => void) | null = null;
  let scheduled = 0;
  return {
    get scheduled() {
      return scheduled;
    },
    set: (fn: () => void) => {
      scheduled += 1;
      pending = fn;
      return scheduled;
    },
    clear: () => {
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

test("an idle timer fires only after the timeout with no activity", () => {
  const timers = fakeTimers();
  let fired = 0;
  const idle = new IdleTimer(1000, () => (fired += 1), timers.set, timers.clear);
  idle.poke();
  assert.equal(fired, 0);
  timers.fire();
  assert.equal(fired, 1);
  assert.equal(idle.armed, false);
});

test("activity resets the idle timer instead of stacking timers", () => {
  const timers = fakeTimers();
  let fired = 0;
  const idle = new IdleTimer(1000, () => (fired += 1), timers.set, timers.clear);
  idle.poke();
  idle.poke();
  idle.poke();
  timers.fire();
  assert.equal(fired, 1);
  assert.equal(timers.scheduled, 3);
});

test("cancelling an idle timer stops it firing", () => {
  const timers = fakeTimers();
  let fired = 0;
  const idle = new IdleTimer(1000, () => (fired += 1), timers.set, timers.clear);
  idle.poke();
  idle.cancel();
  timers.fire();
  assert.equal(fired, 0);
  assert.equal(idle.armed, false);
});

// --- StallWatchdog ---------------------------------------------------------

// Like fakeTimers above, but it remembers the delay each timer was set with -
// the whole point of this class is *when* it re-arms, not just that it does.
function fakeDelayTimers() {
  let pending: { fn: () => void; ms: number } | null = null;
  const delays: number[] = [];
  return {
    delays,
    set: (fn: () => void, ms: number) => {
      delays.push(ms);
      pending = { fn, ms };
      return delays.length;
    },
    clear: () => {
      pending = null;
    },
    fire: () => {
      const timer = pending;
      pending = null;
      timer?.fn();
    },
  };
}

test("a stall watchdog reports once the quiet window has actually elapsed", () => {
  const timers = fakeDelayTimers();
  let now = 0;
  const quiet: number[] = [];
  const stall = new StallWatchdog(1000, (ms) => quiet.push(ms), () => now, timers.set, timers.clear);
  stall.start();
  now = 1000;
  timers.fire();
  assert.deepEqual(quiet, [1000]);
});

test("a message during the window defers the report by the remainder, not a whole interval", () => {
  const timers = fakeDelayTimers();
  let now = 0;
  const quiet: number[] = [];
  const stall = new StallWatchdog(1000, (ms) => quiet.push(ms), () => now, timers.set, timers.clear);
  stall.start();
  now = 600;
  stall.poke();
  now = 1000;
  timers.fire();
  // 400ms of quiet so far - nothing to report, and the next check is due
  // 600ms later rather than a fresh 1000ms.
  assert.deepEqual(quiet, []);
  assert.deepEqual(timers.delays, [1000, 600]);
  now = 1600;
  timers.fire();
  assert.deepEqual(quiet, [1000]);
});

test("a sustained outage keeps reporting rather than going quiet after one line", () => {
  const timers = fakeDelayTimers();
  let now = 0;
  const quiet: number[] = [];
  const stall = new StallWatchdog(1000, (ms) => quiet.push(ms), () => now, timers.set, timers.clear);
  stall.start();
  now = 1000;
  timers.fire();
  now = 2000;
  timers.fire();
  now = 3000;
  timers.fire();
  assert.deepEqual(quiet, [1000, 1000, 1000]);
});

test("stopping the watchdog silences it even if a timer already fired", () => {
  const timers = fakeDelayTimers();
  let now = 0;
  const quiet: number[] = [];
  const stall = new StallWatchdog(1000, (ms) => quiet.push(ms), () => now, timers.set, timers.clear);
  stall.start();
  stall.stop();
  now = 5000;
  timers.fire();
  assert.deepEqual(quiet, []);
  assert.equal(stall.armed, false);
});

test("poking a stopped watchdog does not resurrect it", () => {
  const timers = fakeDelayTimers();
  let now = 0;
  const quiet: number[] = [];
  const stall = new StallWatchdog(1000, (ms) => quiet.push(ms), () => now, timers.set, timers.clear);
  stall.start();
  stall.stop();
  stall.poke();
  now = 5000;
  timers.fire();
  assert.deepEqual(quiet, []);
});

// --- api_error translation -------------------------------------------------

test("an SDK api_retry message becomes a visible, non-interrupting error event", () => {
  const translated = translateSdkMessage(
    {
      type: "system",
      subtype: "api_retry",
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 2101,
      error_status: 529,
      error: "overloaded",
    } as unknown as SDKMessage,
    4,
  );
  assert.equal(translated.events.length, 1);
  const [event] = translated.events;
  assert.equal(event.kind, "error");
  assert.equal(event.turn, 4);
  assert.equal(event.payload.message, "API error - overloaded (HTTP 529), retry 3/10, next in 2.1s");
  assert.equal(event.payload.subtype, "api_retry");
  assert.equal(event.payload.retrying, true);
  // Must not read as an operator interrupt: the PWA ends the turn on that.
  assert.equal(event.payload.interrupted, undefined);
  assert.equal(translated.result, undefined);
});

test("a first-byte timeout says how long it waited - the case that reads as a freeze", () => {
  const translated = translateSdkMessage(
    {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 1,
      retry_delay_ms: 0,
      error_status: null,
      error: "server_error",
      no_response: { waited_ms: 181000, retry_wait_ms: 181000 },
    } as unknown as SDKMessage,
    2,
  );
  assert.equal(
    translated.events[0]?.payload.message,
    "API error - server_error, no response for 181s, retry 1/1, next in 0s",
  );
});

// The CLI's own .jsonl spells the same event differently. Thread #40's
// transcript is the only record of that outage, so keep reading it.
test("the transcript's api_error spelling is understood too", () => {
  const translated = translateSdkMessage(
    {
      type: "system",
      subtype: "api_error",
      error: { message: "Request timed out.", formatted: "Request timed out." },
      retryAttempt: 3,
      maxRetries: 10,
      retryInMs: 2101,
    } as unknown as SDKMessage,
    4,
  );
  assert.equal(
    translated.events[0]?.payload.message,
    "API error - Request timed out., retry 3/10, next in 2.1s",
  );
});

test("a retry notice with no retry metadata still says what went wrong", () => {
  const translated = translateSdkMessage(
    { type: "system", subtype: "api_retry", error: "overloaded" } as unknown as SDKMessage,
    1,
  );
  assert.equal(translated.events[0]?.payload.message, "API error - overloaded");
});

test("other system messages stay dropped", () => {
  const translated = translateSdkMessage(
    { type: "system", subtype: "init", session_id: "abc" } as unknown as SDKMessage,
    1,
  );
  assert.deepEqual(translated.events, []);
  assert.equal(translated.sessionId, "abc");
});

// --- ChatSession -----------------------------------------------------------

interface SessionHarness {
  options?: import("@anthropic-ai/claude-agent-sdk").Options;
  session: ChatSession;
  events: ChatEventInput[];
  messages: { role: string; body: string }[];
  usage: { costUsd: number; durationMs: number }[];
  patched: Record<string, unknown>[];
  emit: (message: SDKMessage) => Promise<void>;
  sent: SDKUserMessage[];
  rules: ChatPermissionRule[];
  ruleQueries: { turn?: number; includeRevoked?: boolean }[];
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; requestId: string; toolUseID: string; suggestions?: unknown[] },
  ) => Promise<{ behavior: string }>;
  decision: { behavior: "allow" | "deny"; updatedPermissions?: PermissionUpdate[] } | null;
  questionAnswer: OperatorAnswer | null;
  interrupts: number;
  closes: number;
  closed: number[];
  started: number;
}

function ruleRow(input: ChatPermissionRuleInput): ChatPermissionRule {
  return {
    id: 0,
    threadId: 1,
    toolName: input.toolName,
    ruleContent: input.ruleContent ?? null,
    behavior: input.behavior,
    scope: input.scope,
    turn: input.turn ?? null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
}

function sessionHarness(
  overrides: { idleTimeoutMs?: number; startingTurn?: number; drainMs?: number } = {},
): SessionHarness {
  const events: ChatEventInput[] = [];
  const messages: { role: string; body: string }[] = [];
  const usage: { costUsd: number; durationMs: number }[] = [];
  const patched: Record<string, unknown>[] = [];
  const sent: SDKUserMessage[] = [];
  const closed: number[] = [];
  const rules: ChatPermissionRule[] = [];
  const ruleQueries: { turn?: number; includeRevoked?: boolean }[] = [];
  const outbound = new PushableStream<SDKMessage>();
  const h = {
    events,
    messages,
    usage,
    patched,
    sent,
    closed,
    rules,
    ruleQueries,
    decision: { behavior: "allow" },
    questionAnswer: null,
    interrupts: 0,
    closes: 0,
    started: 0,
    options: undefined,
  } as SessionHarness;

  const query: QueryFn = ({ prompt, options }) => {
    h.started += 1;
    // The SDK would call this; capturing it lets the tests exercise the
    // session's own permission wiring (rule cache, turn, revoke) without one.
    h.canUseTool = options?.canUseTool as SessionHarness["canUseTool"];
    h.options = options;
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) sent.push(message);
    })();
    const iterator = outbound[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: () => iterator.return!(undefined),
      throw: () => Promise.reject(new Error("not used")),
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => {
        h.interrupts += 1;
        return undefined;
      },
      close: () => {
        h.closes += 1;
        outbound.end();
      },
    } as never;
  };

  const deps: ChatSessionDeps = {
    query,
    postEvents: async (_threadId, batch) => {
      events.push(...batch);
      return { inserted: batch.length, trimmed: 0 };
    },
    postMessage: async (_threadId, role, body) => {
      messages.push({ role, body });
      return { id: messages.length, threadId: 1, role, body, createdAt: "" };
    },
    postUsage: async (_threadId, u) => {
      usage.push(u);
      return null as never;
    },
    patchThread: async (_threadId, fields) => {
      patched.push(fields as Record<string, unknown>);
      return { status: 200, data: null as never };
    },
    listRules: async (_threadId, opts) => {
      ruleQueries.push(opts ?? {});
      // A copy, so the session's own cache is genuinely separate state -
      // sharing the array would hide a missing cache update.
      return rules.map((rule) => ({ ...rule }));
    },
    postRule: async (_threadId, input) => {
      rules.push({ ...ruleRow(input), id: rules.length + 1 });
      return rules[rules.length - 1];
    },
    revokeRule: async (_threadId, ruleId) => {
      const found = rules.find((r) => r.id === ruleId)!;
      found.revokedAt = new Date().toISOString();
      return found;
    },
    waitForDecision: async () => h.decision,
    waitForAnswer: async () => h.questionAnswer,
  };

  h.session = new ChatSession(
    {
      threadId: 1,
      cwd: "/tmp",
      model: "sonnet",
      systemPrompt: "be helpful",
      permissionMode: "auto",
      onClosed: (id) => closed.push(id),
      ...(overrides.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: overrides.idleTimeoutMs }),
      ...(overrides.startingTurn === undefined ? {} : { startingTurn: overrides.startingTurn }),
      ...(overrides.drainMs === undefined ? {} : { drainMs: overrides.drainMs }),
    },
    deps,
  );
  h.emit = async (message: SDKMessage) => {
    outbound.push(message);
    // Let the session's pump drain the message before assertions.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return h;
}

test("the first send starts one session and later sends reuse it", async () => {
  const h = sessionHarness();
  await h.session.send("first");
  await h.session.send("second");
  assert.equal(h.started, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.sent.map((m) => (m.message as { content: string }).content), ["first", "second"]);
  assert.equal(h.session.currentTurn, 2);
});

test("a full turn streams events, posts the reply and charges the cost", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.emit(streamEvent({ type: "text_delta", text: "Hi " }));
  await h.emit(streamEvent({ type: "text_delta", text: "there" }));
  await h.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hi there",
    total_cost_usd: 0.1,
    duration_ms: 500,
    num_turns: 1,
    session_id: "s1",
  } as unknown as SDKMessage);

  assert.deepEqual(h.messages, [{ role: "agent", body: "Hi there" }]);
  assert.deepEqual(h.usage, [{ costUsd: 0.1, durationMs: 500 }]);
  const kinds = h.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["turn_start", "text_delta", "cost", "turn_end"]);
  // The two deltas were coalesced by the batcher rather than posted one by one.
  assert.equal((h.events[1].payload as { text: string }).text, "Hi there");
});

test("a new session id is persisted back to the thread once", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.emit({ type: "system", subtype: "init", session_id: "s-new" } as unknown as SDKMessage);
  await h.emit({ type: "system", subtype: "status", session_id: "s-new" } as unknown as SDKMessage);
  assert.deepEqual(h.patched, [{ claudeSessionId: "s-new" }]);
});

test("an errored turn still posts a reply and charges what it spent", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["it broke"],
    total_cost_usd: 0.05,
    duration_ms: 20,
    num_turns: 1,
    session_id: "s1",
  } as unknown as SDKMessage);
  assert.deepEqual(h.messages, [{ role: "agent", body: "it broke" }]);
  assert.deepEqual(h.usage, [{ costUsd: 0.05, durationMs: 20 }]);
  assert.ok(h.events.some((e) => e.kind === "error"));
});

test("interrupt reaches the live query", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.session.interrupt();
  assert.equal(h.interrupts, 1);
});

test("interrupting a session that never started is a no-op", async () => {
  const h = sessionHarness();
  await h.session.interrupt();
  assert.equal(h.interrupts, 0);
});

test("close tears the query down, flushes events and notifies the owner", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.session.close("shutdown");
  assert.equal(h.closes, 1);
  assert.deepEqual(h.closed, [1]);
  assert.equal(h.session.isClosed, true);
  assert.ok(h.events.some((e) => e.kind === "turn_start"));
});

test("sending on a closed session throws rather than silently dropping", async () => {
  const h = sessionHarness();
  await h.session.close("shutdown");
  await assert.rejects(() => h.session.send("hello"), /closed/);
});

test("close is idempotent", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.session.close("shutdown");
  await h.session.close("shutdown");
  assert.equal(h.closes, 1);
  assert.deepEqual(h.closed, [1]);
});

test("turn numbering picks up where the thread's history left off", async () => {
  const h = sessionHarness({ startingTurn: 6 });
  await h.session.send("seventh message");
  assert.equal(h.session.currentTurn, 7);
  await h.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: 0,
    duration_ms: 0,
    num_turns: 1,
    session_id: "s1",
  } as unknown as SDKMessage);
  assert.deepEqual([...new Set(h.events.map((e) => e.turn))], [7]);
});

function permissionOptions() {
  return { signal: new AbortController().signal, requestId: "req-1", toolUseID: "toolu_1" };
}

test("the session's rules fetch is scoped to the current turn and cached per turn", async () => {
  const h = sessionHarness();
  await h.session.send("first");
  await h.canUseTool("Read", { file_path: "/x" }, permissionOptions());
  await h.canUseTool("Read", { file_path: "/y" }, permissionOptions());
  assert.deepEqual(h.ruleQueries, [{ turn: 1 }], "a second call in the same turn reuses the cache");

  await h.session.send("second");
  await h.canUseTool("Read", { file_path: "/z" }, permissionOptions());
  assert.deepEqual(h.ruleQueries, [{ turn: 1 }, { turn: 2 }], "a new turn refetches, so turn-scoped rules apply");
});

test("a remembered allow is persisted and then answers the next call from cache", async () => {
  const h = sessionHarness();
  h.decision = {
    behavior: "allow",
    updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" },
    ],
  };
  await h.session.send("first");
  await h.canUseTool("Read", { file_path: "/x" }, permissionOptions());
  assert.deepEqual(h.rules.map((r) => [r.toolName, r.behavior]), [["Read", "allow"]]);

  // Second call: the saved rule is already in the session's cache, so the
  // operator is not asked again and no second fetch happens.
  h.decision = { behavior: "deny" };
  const second = await h.canUseTool("Read", { file_path: "/y" }, permissionOptions());
  assert.equal(second.behavior, "allow");
  assert.deepEqual(h.ruleQueries, [{ turn: 1 }]);
});

test("a revoked rule stops applying without a refetch", async () => {
  const h = sessionHarness();
  h.rules.push({
    id: 5,
    threadId: 1,
    toolName: "Read",
    ruleContent: null,
    behavior: "allow",
    scope: "thread",
    turn: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  h.decision = {
    behavior: "allow",
    updatedPermissions: [
      { type: "removeRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" },
    ],
  };
  await h.session.send("first");
  // Gate-forced ask on a Bash call carrying the revoke answer.
  await h.canUseTool("Bash", { command: "sudo ls" }, permissionOptions());
  assert.equal(h.rules[0].revokedAt !== null, true);

  // Read is no longer covered, so it asks the operator instead of allowing.
  h.decision = { behavior: "deny" };
  const after = await h.canUseTool("Read", { file_path: "/x" }, permissionOptions());
  assert.equal(after.behavior, "deny");
  assert.deepEqual(h.ruleQueries, [{ turn: 1 }]);
});

// Regression, found live 2026-09-17 on the first real turn through the
// daemon: `git push --dry-run` ran completely unattended. The always-ask
// floor was carried only inside canUseTool, and `permissionMode: "auto"`
// decides with its own classifier first and never calls canUseTool for a
// call it approves - so the floor was silently absent for exactly the
// commands it exists to catch. It has to be a PreToolUse hook, which runs
// before that decision, which is what a past task used.
test("the always-ask floor is registered as a PreToolUse hook, not only inside canUseTool", async () => {
  const h = sessionHarness();
  await h.session.send("go");
  const hooks = h.options?.hooks?.PreToolUse;
  assert.ok(hooks && hooks.length > 0, "PreToolUse hook must be registered");
  const hook = hooks[0].hooks[0];
  const opts = { signal: new AbortController().signal };

  const asked = await hook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cd /app && git push --dry-run" } } as never,
    undefined,
    opts,
  );
  assert.equal(
    (asked as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    "ask",
    "a listed command must be forced back onto the approval surface",
  );

  const quiet = await hook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls /app" } } as never,
    undefined,
    opts,
  );
  assert.deepEqual(quiet, {}, "an ordinary command must pass with no opinion");
});

// --- redacted thinking and the async-subagent turn end ----------

test("an empty thinking delta produces no event at all", () => {
  // The redacted-thinking phase: the API streams pings, so `thinking` is an
  // empty string. 39 of thread #32's 82 events were these, and each one both
  // rendered as nothing and pushed a real event out of the retention window.
  const { events } = translateSdkMessage(streamEvent({ type: "thinking_delta", thinking: "" }), 2);
  assert.deepEqual(events, []);
});

test("a thinking delta with real text still becomes a thinking event", () => {
  const { events } = translateSdkMessage(streamEvent({ type: "thinking_delta", thinking: "hmm" }), 2);
  assert.deepEqual(events, [{ kind: "thinking", payload: { text: "hmm" }, turn: 2 }]);
});

test("thinking_tokens carries a token estimate rather than an event", () => {
  const translated = translateSdkMessage(
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 1400, session_id: "s1" } as unknown as SDKMessage,
    3,
  );
  assert.deepEqual(translated.events, []);
  assert.equal(translated.thinkingTokens, 1400);
});

test("background_tasks_changed reports the live set and drops ambient entries", () => {
  const translated = translateSdkMessage(
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "t1", task_type: "local_agent", description: "research" },
        { task_id: "t2", task_type: "local_agent", description: "watcher", ambient: true },
      ],
      session_id: "s1",
    } as unknown as SDKMessage,
    3,
  );
  assert.deepEqual(translated.backgroundTasks, ["t1"]);
});

test("session_state_changed only reports idle", () => {
  const idle = translateSdkMessage(
    { type: "system", subtype: "session_state_changed", state: "idle", session_id: "s1" } as unknown as SDKMessage,
    3,
  );
  const running = translateSdkMessage(
    { type: "system", subtype: "session_state_changed", state: "running", session_id: "s1" } as unknown as SDKMessage,
    3,
  );
  assert.equal(idle.sessionIdle, true);
  assert.equal(running.sessionIdle, undefined);
});

test("a result arriving while background work runs is interim: cost, no turn_end", () => {
  const message = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Kicked off a research pass.",
    total_cost_usd: 0.11,
    duration_ms: 24475,
    num_turns: 2,
    session_id: "s1",
  } as unknown as SDKMessage;
  const translated = translateSdkMessage(message, 2, { backgroundWork: true });
  assert.deepEqual(translated.events.map((e) => e.kind), ["cost"]);
  assert.deepEqual(translated.events[0].payload, {
    costUsd: 0.11,
    durationMs: 24475,
    numTurns: 2,
    interim: true,
  });
  assert.equal(translated.result?.interim, true);
});

function backgroundTasks(ids: string[]): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: id })),
    session_id: "s1",
  } as unknown as SDKMessage;
}

function result(overrides: Record<string, unknown>): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    session_id: "s1",
    ...overrides,
  } as unknown as SDKMessage;
}

test("a subagent turn ends once, at the real cost, when the session reports idle", async () => {
  // Thread #32's turn 2, in miniature: the Agent tool launches async, the main
  // model's reply finishes at $0.11 while the subagent keeps working, and the
  // turn's real end is 40 events later at $0.40.
  const h = sessionHarness();
  await h.session.send("plan the work");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(result({ result: "Kicked off research.", total_cost_usd: 0.11 }));

  // Nothing has ended yet: no turn_end, no reply posted, nothing charged.
  assert.deepEqual(h.events.filter((e) => e.kind === "turn_end"), []);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.usage, []);

  await h.emit(backgroundTasks([]));
  await h.emit(result({ result: "Here is the plan.", total_cost_usd: 0.4, duration_ms: 772253 }));

  assert.deepEqual(h.messages, [{ role: "agent", body: "Here is the plan." }]);
  assert.deepEqual(h.usage, [{ costUsd: 0.4, durationMs: 772253 }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
  // Both cost ticks reached the transcript - the first flagged interim, so a
  // reader can tell "spend so far" from "what the turn cost".
  const costs = h.events.filter((e) => e.kind === "cost").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(costs.map((c) => c.costUsd), [0.11, 0.4]);
  assert.deepEqual(costs.map((c) => c.interim), [true, undefined]);
});

test("an idle report releases a held result when no second result ever arrives", async () => {
  const h = sessionHarness();
  await h.session.send("plan the work");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(result({ result: "Kicked off research.", total_cost_usd: 0.11 }));
  await h.emit(backgroundTasks([]));
  await h.emit({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s1" } as unknown as SDKMessage);

  assert.deepEqual(h.messages, [{ role: "agent", body: "Kicked off research." }]);
  assert.deepEqual(h.usage, [{ costUsd: 0.11, durationMs: 1 }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
});

test("a held result is released before the next turn opens", async () => {
  // The backstop for a CLI that reports background tasks but never idle: the
  // operator's next message is itself proof the turn is over.
  const h = sessionHarness();
  await h.session.send("plan the work");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(result({ result: "Still going.", total_cost_usd: 0.11 }));
  await h.session.send("any update?");

  assert.deepEqual(h.messages, [{ role: "agent", body: "Still going." }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
  // The turn_end belongs to turn 1, not to the turn the new message opened.
  const end = h.events.find((e) => e.kind === "turn_end")!;
  assert.equal(end.turn, 1);
});

test("a result with no background work outstanding still ends the turn immediately", async () => {
  const h = sessionHarness();
  await h.session.send("hello");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(backgroundTasks([]));
  await h.emit(result({ result: "done", total_cost_usd: 0.02 }));
  assert.deepEqual(h.messages, [{ role: "agent", body: "done" }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
});

test("thinking progress is emitted once, not once per SDK frame", async () => {
  const h = sessionHarness();
  await h.session.send("think hard");
  // The SDK sends one of these roughly every second; the throttle is 5s, so a
  // burst has to collapse to a single row or the retention cap is right back
  // where a past task found it.
  for (const tokens of [200, 450, 700, 980]) {
    await h.emit({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: tokens,
      session_id: "s1",
    } as unknown as SDKMessage);
  }
  // Ending the turn is what flushes the batcher, so the assertions below see
  // what actually reached pinboard rather than what is still buffered.
  await h.emit(result({ result: "done", total_cost_usd: 0.01 }));
  const thinking = h.events.filter((e) => e.kind === "thinking");
  assert.equal(thinking.length, 1);
  assert.deepEqual(thinking[0].payload, { estimatedTokens: 200 });
});

test("the drain fuse ends a turn the session never reported idle for", async () => {
  const h = sessionHarness({ drainMs: 5 });
  await h.session.send("plan the work");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(result({ result: "Kicked off research.", total_cost_usd: 0.11 }));
  await h.emit(backgroundTasks([]));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(h.messages, [{ role: "agent", body: "Kicked off research." }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
});

test("a result arriving after the drain fuse fired does not end the turn twice", async () => {
  // The race the fuse itself creates: it and the SDK's own final result are
  // on different call stacks, so without a guard the turn posts two agent
  // replies and is charged twice.
  const h = sessionHarness({ drainMs: 5 });
  await h.session.send("plan the work");
  await h.emit(backgroundTasks(["t1"]));
  await h.emit(result({ result: "Kicked off research.", total_cost_usd: 0.11 }));
  await h.emit(backgroundTasks([]));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await h.emit(result({ result: "Here is the plan.", total_cost_usd: 0.4, duration_ms: 772253 }));

  assert.deepEqual(h.messages, [{ role: "agent", body: "Kicked off research." }]);
  assert.deepEqual(h.usage, [{ costUsd: 0.11, durationMs: 1 }]);
  assert.equal(h.events.filter((e) => e.kind === "turn_end").length, 1);
  // The late result's cost tick still lands - it is the more accurate figure,
  // and a reader of the transcript should see what the turn really spent. It
  // rides the batcher's own flush timer, since no turn end follows it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(
    h.events.filter((e) => e.kind === "cost").map((e) => (e.payload as { costUsd: number }).costUsd),
    [0.11, 0.4],
  );
});
