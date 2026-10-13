import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PREVIEW_CHARS,
  MAX_WAIT_MS,
  PendingAnswers,
  PendingDecisions,
  createCanUseTool,
  decidePermission,
  matchRuleContent,
  normalizeQuestions,
  planPermissionUpdates,
  resolveRevocations,
  ruleApplies,
  ruleContentTarget,
  ruleMatches,
  ruleToPermissionUpdate,
  type CanUseToolOptions,
  type OperatorAnswer,
} from "./chat-permissions.js";
import type { ChatPermissionRule, ChatPermissionRuleInput } from "./pinboard.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

function rule(overrides: Partial<ChatPermissionRule> = {}): ChatPermissionRule {
  return {
    id: 1,
    threadId: 1,
    toolName: "Bash",
    ruleContent: null,
    behavior: "allow",
    scope: "thread",
    turn: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

// --- precedence ------------------------------------------------------------

test("the always-ask gate beats an allow rule for the same call", () => {
  const decision = decidePermission({
    toolName: "Bash",
    input: { command: "git push origin main" },
    rules: [rule({ behavior: "allow", ruleContent: "git push:*" })],
    turn: 1,
  });
  assert.equal(decision.outcome, "ask");
  assert.match(decision.reason, /always-ask list/);
});

test("a deny rule beats an allow rule", () => {
  const decision = decidePermission({
    toolName: "Bash",
    input: { command: "npm test" },
    rules: [rule({ id: 7, behavior: "allow" }), rule({ id: 8, behavior: "deny" })],
    turn: 1,
  });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.ruleId, 8);
});

test("an allow rule allows when nothing denies and the gate is silent", () => {
  const decision = decidePermission({
    toolName: "Bash",
    input: { command: "npm test" },
    rules: [rule({ id: 9, behavior: "allow" })],
    turn: 1,
  });
  assert.deepEqual([decision.outcome, decision.ruleId], ["allow", 9]);
});

test("no matching rule asks", () => {
  const decision = decidePermission({ toolName: "Write", input: { file_path: "/a" }, rules: [], turn: 1 });
  assert.equal(decision.outcome, "ask");
});

// AskUserQuestion reaches the operator and nothing else, so approving it is a
// prompt to show a prompt. Seen live on chat thread #32 (2026-09-17): two
// questions in a row each needed a tap before the agent could ask them.
test("AskUserQuestion is allowed without asking when no rule covers it", () => {
  const decision = decidePermission({ toolName: "AskUserQuestion", input: { questions: [] }, rules: [], turn: 1 });
  assert.equal(decision.outcome, "allow");
  assert.match(decision.reason, /only asks the operator/);
});

// The always-allow list is a fallback under the rules, not an override on top
// of them - an operator who explicitly denied the tool still gets their way.
test("a deny rule still beats the always-allow list", () => {
  const decision = decidePermission({
    toolName: "AskUserQuestion",
    input: { questions: [] },
    rules: [rule({ id: 11, toolName: "AskUserQuestion", behavior: "deny", ruleContent: null })],
    turn: 1,
  });
  assert.deepEqual([decision.outcome, decision.ruleId], ["deny", 11]);
});

// And the floor still outranks it, so adding a name here can never punch a
// hole in the always-ask list by accident.
test("the always-ask gate still beats the always-allow list", () => {
  const decision = decidePermission({
    toolName: "AskUserQuestion",
    input: { questions: [] },
    rules: [],
    turn: 1,
    gate: () => ({ ask: true, reason: "test floor" }),
  });
  assert.equal(decision.outcome, "ask");
});

test("an explicit ask rule lands on ask rather than on an allow rule's outcome", () => {
  const decision = decidePermission({
    toolName: "Write",
    input: { file_path: "/a" },
    rules: [rule({ toolName: "Write", behavior: "ask" })],
    turn: 1,
  });
  assert.equal(decision.outcome, "ask");
});

test("a revoked rule is ignored", () => {
  const decision = decidePermission({
    toolName: "Bash",
    input: { command: "npm test" },
    rules: [rule({ behavior: "allow", revokedAt: new Date().toISOString() })],
    turn: 1,
  });
  assert.equal(decision.outcome, "ask");
});

test("a turn-scoped rule only applies to its own turn", () => {
  const turnRule = rule({ behavior: "allow", scope: "turn", turn: 4 });
  assert.equal(ruleApplies(turnRule, 4), true);
  assert.equal(ruleApplies(turnRule, 5), false);
  assert.equal(
    decidePermission({ toolName: "Bash", input: { command: "ls" }, rules: [turnRule], turn: 5 }).outcome,
    "ask",
  );
});

test("a custom gate can be injected without touching permission-gate's list", () => {
  const decision = decidePermission({
    toolName: "Read",
    input: {},
    rules: [rule({ toolName: "Read", behavior: "allow" })],
    turn: 1,
    gate: () => ({ ask: true, reason: "test gate" }),
  });
  assert.deepEqual([decision.outcome, decision.reason], ["ask", "foreman always-ask list: test gate"]);
});

// --- rule content matching -------------------------------------------------

test("ruleContentTarget reads the command for Bash and the path for file tools", () => {
  assert.equal(ruleContentTarget("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(ruleContentTarget("Read", { file_path: "/app/x.ts" }), "/app/x.ts");
  assert.equal(ruleContentTarget("Glob", { pattern: "*" }), undefined);
});

test("matchRuleContent handles exact, prefix and wildcard forms", () => {
  assert.equal(matchRuleContent("npm test", "npm test"), true);
  assert.equal(matchRuleContent("npm test", "npm test -- --watch"), false);
  assert.equal(matchRuleContent("npm test:*", "npm test -- --watch"), true);
  assert.equal(matchRuleContent("npm test:*", "npm test"), true);
  assert.equal(matchRuleContent("*", "anything at all"), true);
});

test("a prefix rule does not match a longer word starting with it", () => {
  assert.equal(matchRuleContent("git push:*", "git pushd"), false);
  assert.equal(matchRuleContent("git push:*", "git push origin"), true);
});

test("a rule with no ruleContent covers the whole tool", () => {
  assert.equal(ruleMatches(rule({ toolName: "Read" }), "Read", { file_path: "/x" }), true);
  assert.equal(ruleMatches(rule({ toolName: "Read" }), "Write", { file_path: "/x" }), false);
});

test("a ruleContent rule does not match a tool whose input carries no target", () => {
  assert.equal(ruleMatches(rule({ toolName: "Glob", ruleContent: "x" }), "Glob", { pattern: "y" }), false);
});

// --- rule <-> PermissionUpdate translation ---------------------------------

test("ruleToPermissionUpdate builds a session-scoped addRules update", () => {
  assert.deepEqual(ruleToPermissionUpdate({ toolName: "Bash", ruleContent: "npm test:*", behavior: "allow" }), {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
    behavior: "allow",
    destination: "session",
  });
});

test("ruleToPermissionUpdate omits ruleContent for a whole-tool rule", () => {
  assert.deepEqual(ruleToPermissionUpdate({ toolName: "Read", ruleContent: null, behavior: "allow" }), {
    type: "addRules",
    rules: [{ toolName: "Read" }],
    behavior: "allow",
    destination: "session",
  });
});

test("planPermissionUpdates flattens addRules and reports what it skipped", () => {
  const updates: PermissionUpdate[] = [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "Read" }],
      behavior: "allow",
      destination: "session",
    },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
    { type: "addDirectories", directories: ["/tmp"], destination: "session" },
  ];
  const plan = planPermissionUpdates(updates, "thread", 3);
  assert.deepEqual(plan.create, [
    { toolName: "Bash", ruleContent: "npm test:*", behavior: "allow", scope: "thread" },
    { toolName: "Read", behavior: "allow", scope: "thread" },
  ]);
  assert.deepEqual(plan.revoke, []);
  assert.deepEqual(plan.skipped, ["setMode", "addDirectories"]);
});

test("planPermissionUpdates stamps the turn only on turn-scoped rules", () => {
  const updates: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" },
  ];
  assert.deepEqual(planPermissionUpdates(updates, "turn", 9).create, [
    { toolName: "Read", behavior: "allow", scope: "turn", turn: 9 },
  ]);
});

test("removeRules becomes a revoke target and creates nothing", () => {
  const updates: PermissionUpdate[] = [
    {
      type: "removeRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "session",
    },
  ];
  const plan = planPermissionUpdates(updates, "thread", 1);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.revoke, [
    { kind: "value", behavior: "allow", toolName: "Bash", ruleContent: "npm test:*" },
  ]);
});

test("replaceRules revokes everything with that behavior and then creates", () => {
  const updates: PermissionUpdate[] = [
    { type: "replaceRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" },
  ];
  const plan = planPermissionUpdates(updates, "thread", 1);
  assert.deepEqual(plan.revoke, [{ kind: "behavior", behavior: "allow" }]);
  assert.deepEqual(plan.create, [{ toolName: "Read", behavior: "allow", scope: "thread" }]);
});

test("resolveRevocations matches a rule by tool, content and behavior", () => {
  const rules = [
    rule({ id: 1, toolName: "Bash", ruleContent: "npm test:*", behavior: "allow" }),
    rule({ id: 2, toolName: "Bash", ruleContent: "npm test:*", behavior: "deny" }),
    rule({ id: 3, toolName: "Bash", ruleContent: "git log:*", behavior: "allow" }),
    rule({ id: 4, toolName: "Read", ruleContent: null, behavior: "allow" }),
  ];
  const resolved = resolveRevocations(rules, [
    { kind: "value", behavior: "allow", toolName: "Bash", ruleContent: "npm test:*" },
  ]);
  assert.deepEqual(resolved.map((r) => r.id), [1]);
});

test("resolveRevocations matches a whole-tool rule when no ruleContent is given", () => {
  const rules = [rule({ id: 4, toolName: "Read", ruleContent: null, behavior: "allow" })];
  assert.deepEqual(
    resolveRevocations(rules, [{ kind: "value", behavior: "allow", toolName: "Read" }]).map((r) => r.id),
    [4],
  );
});

test("a behavior-wide revoke target takes every active rule with that behavior", () => {
  const rules = [
    rule({ id: 1, behavior: "allow" }),
    rule({ id: 2, behavior: "allow", toolName: "Read" }),
    rule({ id: 3, behavior: "deny" }),
  ];
  assert.deepEqual(
    resolveRevocations(rules, [{ kind: "behavior", behavior: "allow" }]).map((r) => r.id),
    [1, 2],
  );
});

test("resolveRevocations never returns an already-revoked rule, or the same rule twice", () => {
  const rules = [
    rule({ id: 1, behavior: "allow", revokedAt: new Date().toISOString() }),
    rule({ id: 2, behavior: "allow" }),
  ];
  const resolved = resolveRevocations(rules, [
    { kind: "behavior", behavior: "allow" },
    { kind: "value", behavior: "allow", toolName: "Bash" },
  ]);
  assert.deepEqual(resolved.map((r) => r.id), [2]);
});

// --- PendingDecisions ------------------------------------------------------

test("a decision resolves the matching waiter only", async () => {
  const pending = new PendingDecisions();
  const a = pending.wait("r1", { timeoutMs: 1000 });
  const b = pending.wait("r2", { timeoutMs: 1000 });
  assert.equal(pending.size, 2);
  assert.equal(pending.resolve("r2", { behavior: "deny" }), true);
  assert.deepEqual(await b, { behavior: "deny" });
  assert.equal(pending.resolve("r1", { behavior: "allow" }), true);
  assert.deepEqual(await a, { behavior: "allow" });
  assert.equal(pending.size, 0);
});

test("a decision for nothing waiting is reported as unmatched", () => {
  assert.equal(new PendingDecisions().resolve("nope", { behavior: "allow" }), false);
});

test("a waiter that times out resolves null", async () => {
  const pending = new PendingDecisions();
  assert.equal(await pending.wait("r1", { timeoutMs: 5 }), null);
  assert.equal(pending.size, 0);
});

test("an aborted signal resolves the waiter null immediately", async () => {
  const pending = new PendingDecisions();
  const controller = new AbortController();
  const waiting = pending.wait("r1", { timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  assert.equal(await waiting, null);
});

test("cancelAll fails every waiter closed", async () => {
  const pending = new PendingDecisions();
  const a = pending.wait("r1", { timeoutMs: 60_000 });
  const b = pending.wait("r2", { timeoutMs: 60_000 });
  pending.cancelAll();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
});

// --- canUseTool ------------------------------------------------------------

interface ToolHarness {
  canUseTool: ReturnType<typeof createCanUseTool>;
  emitted: { kind: string; payload: Record<string, unknown> }[];
  saved: ChatPermissionRuleInput[];
  revoked: number[];
  flushes: number;
}

function toolHarness(overrides: {
  rules?: ChatPermissionRule[];
  loadRules?: () => Promise<ChatPermissionRule[]>;
  saveRule?: (rule: ChatPermissionRuleInput) => Promise<unknown>;
  revokeRule?: (ruleId: number) => Promise<unknown>;
  answer?: Awaited<ReturnType<NonNullable<Parameters<typeof createCanUseTool>[0]["waitForDecision"]>>>;
  questionAnswer?: OperatorAnswer | null;
  turn?: number;
} = {}): ToolHarness {
  const emitted: { kind: string; payload: Record<string, unknown> }[] = [];
  const saved: ChatPermissionRuleInput[] = [];
  const revoked: number[] = [];
  const h: ToolHarness = { emitted, saved, revoked, flushes: 0, canUseTool: (() => undefined) as never };
  h.canUseTool = createCanUseTool({
    threadId: 1,
    loadRules: overrides.loadRules ?? (async () => overrides.rules ?? []),
    saveRule:
      overrides.saveRule ??
      (async (r) => {
        saved.push(r);
      }),
    revokeRule:
      overrides.revokeRule ??
      (async (ruleId) => {
        revoked.push(ruleId);
      }),
    emit: (kind, payload) => emitted.push({ kind, payload }),
    flush: async () => {
      h.flushes += 1;
    },
    waitForDecision: async () => (overrides.answer === undefined ? { behavior: "allow" } : overrides.answer),
    waitForAnswer: async () => overrides.questionAnswer ?? null,
    currentTurn: () => overrides.turn ?? 1,
  });
  return h;
}

function toolOptions(overrides: Partial<CanUseToolOptions> = {}): CanUseToolOptions {
  return {
    signal: new AbortController().signal,
    requestId: "req-1",
    toolUseID: "toolu_1",
    ...overrides,
  };
}

test("canUseTool allows without asking when a rule already allows", async () => {
  const h = toolHarness({ rules: [rule({ behavior: "allow", ruleContent: "npm test:*" })] });
  const result = await h.canUseTool("Bash", { command: "npm test" }, toolOptions());
  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(h.emitted, []);
});

test("canUseTool denies without asking when a rule denies", async () => {
  const h = toolHarness({ rules: [rule({ behavior: "deny" })] });
  const result = await h.canUseTool("Bash", { command: "npm test" }, toolOptions());
  assert.equal(result.behavior, "deny");
  assert.deepEqual(h.emitted, []);
});

test("canUseTool asks the operator and passes the SDK's suggestions through verbatim", async () => {
  const suggestions: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
  ];
  const h = toolHarness();
  await h.canUseTool("Write", { file_path: "/app/x.ts" }, toolOptions({ suggestions, title: "Claude wants to write x.ts" }));
  const request = h.emitted.find((e) => e.kind === "permission_request");
  assert.ok(request);
  assert.equal(request.payload.requestId, "req-1");
  assert.equal(request.payload.title, "Claude wants to write x.ts");
  assert.deepEqual(request.payload.suggestions, suggestions);
  assert.equal(h.flushes, 1, "the request must be flushed before parking on the answer");
});

test("canUseTool asks even for an allowed rule when the always-ask gate fires", async () => {
  const h = toolHarness({ rules: [rule({ behavior: "allow" })] });
  await h.canUseTool("Bash", { command: "sudo systemctl restart foo" }, toolOptions());
  const request = h.emitted.find((e) => e.kind === "permission_request");
  assert.ok(request);
  assert.match(String(request.payload.reason), /always-ask list/);
});

test("an operator allow with updatedPermissions returns them and persists them", async () => {
  const updates: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" },
  ];
  const h = toolHarness({ answer: { behavior: "allow", updatedPermissions: updates } });
  const result = await h.canUseTool("Bash", { command: "npm test" }, toolOptions());
  assert.deepEqual(result, { behavior: "allow", updatedPermissions: updates });
  assert.deepEqual(h.saved, [{ toolName: "Bash", ruleContent: "npm test:*", behavior: "allow", scope: "thread" }]);
  const decision = h.emitted.find((e) => e.kind === "permission_decision");
  assert.deepEqual([decision?.payload.behavior, decision?.payload.remembered], ["allow", true]);
});

test("a failed rule save still allows the call for this session", async () => {
  const updates: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" },
  ];
  const h = toolHarness({
    answer: { behavior: "allow", updatedPermissions: updates },
    saveRule: async () => {
      throw new Error("pinboard down");
    },
  });
  const result = await h.canUseTool("Read", { file_path: "/x" }, toolOptions());
  assert.deepEqual(result, { behavior: "allow", updatedPermissions: updates });
});

test("an operator deny is reported as a deny with a message", async () => {
  const h = toolHarness({ answer: { behavior: "deny" } });
  const result = await h.canUseTool("Write", { file_path: "/x" }, toolOptions());
  assert.equal(result.behavior, "deny");
  assert.equal(result.behavior === "deny" && result.message, "operator denied this action");
});

test("no answer within the deadline fails closed", async () => {
  const h = toolHarness({ answer: null });
  const result = await h.canUseTool("Write", { file_path: "/x" }, toolOptions());
  assert.equal(result.behavior, "deny");
  assert.match(result.behavior === "deny" ? result.message : "", /denying by default/);
  assert.equal(MAX_WAIT_MS, 30 * 60 * 1000);
});

test("a rules fetch failure asks rather than allowing", async () => {
  const h = toolHarness({
    loadRules: async () => {
      throw new Error("pinboard down");
    },
    answer: { behavior: "deny" },
  });
  const result = await h.canUseTool("Bash", { command: "npm test" }, toolOptions());
  assert.equal(result.behavior, "deny");
  assert.ok(h.emitted.some((e) => e.kind === "permission_request"));
});

test("a removeRules answer revokes the matching stored rule", async () => {
  const stored = rule({ id: 11, toolName: "Bash", ruleContent: "npm test:*", behavior: "allow" });
  const updates: PermissionUpdate[] = [
    {
      type: "removeRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "session",
    },
  ];
  const h = toolHarness({ rules: [stored], answer: { behavior: "allow", updatedPermissions: updates } });
  // The stored rule allows it outright, so force the ask via the gate.
  const result = await h.canUseTool("Bash", { command: "sudo npm test" }, toolOptions());
  assert.equal(result.behavior, "allow");
  assert.deepEqual(h.revoked, [11]);
  assert.deepEqual(h.saved, []);
  const decision = h.emitted.find((e) => e.kind === "permission_decision");
  assert.equal(decision?.payload.forgotten, 1);
});

test("a replaceRules answer revokes the old allow rules before creating the new one", async () => {
  const order: string[] = [];
  const stored = rule({ id: 21, toolName: "Read", behavior: "allow" });
  const updates: PermissionUpdate[] = [
    { type: "replaceRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
  ];
  const h = toolHarness({
    rules: [stored],
    answer: { behavior: "allow", updatedPermissions: updates },
    saveRule: async () => {
      order.push("create");
    },
    revokeRule: async () => {
      order.push("revoke");
    },
  });
  await h.canUseTool("Write", { file_path: "/x" }, toolOptions());
  assert.deepEqual(order, ["revoke", "create"]);
});

test("a failed revoke still allows the call and still creates the new rule", async () => {
  const updates: PermissionUpdate[] = [
    { type: "replaceRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
  ];
  const h = toolHarness({
    rules: [rule({ id: 31, toolName: "Read", behavior: "allow" })],
    answer: { behavior: "allow", updatedPermissions: updates },
    revokeRule: async () => {
      throw new Error("pinboard down");
    },
  });
  const result = await h.canUseTool("Write", { file_path: "/x" }, toolOptions());
  assert.equal(result.behavior, "allow");
  assert.deepEqual(h.saved.map((r) => r.toolName), ["Write"]);
});

// --- the AskUserQuestion round-trip ------------------------------

const QUESTIONS = [
  {
    question: "Which breakpoint should desktop start at?",
    header: "Breakpoint",
    multiSelect: false,
    options: [
      { label: "lg (1280px+)", description: "Laptops stay mobile-style.", preview: "<b>lg</b>" },
      { label: "md (960px+)", description: "Tablets get the wide layout too." },
    ],
  },
];

test("normalizeQuestions keeps a well-formed question and defaults multiSelect", () => {
  const [q] = normalizeQuestions([{ question: "Pick one?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "bee" }] }]);
  assert.equal(q.question, "Pick one?");
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options, [
    { label: "A", description: "" },
    { label: "B", description: "bee" },
  ]);
});

test("normalizeQuestions drops anything the operator could not answer", () => {
  assert.deepEqual(normalizeQuestions("nonsense"), []);
  // No options at all, and an option with no label: both leave a card with
  // nothing to tap, which would park the session until its deadline.
  assert.deepEqual(normalizeQuestions([{ question: "Pick?", options: [] }]), []);
  assert.deepEqual(normalizeQuestions([{ question: "Pick?", options: [{ description: "no label" }] }]), []);
  assert.deepEqual(normalizeQuestions([{ header: "no question", options: [{ label: "A" }] }]), []);
});

test("normalizeQuestions carries preview content through", () => {
  const [q] = normalizeQuestions(QUESTIONS);
  assert.equal(q.options[0].preview, "<b>lg</b>");
  assert.equal(q.options[1].preview, undefined);
});

test("AskUserQuestion reaches the operator and returns their picks as updatedInput", async () => {
  const answers = { "Which breakpoint should desktop start at?": "lg (1280px+)" };
  const h = toolHarness({ questionAnswer: { answers } });
  const result = await h.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions());

  assert.deepEqual(result, {
    behavior: "allow",
    updatedInput: { questions: QUESTIONS, answers },
  });
  assert.deepEqual(h.emitted.map((e) => e.kind), ["question", "question_answer"]);
  assert.equal(h.emitted[0].payload.requestId, "req-1");
  assert.equal((h.emitted[0].payload.questions as unknown[]).length, 1);
  // Flushed before parking, or the card sits in the batcher while the session
  // waits for an answer to a question nobody has seen.
  assert.equal(h.flushes, 1);
  assert.deepEqual(h.emitted[1].payload.answers, answers);
});

test("AskUserQuestion carries annotations back when the operator added notes", async () => {
  const answers = { "Which breakpoint should desktop start at?": "lg (1280px+)" };
  const annotations = { "Which breakpoint should desktop start at?": { notes: "laptops stay narrow" } };
  const h = toolHarness({ questionAnswer: { answers, annotations } });
  const result = await h.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions());
  assert.deepEqual(result, { behavior: "allow", updatedInput: { questions: QUESTIONS, answers, annotations } });
});

test("an unanswered question allows the call rather than denying it", async () => {
  // Decided up front on a question the operator misses must never
  // strand a turn. The tool then reports "The user did not answer the
  // questions" and the agent carries on - today's behaviour, but after a real
  // wait instead of instantly.
  const h = toolHarness({ questionAnswer: null });
  const result = await h.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions());
  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(h.emitted.map((e) => e.kind), ["question", "question_answer"]);
  assert.equal(h.emitted[1].payload.answered, false);
});

test("a malformed AskUserQuestion call runs as-is instead of parking the session", async () => {
  const h = toolHarness({ questionAnswer: { answers: { a: "b" } } });
  const result = await h.canUseTool("AskUserQuestion", { questions: [] }, toolOptions());
  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(h.emitted, []);
});

test("a saved deny rule still beats the question path", async () => {
  const h = toolHarness({
    rules: [rule({ toolName: "AskUserQuestion", behavior: "deny" })],
    questionAnswer: { answers: { a: "b" } },
  });
  const result = await h.canUseTool("AskUserQuestion", { questions: QUESTIONS }, toolOptions());
  assert.equal(result.behavior, "deny");
  assert.deepEqual(h.emitted, []);
});

test("PendingAnswers keys waiters by request id like PendingDecisions does", async () => {
  const pending = new PendingAnswers();
  const first = pending.wait("req-1", { timeoutMs: 1000 });
  const second = pending.wait("req-2", { timeoutMs: 1000 });
  assert.equal(pending.resolve("req-2", { answers: { q: "second" } }), true);
  assert.deepEqual(await second, { answers: { q: "second" } });
  assert.equal(pending.resolve("req-3", { answers: {} }), false);
  pending.cancelAll();
  assert.equal(await first, null);
});

test("an oversized option preview is clipped rather than lost to pinboard's payload cap", () => {
  const [q] = normalizeQuestions([
    { question: "Pick?", options: [{ label: "A", preview: "x".repeat(MAX_PREVIEW_CHARS + 500) }, { label: "B" }] },
  ]);
  assert.equal(q.options[0].preview?.length, MAX_PREVIEW_CHARS);
});
