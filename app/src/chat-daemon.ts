// the process that owns the live chat sessions.
//
// Replaces chat.ts's `work chat watch` poll loop. The shape stays the same in
// the one way that matters - foreman still opens the connection, pinboard
// never reaches in - but instead of asking "is any thread awaiting a reply?"
// every two seconds, foreman holds one SSE subscription open and pinboard
// pushes: an operator message, a permission decision, an interrupt.
//
// Three responsibilities, and nothing else:
//   1. the session map, keyed by thread id (one live Claude session each);
//   2. the subscription, with reconnect and backoff, because a long-lived
//      HTTP connection WILL drop - pinboard restarts on every deploy;
//   3. graceful shutdown, so a SIGTERM closes sessions rather than orphaning
//      Claude processes.

import { CHAT_ALLOWED_TOOLS, CHAT_DISALLOWED_TOOLS, DEFAULT_MODEL } from "./agent-settings.js";
import { resolveCwd, resolvePersona, systemFraming } from "./chat.js";
import { PendingAnswers, PendingDecisions, type OperatorAnswer, type OperatorDecision } from "./chat-permissions.js";
import { ChatSession, defaultQuery, type ChatSessionDeps } from "./chat-session.js";
import {
  getChatMessages,
  getChatThread,
  listAgents,
  listChatThreads,
  listLicenses,
  listPermissionRules,
  listProjects,
  patchChatThread,
  postChatEvents,
  postChatMessage,
  postChatUsage,
  postPermissionRule,
  revokePermissionRule,
  subscribeChatStream,
  type ChatStreamEvent,
} from "./pinboard.js";
import { spawnEnvOrThrow } from "./spawn-env.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

// Exponential with a cap. No jitter on purpose: there is exactly one
// subscriber, so there is no thundering herd to spread out, and a predictable
// delay is easier to recognise in the logs during a pinboard restart.
export function backoffDelayMs(attempt: number, baseMs = RECONNECT_BASE_MS, capMs = RECONNECT_CAP_MS): number {
  if (attempt <= 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** attempt);
}

// What the daemon needs of a session - narrow on purpose so the tests can
// stand in a fake without an SDK anywhere near them.
export interface ManagedSession {
  readonly threadId: number;
  readonly isClosed: boolean;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface ChatDaemonDeps {
  subscribe: (onEvent: (event: ChatStreamEvent) => void, opts: { signal: AbortSignal }) => Promise<void>;
  createSession: (threadId: number, onClosed: (threadId: number) => void) => Promise<ManagedSession>;
  resolveDecision: (requestId: string, decision: OperatorDecision) => boolean;
  /** the same, for an AskUserQuestion call parked on an answer. */
  resolveAnswer: (requestId: string, answer: OperatorAnswer) => boolean;
  /** Threads whose last message is a human one still waiting for a reply,
   *  with that message's text - the catch-up the stream alone cannot do. */
  listAwaiting: () => Promise<{ threadId: number; message: string }[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ChatDaemon {
  private readonly sessions = new Map<number, ManagedSession>();
  // One promise chain per thread, so two operator messages arriving in quick
  // succession reach the session in the order they were sent - an SSE
  // callback is synchronous, and `send` is not.
  private readonly queues = new Map<number, Promise<void>>();
  private stopping = false;

  constructor(private readonly deps: ChatDaemonDeps) {}

  get liveSessions(): number {
    return this.sessions.size;
  }

  /** Subscribe until the signal aborts, reconnecting with backoff whenever
   *  the stream ends or fails. */
  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let attempt = 0;
    let lastError: string | null = null;
    while (!signal.aborted) {
      try {
        // Catch up BEFORE handing control to the stream, every time the
        // connection is (re)established.
        //
        // The bus pinboard publishes on is fire-and-forget: an event emitted
        // while nothing is subscribed reaches nobody, ever. So a message sent
        // during a redeploy, a pinboard restart or any reconnect window is
        // simply never seen, and the thread sits at awaitingAgent: true
        // forever with no error anywhere. Found live on 2026-09-17 - a
        // message posted a fraction of a second after `systemctl restart`
        // vanished exactly this way.
        //
        // The poller this daemon replaced could not miss anything, because
        // awaitingAgent is durable state and it re-read it every 2s. Keeping
        // that property is what makes the stream a latency optimisation
        // rather than a reliability regression: the stream delivers in under
        // a second, and this makes sure nothing is lost when it cannot.
        await this.catchUp();
        await this.deps.subscribe((event) => this.dispatch(event), { signal });
        // A clean end is still a disconnect - pinboard restarted, or a proxy
        // timed the connection out. Reconnect, but from the bottom of the
        // backoff, since the connection itself was healthy.
        attempt = 0;
        lastError = null;
        if (!signal.aborted) console.log("chat: stream ended, reconnecting");
      } catch (err) {
        if (signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        // Same "log it once, not every retry" treatment the poll loop gave a
        // briefly unreachable pinboard.
        if (message !== lastError) console.error(`chat: stream failed: ${message}`);
        lastError = message;
        attempt += 1;
      }
      if (signal.aborted) break;
      await sleep(backoffDelayMs(attempt), signal);
    }
  }

  /** Replays whatever the stream could not deliver. Runs through the same
   *  per-thread queue as a streamed message, so a catch-up and a live event
   *  arriving together cannot start two sessions for one thread. */
  private async catchUp(): Promise<void> {
    let awaiting: { threadId: number; message: string }[];
    try {
      awaiting = await this.deps.listAwaiting();
    } catch (err) {
      // pinboard being unreachable is already why we are reconnecting; the
      // next attempt will try again.
      console.error(`chat: catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (awaiting.length === 0) return;
    console.log(`chat: catching up on ${awaiting.length} thread(s) missed while disconnected`);
    for (const { threadId, message } of awaiting) {
      this.dispatch({ type: "human_message", threadId, message });
    }
  }

  /** Synchronous entry point for the SSE callback: never throws, never
   *  blocks the stream reader. */
  dispatch(event: ChatStreamEvent): void {
    if (this.stopping) return;
    if (event.type === "permission_decision") {
      // Answers are not queued behind a thread's sends: a tool call parked on
      // an approval is exactly what a send would be waiting behind.
      const matched = this.deps.resolveDecision(event.requestId, {
        behavior: event.behavior,
        updatedPermissions: event.updatedPermissions as PermissionUpdate[] | undefined,
      });
      if (!matched) {
        console.warn(`chat: thread #${event.threadId} permission decision ${event.requestId} had nothing waiting for it`);
      }
      return;
    }
    if (event.type === "question_answer") {
      // Same reasoning as a permission decision: the tool call parked on this
      // answer is exactly what a queued send would be waiting behind.
      const matched = this.deps.resolveAnswer(event.requestId, {
        answers: event.answers,
        ...(event.annotations ? { annotations: event.annotations } : {}),
      });
      if (!matched) {
        console.warn(`chat: thread #${event.threadId} question answer ${event.requestId} had nothing waiting for it`);
      }
      return;
    }
    this.enqueue(event.threadId, async () => {
      if (event.type === "human_message") {
        const session = await this.sessionFor(event.threadId);
        await session.send(event.message);
        return;
      }
      if (event.type === "interrupt") {
        await this.sessions.get(event.threadId)?.interrupt();
      }
    });
  }

  private enqueue(threadId: number, work: () => Promise<void>): void {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((err: unknown) => {
        console.error(
          `chat: thread #${threadId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    this.queues.set(threadId, next);
  }

  private async sessionFor(threadId: number): Promise<ManagedSession> {
    const existing = this.sessions.get(threadId);
    // A session that timed out idle (or died) is simply replaced - its
    // conversation is in pinboard and its claudeSessionId resumes it.
    if (existing && !existing.isClosed) return existing;
    const session = await this.deps.createSession(threadId, (id) => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    this.sessions.set(threadId, session);
    return session;
  }

  /** Close every live session. A turn mid-flight is ended rather than
   *  orphaned: its Claude process is a child of this one. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((session) =>
        session.close("daemon shutdown").catch((err: unknown) => {
          console.error(`chat: thread #${session.threadId} close failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
      ),
    );
    await Promise.all([...this.queues.values()].map((q) => q.catch(() => undefined)));
    this.queues.clear();
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export async function createChatDaemon(): Promise<{
  daemon: ChatDaemon;
  pending: PendingDecisions;
  pendingAnswers: PendingAnswers;
}> {
  const pending = new PendingDecisions();
  const pendingAnswers = new PendingAnswers();
  const query = await defaultQuery();

  const deps: ChatDaemonDeps = {
    subscribe: (onEvent, opts) => subscribeChatStream(onEvent, opts),
    // Same filter the poller used (open, awaiting a reply, not a task's own
    // session thread - those are answered by the task's runner, never here).
    // The last message is re-sent rather than the whole backlog: a thread
    // only ever waits on one, since awaitingAgent clears when the reply is
    // posted.
    listAwaiting: async () => {
      const threads = await listChatThreads({ awaitingAgent: true, status: "open", taskId: "none" });
      const caught: { threadId: number; message: string }[] = [];
      for (const thread of threads) {
        const messages = await getChatMessages(thread.id);
        const last = messages[messages.length - 1];
        if (last?.role === "human") caught.push({ threadId: thread.id, message: last.body });
      }
      return caught;
    },
    resolveDecision: (requestId, decision) => pending.resolve(requestId, decision),
    resolveAnswer: (requestId, answer) => pendingAnswers.resolve(requestId, answer),
    createSession: async (threadId, onClosed) => {
      const thread = await getChatThread(threadId);
      const [projects, agents, licenses, messages] = await Promise.all([
        listProjects(),
        listAgents(),
        listLicenses(),
        getChatMessages(threadId),
      ]);
      const project = projects.find((p) => p.id === thread.projectId) ?? undefined;
      const agent = agents.find((a) => a.id === thread.agentId) ?? undefined;
      const persona = resolvePersona(thread, agent);
      const license = agent ? licenses.find((l) => l.id === agent.licenseId) : undefined;
      const spawnEnv = spawnEnvOrThrow(license);

      const sessionDeps: ChatSessionDeps = {
        query,
        postEvents: postChatEvents,
        postMessage: postChatMessage,
        postUsage: postChatUsage,
        patchThread: patchChatThread,
        listRules: listPermissionRules,
        postRule: postPermissionRule,
        revokeRule: revokePermissionRule,
        waitForDecision: (requestId, opts) => pending.wait(requestId, opts),
        waitForAnswer: (requestId, opts) => pendingAnswers.wait(requestId, opts),
      };

      return new ChatSession(
        {
          threadId,
          cwd: resolveCwd(project),
          model: persona.model || DEFAULT_MODEL,
          effort: persona.effort,
          systemPrompt: systemFraming(project, persona.isHostAgent),
          // Same split a past task left in place: the host persona runs `auto`
          // with permission-gate.ts's floor under it and no tool lists, the
          // planning persona stays read-only by construction.
          permissionMode: persona.isHostAgent ? "auto" : "bypassPermissions",
          ...(persona.isHostAgent ? {} : { allowedTools: CHAT_ALLOWED_TOOLS, disallowedTools: CHAT_DISALLOWED_TOOLS }),
          resumeSessionId: thread.claudeSessionId,
          // One turn per operator message the thread has already seen, so
          // turn numbers keep climbing across session restarts.
          startingTurn: messages.filter((m) => m.role === "human").length,
          spawnEnv,
          onClosed,
        },
        sessionDeps,
      );
    },
  };

  return { daemon: new ChatDaemon(deps), pending, pendingAnswers };
}

// `work chat daemon` - see work.ts.
export async function runChatDaemon(signal: AbortSignal): Promise<void> {
  const { daemon, pending, pendingAnswers } = await createChatDaemon();
  console.log("chat: subscribing to pinboard's chat stream (host persona: any agent with isHost set)");
  try {
    await daemon.run(signal);
  } finally {
    pending.cancelAll();
    pendingAnswers.cancelAll();
    await daemon.shutdown();
    console.log("chat: daemon stopped");
  }
}
