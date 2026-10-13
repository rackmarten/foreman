// the `canUseTool` callback that replaces permission-server.ts's
// hand-rolled MCP prompt server.
//
// Same job, three things it does better. The MCP server was a subprocess
// `claude` spawned per turn, which meant (a) an approval could only ever be
// remembered for that one turn - rememberedThisTurn died with the process -
// (b) a pinboard blip that killed the subprocess turned every later tool
// call into a generic "Connection closed" (thread #23, 2026-09-16), and (c)
// the approval surface was a chat message the operator had to answer in
// prose. A live session's canUseTool is a plain async function in this
// process: the decision is a structured event the PWA renders as buttons,
// the answer arrives on the SSE stream, and "don't ask again" is persisted
// as a pinboard rule instead of a Set that outlives nothing.
//
// What carries over unchanged is a past task's floor: permission-gate.ts's
// evaluate() runs FIRST and its "ask" beats every stored rule, including an
// allow rule the operator granted earlier. An always-ask list a saved rule
// could silently switch off would not be a floor.

import { evaluate, type GateDecision } from "./permission-gate.js";
import type { ChatPermissionRule, ChatPermissionRuleInput } from "./pinboard.js";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

// A past task established `auto` as the session's permission mode and this as
// the destination for anything the operator grants mid-session: "session"
// keeps a granted rule inside this one live query and out of any settings
// file on disk. Its counterpart - surviving a restart - is pinboard's own
// permission-rules table, not a file.
export const PERMISSION_DESTINATION = "session" as const;

// Unchanged from permission-server.ts: long enough for an operator to notice
// and answer, and a denial rather than an open-ended park past it.
export const MAX_WAIT_MS = 30 * 60 * 1000;

export type DecisionOutcome = "allow" | "deny" | "ask";

export interface RuleDecision {
  outcome: DecisionOutcome;
  reason: string;
  ruleId?: number;
}

// The free-text part of a tool call a `ruleContent` is matched against.
// Bash carries a command; the file tools carry a path; everything else is a
// whole-tool rule or nothing, which mirrors how Claude Code's own
// `Tool(content)` rules read.
export function ruleContentTarget(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "Bash") {
    const command = input.command;
    return typeof command === "string" ? command : undefined;
  }
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const path = input.file_path ?? input.path;
    return typeof path === "string" ? path : undefined;
  }
  return undefined;
}

// `git status:*` style prefix rules, plus plain equality. The check that the
// character after the prefix is whitespace (or nothing) is the same class of
// care permission-gate.ts's anchors take: without it a rule for `git push`
// would also match `git pushd`, and a rule is supposed to be narrower than
// its wording, never wider.
export function matchRuleContent(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  const prefix = pattern.endsWith(":*")
    ? pattern.slice(0, -2)
    : pattern.endsWith("*")
      ? pattern.slice(0, -1)
      : null;
  if (prefix === null) return false;
  if (prefix === "") return true;
  if (!target.startsWith(prefix)) return false;
  const rest = target.slice(prefix.length);
  return rest === "" || /^\s/.test(rest) || /\s$/.test(prefix);
}

export function ruleApplies(rule: ChatPermissionRule, turn: number): boolean {
  if (rule.revokedAt !== null) return false;
  if (rule.scope === "thread") return true;
  return rule.turn === turn;
}

export function ruleMatches(rule: ChatPermissionRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;
  if (!rule.ruleContent) return true;
  const target = ruleContentTarget(toolName, input);
  if (target === undefined) return false;
  return matchRuleContent(rule.ruleContent, target);
}

// Tools whose whole purpose is to reach the operator, and which cannot touch
// anything else. Asking permission to ask a question is pure friction: the
// operator is already looking at the thread, and the prompt they have to
// approve is a prompt to show them a prompt.
//
// This is a *fallback*, not an override - see the precedence note below. It
// only replaces the "no saved rule covers this call" default, so the
// always-ask gate and an explicit saved deny rule both still win over it.
//
// Deliberately one entry. Every name added here is a tool that will run
// unattended forever after, so the bar is "cannot affect anything outside
// this conversation", not "seems harmless".
export const ALWAYS_ALLOW_TOOLS = new Set(["AskUserQuestion"]);

// A past task. Tools whose *result* is the operator's own answer rather than
// something the tool works out for itself. Allowing one of these is only half
// the job: the call still has to reach a human and come back with picks, or
// the tool runs with no answers and reports "The user did not answer the
// questions" - which is exactly what happened on every chat turn before this
// (thread #32, 2026-09-17), costing two turns of the agent retyping its
// questions as prose.
//
// The route is the SDK's own: AskUserQuestion's input schema carries an
// `answers` field documented as "User answers collected by the permission
// component", and for an Agent SDK host `canUseTool` IS that component. So
// the answer is returned as `updatedInput`, and the CLI's own tool
// implementation turns it into the tool result the model reads.
export const QUESTION_TOOLS = new Set(["AskUserQuestion"]);

// An option's preview is free-form content the model writes (a mockup, a
// code snippet), and pinboard truncates any event payload over 64KB by
// replacing its large fields wholesale. A truncated `questions` array reaches
// the PWA as a card with nothing to tap, which parks the session until its
// deadline - so previews are clipped here, where the clip is still a readable
// preview rather than a lost question. Four questions x four options at this
// size is ~35KB, comfortably inside the cap.
export const MAX_PREVIEW_CHARS = 2000;

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface OperatorQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

// Read defensively rather than trusted: the model writes this, and a
// malformed question that reached the PWA as a card with no options would be
// a dead end the operator cannot answer OR dismiss - the session would just
// sit there until the 30-minute deadline. Anything unreadable yields an empty
// list, and the caller then lets the tool answer for itself.
export function normalizeQuestions(raw: unknown): OperatorQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: OperatorQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== "string" || q.question.length === 0) continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const rawOption of q.options) {
        if (!rawOption || typeof rawOption !== "object") continue;
        const o = rawOption as Record<string, unknown>;
        if (typeof o.label !== "string" || o.label.length === 0) continue;
        options.push({
          label: o.label,
          description: typeof o.description === "string" ? o.description : "",
          ...(typeof o.preview === "string" && o.preview.length > 0
            ? { preview: o.preview.slice(0, MAX_PREVIEW_CHARS) }
            : {}),
        });
      }
    }
    // A question with nothing to pick is not answerable. Dropped rather than
    // rendered, since the operator can always reply in prose instead.
    if (options.length === 0) continue;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions;
}

// Precedence, highest first: the always-ask gate, then a deny rule, then an
// allow rule, then the always-allow list, then ask. A stored `ask` rule lands
// on the same outcome as no rule at all - it exists so the operator can
// revoke an earlier "always allow" by overriding it rather than by deleting
// history.
export function decidePermission(args: {
  toolName: string;
  input: Record<string, unknown>;
  rules: ChatPermissionRule[];
  turn: number;
  gate?: (toolName: string, input: unknown) => GateDecision;
}): RuleDecision {
  const gate = (args.gate ?? evaluate)(args.toolName, args.input);
  if (gate.ask) return { outcome: "ask", reason: `foreman always-ask list: ${gate.reason}` };

  const matching = args.rules.filter((rule) => ruleApplies(rule, args.turn) && ruleMatches(rule, args.toolName, args.input));
  const deny = matching.find((rule) => rule.behavior === "deny");
  if (deny) return { outcome: "deny", reason: `denied by a saved rule for ${deny.toolName}`, ruleId: deny.id };
  const allow = matching.find((rule) => rule.behavior === "allow");
  if (allow) return { outcome: "allow", reason: `allowed by a saved rule for ${allow.toolName}`, ruleId: allow.id };
  if (ALWAYS_ALLOW_TOOLS.has(args.toolName)) {
    return { outcome: "allow", reason: `${args.toolName} only asks the operator something` };
  }
  return { outcome: "ask", reason: "no saved rule covers this call" };
}

// A pinboard rule row as an SDK PermissionUpdate, for replaying persisted
// rules into a freshly started session.
export function ruleToPermissionUpdate(rule: {
  toolName: string;
  ruleContent?: string | null;
  behavior: "allow" | "deny" | "ask";
}): PermissionUpdate {
  return {
    type: "addRules",
    rules: [{ toolName: rule.toolName, ...(rule.ruleContent ? { ruleContent: rule.ruleContent } : {}) }],
    behavior: rule.behavior,
    destination: PERMISSION_DESTINATION,
  };
}

// The other direction: the `updatedPermissions` the operator's "don't ask
// again" (or "stop allowing that") produced, as work to do against pinboard.
//
// Three of the SDK's update types map onto rules and are persisted:
//   addRules     -> create
//   removeRules  -> revoke the matching rows
//   replaceRules -> revoke every row with that behavior, then create
//                   (pinboard has no single replace route, so it is the two
//                   calls in that order)
// The other three - setMode, addDirectories, removeDirectories - describe
// session state rather than a rule about a tool, so there is nothing to
// persist; they are reported as skipped and left to live and die with the
// session.
export interface RevokeTarget {
  // "value" revokes the rows matching this exact rule; "behavior" revokes
  // every active row carrying that behavior (what replaceRules means).
  kind: "value" | "behavior";
  behavior: "allow" | "deny" | "ask";
  toolName?: string;
  ruleContent?: string;
}

export interface PermissionUpdatePlan {
  create: ChatPermissionRuleInput[];
  revoke: RevokeTarget[];
  skipped: string[];
}

export function planPermissionUpdates(
  updates: PermissionUpdate[],
  scope: "thread" | "turn",
  turn: number,
): PermissionUpdatePlan {
  const plan: PermissionUpdatePlan = { create: [], revoke: [], skipped: [] };
  for (const update of updates) {
    if (update.type === "setMode" || update.type === "addDirectories" || update.type === "removeDirectories") {
      plan.skipped.push(update.type);
      continue;
    }
    if (update.type === "replaceRules") {
      plan.revoke.push({ kind: "behavior", behavior: update.behavior });
    }
    for (const value of update.rules) {
      if (update.type === "removeRules") {
        plan.revoke.push({
          kind: "value",
          behavior: update.behavior,
          toolName: value.toolName,
          ...(value.ruleContent ? { ruleContent: value.ruleContent } : {}),
        });
        continue;
      }
      plan.create.push({
        toolName: value.toolName,
        ...(value.ruleContent ? { ruleContent: value.ruleContent } : {}),
        behavior: update.behavior,
        scope,
        ...(scope === "turn" ? { turn } : {}),
      });
    }
  }
  return plan;
}

// Which stored rows a plan's revoke targets actually name. Matched on the
// rule's own identity (tool + content + behavior), not on what it would match
// at call time: revoking "the rule that allows Bash(npm test:*)" must not
// also revoke a differently-worded rule that happens to cover the same
// command.
export function resolveRevocations(
  rules: ChatPermissionRule[],
  targets: RevokeTarget[],
): ChatPermissionRule[] {
  const resolved = new Map<number, ChatPermissionRule>();
  for (const rule of rules) {
    if (rule.revokedAt !== null) continue;
    for (const target of targets) {
      if (target.behavior !== rule.behavior) continue;
      if (target.kind === "behavior") {
        resolved.set(rule.id, rule);
        break;
      }
      if (target.toolName !== rule.toolName) continue;
      if ((target.ruleContent ?? null) !== (rule.ruleContent ?? null)) continue;
      resolved.set(rule.id, rule);
      break;
    }
  }
  return [...resolved.values()];
}

export interface OperatorDecision {
  behavior: "allow" | "deny";
  updatedPermissions?: PermissionUpdate[];
}

// The event kinds this module writes to the transcript. Named rather than
// inlined so pinboard's EVENT_KINDS list and this one are easy to diff by
// eye - a past task's lesson was that a producer and a consumer disagreeing
// about a name fails silently on both sides.
export type ChatOperatorEventKind = "permission_request" | "permission_decision" | "question" | "question_answer";

// what the operator sends back for an AskUserQuestion call.
// `answers` is keyed by the question's own text, which is the key the tool's
// own schema uses; a multi-select answer is the chosen labels joined with a
// comma, and an "Other" answer is simply the free text the operator typed.
export interface OperatorAnswer {
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

// Where a canUseTool call parks while the operator decides. The daemon owns
// one of these and resolves against it whenever the matching event arrives on
// the SSE stream - keyed by the SDK's own control-request id, so two calls
// waiting at once can never take each other's answer.
//
// Generic because a past task added a second thing a call can park on: an
// approval (`permission_decision`) and an answer (`question_answer`) are
// different payloads on different routes, but the waiting, the timeout, the
// abort and the "this arrived late" report are identical, and two hand-copied
// versions of that would drift.
export class PendingReplies<T> {
  private readonly waiters = new Map<string, (reply: T | null) => void>();

  get size(): number {
    return this.waiters.size;
  }

  /** Resolves with the operator's reply, or null on timeout/abort - null is
   *  the caller's cue to fall back to its own default. */
  wait(requestId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: T | null) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(requestId);
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), opts.timeoutMs);
      // A 30-minute timer must not be the reason this process cannot exit.
      if (typeof timer.unref === "function") timer.unref();
      if (opts.signal?.aborted) return finish(null);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(requestId, finish);
    });
  }

  /** True if this reply was for something actually waiting - a false return
   *  is one that arrived late (already timed out) or twice. */
  resolve(requestId: string, reply: T): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    waiter(reply);
    return true;
  }

  /** Fail every waiter closed - used on shutdown and when a session dies. */
  cancelAll(): void {
    for (const waiter of [...this.waiters.values()]) waiter(null);
    this.waiters.clear();
  }
}

export class PendingDecisions extends PendingReplies<OperatorDecision> {}
export class PendingAnswers extends PendingReplies<OperatorAnswer> {}

export interface CanUseToolDeps {
  threadId: number;
  loadRules: () => Promise<ChatPermissionRule[]>;
  saveRule: (rule: ChatPermissionRuleInput) => Promise<unknown>;
  revokeRule: (ruleId: number) => Promise<unknown>;
  emit: (kind: ChatOperatorEventKind, payload: Record<string, unknown>) => void;
  /** Flush pending events before parking - the operator cannot answer a
   *  request that is still sitting in the batcher. */
  flush: () => Promise<void>;
  waitForDecision: (requestId: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<OperatorDecision | null>;
  /** A past task's counterpart to waitForDecision, parked on by a question
   *  rather than by an approval. */
  waitForAnswer: (requestId: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<OperatorAnswer | null>;
  currentTurn: () => number;
  maxWaitMs?: number;
  gate?: (toolName: string, input: unknown) => GateDecision;
}

// Matches the SDK's CanUseTool signature (toolName, input, options) without
// importing the SDK at runtime - see chat-session.ts's note on why nothing
// in this repo loads the SDK bundle outside a real session.
export interface CanUseToolOptions {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  requestId: string;
  toolUseID: string;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
  suppressAlwaysAllowRule?: boolean;
}

export function createCanUseTool(deps: CanUseToolDeps) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    const turn = deps.currentTurn();

    // A rules fetch that fails must not auto-allow: fall back to an empty
    // rule set, which can only ever send the call to the operator.
    let rules: ChatPermissionRule[] = [];
    try {
      rules = await deps.loadRules();
    } catch (err) {
      console.error(
        `chat: thread #${deps.threadId} could not load permission rules, asking the operator: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const decision = decidePermission({ toolName, input, rules, turn, gate: deps.gate });
    if (decision.outcome === "allow") {
      // Allowed, but for a question tool "allowed" is only the start: the
      // call still has to reach the operator and come back. Deliberately
      // downstream of decidePermission rather than ahead of it, so the
      // always-ask floor and a saved deny rule keep their precedence.
      if (QUESTION_TOOLS.has(toolName)) return askOperator(deps, toolName, input, options, turn);
      return { behavior: "allow" };
    }
    if (decision.outcome === "deny") return { behavior: "deny", message: decision.reason };

    deps.emit("permission_request", {
      requestId: options.requestId,
      toolUseId: options.toolUseID,
      toolName,
      input,
      reason: decision.reason,
      // Verbatim, as the SDK's own doc asks: whatever the operator's "don't
      // ask again" button sends back has to be this exact set for the
      // session to treat it as the suggestion it offered.
      suggestions: options.suggestions ?? [],
      title: options.title,
      description: options.description,
      displayName: options.displayName,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      // The SDK sets this when the rule a "don't ask again" would write
      // grants more than this one call - the PWA must not offer the button.
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule ?? false,
      turn,
      expiresAt: new Date(Date.now() + (deps.maxWaitMs ?? MAX_WAIT_MS)).toISOString(),
    });
    await deps.flush();

    const answer = await deps.waitForDecision(options.requestId, {
      timeoutMs: deps.maxWaitMs ?? MAX_WAIT_MS,
      signal: options.signal,
    });

    if (answer === null) {
      const message = `no operator reply within ${(deps.maxWaitMs ?? MAX_WAIT_MS) / 1000}s - denying by default`;
      deps.emit("permission_decision", { requestId: options.requestId, toolName, behavior: "deny", reason: message, turn });
      return { behavior: "deny", message };
    }

    if (answer.behavior === "deny") {
      deps.emit("permission_decision", { requestId: options.requestId, toolName, behavior: "deny", turn });
      return { behavior: "deny", message: "operator denied this action" };
    }

    const updates = answer.updatedPermissions ?? [];
    // Persisted as well as returned: returning it teaches this session,
    // persisting it teaches the next one. Best-effort throughout - a rule
    // that fails to save still applies for the rest of this session, which
    // is no worse than what the MCP server managed at its best.
    const persisted = await applyPermissionUpdates(deps, updates, rules, turn);

    deps.emit("permission_decision", {
      requestId: options.requestId,
      toolName,
      behavior: "allow",
      remembered: persisted.created > 0,
      forgotten: persisted.revoked,
      turn,
    });
    return { behavior: "allow", ...(updates.length > 0 ? { updatedPermissions: updates } : {}) };
  };
}

// the question round-trip. Same three beats as an approval -
// emit, flush, park - with two differences that matter.
//
// The answer is returned as `updatedInput`, not as a tool result: the CLI's
// own AskUserQuestion implementation reads `answers` back out of the input it
// is handed, so the model keeps seeing the built-in tool with its built-in
// schema and nothing has to be aliased or re-implemented.
//
// And a timeout allows rather than denies. Decided up front on the task: a
// question the operator misses must never strand a turn. An allow with no
// answers makes the tool report "The user did not answer the questions",
// which is today's behaviour - except it now happens after a real wait
// instead of instantly.
async function askOperator(
  deps: CanUseToolDeps,
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
  turn: number,
): Promise<PermissionResult> {
  const questions = normalizeQuestions(input.questions);
  if (questions.length === 0) {
    console.warn(`chat: thread #${deps.threadId} ${toolName} call had no answerable question, letting it run as-is`);
    return { behavior: "allow" };
  }

  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  deps.emit("question", {
    requestId: options.requestId,
    toolUseId: options.toolUseID,
    toolName,
    questions,
    turn,
    expiresAt: new Date(Date.now() + maxWaitMs).toISOString(),
  });
  await deps.flush();

  const answer = await deps.waitForAnswer(options.requestId, { timeoutMs: maxWaitMs, signal: options.signal });

  if (answer === null) {
    deps.emit("question_answer", {
      requestId: options.requestId,
      turn,
      answered: false,
      reason: `no operator reply within ${Math.round(maxWaitMs / 1000)}s - the agent carries on without an answer`,
    });
    return { behavior: "allow" };
  }

  deps.emit("question_answer", {
    requestId: options.requestId,
    turn,
    answered: true,
    answers: answer.answers,
  });
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: answer.answers,
      ...(answer.annotations && Object.keys(answer.annotations).length > 0
        ? { annotations: answer.annotations }
        : {}),
    },
  };
}

// Revoke before create, deliberately: a replaceRules update means "these are
// the rules now", and creating first would leave a window where both the old
// and the new rule are active - which for an allow rule is a window where
// something the operator just revoked is still permitted.
async function applyPermissionUpdates(
  deps: CanUseToolDeps,
  updates: PermissionUpdate[],
  knownRules: ChatPermissionRule[],
  turn: number,
): Promise<{ created: number; revoked: number }> {
  if (updates.length === 0) return { created: 0, revoked: 0 };
  const plan = planPermissionUpdates(updates, "thread", turn);
  if (plan.skipped.length > 0) {
    console.warn(
      `chat: thread #${deps.threadId} not persisting session-only permission update(s): ${plan.skipped.join(", ")}`,
    );
  }

  let revoked = 0;
  for (const rule of resolveRevocations(knownRules, plan.revoke)) {
    try {
      await deps.revokeRule(rule.id);
      revoked += 1;
    } catch (err) {
      console.error(
        `chat: thread #${deps.threadId} could not revoke permission rule #${rule.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let created = 0;
  for (const rule of plan.create) {
    try {
      await deps.saveRule(rule);
      created += 1;
    } catch (err) {
      console.error(
        `chat: thread #${deps.threadId} could not persist permission rule for ${rule.toolName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { created, revoked };
}
