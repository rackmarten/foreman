import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatDaemon,
  RECONNECT_CAP_MS,
  backoffDelayMs,
  type ChatDaemonDeps,
  type ManagedSession,
} from "./chat-daemon.js";
import type { ChatStreamEvent } from "./pinboard.js";

// --- backoff ---------------------------------------------------------------

test("backoff starts at the base delay and doubles", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, 1000, 30_000)), [1000, 2000, 4000, 8000, 16_000]);
});

test("backoff is capped", () => {
  assert.equal(backoffDelayMs(20, 1000, 30_000), 30_000);
  assert.equal(backoffDelayMs(50), RECONNECT_CAP_MS);
});

// --- harness ---------------------------------------------------------------

class FakeSession implements ManagedSession {
  readonly sent: string[] = [];
  interrupts = 0;
  closedWith: string | null = null;
  isClosed = false;

  constructor(
    readonly threadId: number,
    private readonly onClosed: (threadId: number) => void,
    private readonly onSend?: () => Promise<void>,
  ) {}

  async send(text: string): Promise<void> {
    if (this.onSend) await this.onSend();
    this.sent.push(text);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(reason: string): Promise<void> {
    this.closedWith = reason;
    this.isClosed = true;
    this.onClosed(this.threadId);
  }
}

interface DaemonHarness {
  daemon: ChatDaemon;
  sessions: FakeSession[];
  created: number;
  decisions: { requestId: string; behavior: string }[];
  answers: { requestId: string; answers: Record<string, string> }[];
  settle: () => Promise<void>;
  deps: ChatDaemonDeps;
}

function daemonHarness(
  overrides: {
    onSend?: () => Promise<void>;
    resolveDecision?: () => boolean;
    resolveAnswer?: () => boolean;
    listAwaiting?: () => Promise<{ threadId: number; message: string }[]>;
  } = {},
): DaemonHarness {
  const sessions: FakeSession[] = [];
  const decisions: { requestId: string; behavior: string }[] = [];
  const answers: { requestId: string; answers: Record<string, string> }[] = [];
  const h = { sessions, decisions, answers, created: 0 } as DaemonHarness;
  const deps: ChatDaemonDeps = {
    subscribe: async () => undefined,
    listAwaiting: overrides.listAwaiting ?? (async () => []),
    createSession: async (threadId, onClosed) => {
      h.created += 1;
      const session = new FakeSession(threadId, onClosed, overrides.onSend);
      sessions.push(session);
      return session;
    },
    resolveDecision: (requestId, decision) => {
      decisions.push({ requestId, behavior: decision.behavior });
      return overrides.resolveDecision ? overrides.resolveDecision() : true;
    },
    resolveAnswer: (requestId, answer) => {
      answers.push({ requestId, answers: answer.answers });
      return overrides.resolveAnswer ? overrides.resolveAnswer() : true;
    },
  };
  h.daemon = new ChatDaemon(deps);
  h.settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  h.deps = deps;
  return h;
}

function human(threadId: number, message: string): ChatStreamEvent {
  return { type: "human_message", threadId, message };
}

// --- session map -----------------------------------------------------------

test("a human message creates one session per thread and reuses it", async () => {
  const h = daemonHarness();
  h.daemon.dispatch(human(1, "first"));
  h.daemon.dispatch(human(1, "second"));
  h.daemon.dispatch(human(2, "other thread"));
  await h.settle();
  assert.equal(h.created, 2);
  assert.equal(h.daemon.liveSessions, 2);
  assert.deepEqual(h.sessions[0].sent, ["first", "second"]);
  assert.deepEqual(h.sessions[1].sent, ["other thread"]);
});

test("messages for one thread reach its session in order even when send is slow", async () => {
  const order: string[] = [];
  let first = true;
  const h = daemonHarness({
    onSend: async () => {
      const delay = first ? 20 : 1;
      first = false;
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
  });
  h.daemon.dispatch(human(1, "a"));
  h.daemon.dispatch(human(1, "b"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  order.push(...h.sessions[0].sent);
  assert.deepEqual(order, ["a", "b"]);
});

test("a closed session is replaced on the next message", async () => {
  const h = daemonHarness();
  h.daemon.dispatch(human(1, "first"));
  await h.settle();
  await h.sessions[0].close("idle");
  assert.equal(h.daemon.liveSessions, 0);
  h.daemon.dispatch(human(1, "second"));
  await h.settle();
  assert.equal(h.created, 2);
  assert.deepEqual(h.sessions[1].sent, ["second"]);
});

test("a session failing to send does not take the daemon down", async () => {
  const h = daemonHarness({
    onSend: async () => {
      throw new Error("session died");
    },
  });
  h.daemon.dispatch(human(1, "a"));
  await h.settle();
  assert.equal(h.daemon.liveSessions, 1);
  h.daemon.dispatch(human(2, "b"));
  await h.settle();
  assert.equal(h.created, 2);
});

// --- routing ---------------------------------------------------------------

test("an interrupt reaches the thread's live session", async () => {
  const h = daemonHarness();
  h.daemon.dispatch(human(1, "a"));
  await h.settle();
  h.daemon.dispatch({ type: "interrupt", threadId: 1 });
  await h.settle();
  assert.equal(h.sessions[0].interrupts, 1);
});

test("an interrupt for a thread with no session does not create one", async () => {
  const h = daemonHarness();
  h.daemon.dispatch({ type: "interrupt", threadId: 99 });
  await h.settle();
  assert.equal(h.created, 0);
});

test("a permission decision is routed to the waiting request, not to a session", async () => {
  const h = daemonHarness();
  h.daemon.dispatch({ type: "permission_decision", threadId: 1, requestId: "r1", behavior: "allow" });
  await h.settle();
  assert.deepEqual(h.decisions, [{ requestId: "r1", behavior: "allow" }]);
  assert.equal(h.created, 0);
});

test("a permission decision with nothing waiting is tolerated", async () => {
  const h = daemonHarness({ resolveDecision: () => false });
  h.daemon.dispatch({ type: "permission_decision", threadId: 1, requestId: "late", behavior: "deny" });
  await h.settle();
  assert.equal(h.decisions.length, 1);
});

test("a question answer is routed to the waiting call, not to a session", async () => {
  const h = daemonHarness();
  h.daemon.dispatch({
    type: "question_answer",
    threadId: 1,
    requestId: "q1",
    answers: { "Which breakpoint?": "lg (1280px+)" },
  });
  await h.settle();
  assert.deepEqual(h.answers, [{ requestId: "q1", answers: { "Which breakpoint?": "lg (1280px+)" } }]);
  // A question is answered inside a turn that is already running; creating a
  // session for it would start a second one for the same thread.
  assert.equal(h.created, 0);
});

test("a question answer with nothing waiting is tolerated", async () => {
  const h = daemonHarness({ resolveAnswer: () => false });
  h.daemon.dispatch({ type: "question_answer", threadId: 1, requestId: "late", answers: { a: "b" } });
  await h.settle();
  assert.equal(h.answers.length, 1);
});

// --- run loop --------------------------------------------------------------

test("run reconnects with backoff after a failure and stops when aborted", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  const daemon = new ChatDaemon({
    listAwaiting: async () => [],
    subscribe: async () => {
      attempts += 1;
      if (attempts >= 4) controller.abort();
      throw new Error("connection refused");
    },
    createSession: async () => {
      throw new Error("unused");
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await daemon.run(controller.signal);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [2000, 4000, 8000]);
});

test("a clean stream end reconnects from the bottom of the backoff", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  const daemon = new ChatDaemon({
    listAwaiting: async () => [],
    subscribe: async () => {
      attempts += 1;
      if (attempts >= 3) controller.abort();
    },
    createSession: async () => {
      throw new Error("unused");
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await daemon.run(controller.signal);
  assert.deepEqual(delays, [1000, 1000]);
});

test("run does nothing when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  const daemon = new ChatDaemon({
    listAwaiting: async () => [],
    subscribe: async () => {
      attempts += 1;
    },
    createSession: async () => {
      throw new Error("unused");
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async () => undefined,
  });
  await daemon.run(controller.signal);
  assert.equal(attempts, 0);
});

test("events received from the stream are dispatched", async () => {
  const h = daemonHarness();
  const controller = new AbortController();
  const daemon = new ChatDaemon({
    listAwaiting: async () => [],
    subscribe: async (onEvent) => {
      onEvent(human(5, "from the stream"));
      controller.abort();
    },
    createSession: async (threadId, onClosed) => {
      const session = new FakeSession(threadId, onClosed);
      h.sessions.push(session);
      return session;
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async () => undefined,
  });
  await daemon.run(controller.signal);
  await h.settle();
  assert.deepEqual(h.sessions[0].sent, ["from the stream"]);
});

// --- shutdown --------------------------------------------------------------

test("shutdown closes every live session", async () => {
  const h = daemonHarness();
  h.daemon.dispatch(human(1, "a"));
  h.daemon.dispatch(human(2, "b"));
  await h.settle();
  await h.daemon.shutdown();
  assert.equal(h.daemon.liveSessions, 0);
  assert.deepEqual(h.sessions.map((s) => s.closedWith), ["daemon shutdown", "daemon shutdown"]);
});

test("events arriving after shutdown are ignored", async () => {
  const h = daemonHarness();
  await h.daemon.shutdown();
  h.daemon.dispatch(human(1, "too late"));
  await h.settle();
  assert.equal(h.created, 0);
});

test("a session that throws on close does not stop the others closing", async () => {
  const h = daemonHarness();
  h.daemon.dispatch(human(1, "a"));
  h.daemon.dispatch(human(2, "b"));
  await h.settle();
  h.sessions[0].close = async () => {
    throw new Error("already gone");
  };
  await h.daemon.shutdown();
  assert.equal(h.sessions[1].closedWith, "daemon shutdown");
});

// Regression, found live 2026-09-17: pinboard's bus is fire-and-forget, so a
// message posted while nothing was subscribed reached nobody, ever - the
// thread sat at awaitingAgent: true with no error on either side. The poller
// this replaced could not lose a message, because awaitingAgent is durable
// state it re-read every 2s. Catching up on reconnect is what keeps the
// stream a latency win rather than a reliability regression.
test("a message missed while disconnected is caught up on reconnect", async () => {
  const h = daemonHarness({ listAwaiting: async () => [{ threadId: 9, message: "sent while you were down" }] });
  const controller = new AbortController();
  let subscribes = 0;
  const daemon = new ChatDaemon({
    listAwaiting: async () => [{ threadId: 9, message: "sent while you were down" }],
    subscribe: async () => {
      subscribes += 1;
      controller.abort();
    },
    createSession: h.deps.createSession,
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async () => undefined,
  });
  await daemon.run(controller.signal);
  await h.settle();
  assert.equal(subscribes, 1);
  assert.equal(h.sessions.length, 1, "the missed message must start a session");
  assert.deepEqual(h.sessions[0].sent, ["sent while you were down"]);
});

test("catch-up runs before the stream, so nothing is waiting on a live event", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  const daemon = new ChatDaemon({
    listAwaiting: async () => {
      order.push("catchUp");
      return [];
    },
    subscribe: async () => {
      order.push("subscribe");
      controller.abort();
    },
    createSession: async () => {
      throw new Error("unused");
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async () => undefined,
  });
  await daemon.run(controller.signal);
  assert.deepEqual(order, ["catchUp", "subscribe"]);
});

test("a failing catch-up does not stop the daemon subscribing", async () => {
  const controller = new AbortController();
  let subscribed = false;
  const daemon = new ChatDaemon({
    listAwaiting: async () => {
      throw new Error("pinboard unreachable");
    },
    subscribe: async () => {
      subscribed = true;
      controller.abort();
    },
    createSession: async () => {
      throw new Error("unused");
    },
    resolveDecision: () => true,
    resolveAnswer: () => true,
    sleep: async () => undefined,
  });
  await daemon.run(controller.signal);
  assert.equal(subscribed, true);
});
