import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedByIds,
  parentRelation,
  parseAskArgs,
  parseAnswerArgs,
  parseAssumeArgs,
  parseFlags,
  parseHandoffArgs,
  parseUpdateArgs,
  positionals,
  repeatedFlag,
  resolveProject,
  runOrder,
  formatTaskLine,
  reasoningFlag,
  formatRework,
  parseSince,
  reasonComment,
} from "./work.js";
import type { Comment, Handoff, JournalEvent, Project, Task, TaskRelation } from "./pinboard.js";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    slug: "media",
    name: "Media",
    description: null,
    localPath: null,
    autoDeployAllowed: false,
    relatedProjectIds: [],
    ...overrides,
  };
}

test("resolveProject matches by slug", () => {
  const projects = [project({ id: 1, slug: "media" }), project({ id: 2, slug: "foreman" })];
  assert.equal(resolveProject(projects, "media").id, 1);
});

test("resolveProject matches by numeric id given as a string", () => {
  const projects = [project({ id: 1, slug: "media" }), project({ id: 2, slug: "foreman" })];
  assert.equal(resolveProject(projects, "2").slug, "foreman");
});

test("resolveProject throws a clear error for an unmatched slug or id", () => {
  const projects = [project({ id: 1, slug: "media" })];
  assert.throws(() => resolveProject(projects, "nope"), /no project matching 'nope'/);
});

// A multi-line --description is how a task gets filed with a real description
// (`--description="$(cat notes.md)"`). It used to fail parseFlags' own match,
// because a `.` in a JS regex never matches a newline, and then fell through
// to positionals() - which quietly appended the whole description to the new
// task's title.
test("parseFlags reads a value containing newlines", () => {
  const description = "## Scope\n- one thing\n- another\n";
  const flags = parseFlags(["--project=pinboard", `--description=${description}`, "Some", "title"]);
  assert.equal(flags.project, "pinboard");
  assert.equal(flags.description, description);
});

test("positionals leaves a multi-line flag out of the title", () => {
  const args = ["--project=pinboard", "--description=line one\nline two", "Some", "title"];
  assert.deepEqual(positionals(args), ["Some", "title"]);
});

test("positionals keeps quoted text that merely starts with dashes", () => {
  assert.deepEqual(positionals(["--flag=x", "--", "-- not a flag"]), ["--", "-- not a flag"]);
});

test("repeatedFlag collects every value of a repeatable flag", () => {
  const args = ["--label=a", "--project=x", "--label=b c", "--depends-on=4", "title"];
  assert.deepEqual(repeatedFlag(args, "label"), ["a", "b c"]);
  assert.deepEqual(repeatedFlag(args, "depends-on"), ["4"]);
  assert.deepEqual(repeatedFlag(args, "parent"), []);
});

test("parseUpdateArgs maps flags to PATCH fields", () => {
  const { id, fields, parent } = parseUpdateArgs(["12", "--title=New", "--type=story", "--executor=agent", "--priority=3", "--effort=5"]);
  assert.equal(id, 12);
  assert.deepEqual(fields, { title: "New", taskType: "story", executorMode: "agent", priority: 3, estimatedEffort: 5 });
  assert.equal(parent, undefined);
});

test("parseUpdateArgs handles --parent=<id> and --parent=none", () => {
  assert.equal(parseUpdateArgs(["12", "--parent=404"]).parent, 404);
  assert.equal(parseUpdateArgs(["12", "--parent=none"]).parent, null);
  assert.throws(() => parseUpdateArgs(["12", "--parent=abc"]), /--parent must be a task id/);
});

test("parseUpdateArgs rejects a missing id, bad numbers and an empty update", () => {
  assert.throws(() => parseUpdateArgs(["--title=x"]), /needs a task id/);
  assert.throws(() => parseUpdateArgs(["12", "--priority=high"]), /--priority must be a number/);
  assert.throws(() => parseUpdateArgs(["12"]), /nothing to change/);
});

function relation(overrides: Partial<TaskRelation>): TaskRelation {
  return { id: 1, fromTaskId: 1, toTaskId: 2, relationType: "related", direction: "from", otherTask: null, ...overrides };
}

test("parentRelation finds the parent from either side of the relation", () => {
  const child = relation({ id: 7, fromTaskId: 404, toTaskId: 407, relationType: "child", direction: "to" });
  assert.equal(parentRelation([relation({}), child])?.id, 7);
  const parent = relation({ id: 8, fromTaskId: 407, toTaskId: 404, relationType: "parent", direction: "from" });
  assert.equal(parentRelation([parent])?.id, 8);
  assert.equal(parentRelation([relation({ relationType: "child", direction: "from" })]), undefined);
});

test("blockedByIds only returns the task's own depends_on targets", () => {
  const rels = [
    relation({ fromTaskId: 5, toTaskId: 3, relationType: "depends_on", direction: "from" }),
    relation({ fromTaskId: 9, toTaskId: 5, relationType: "depends_on", direction: "to" }),
  ];
  assert.deepEqual(blockedByIds(rels), [3]);
});

test("runOrder puts dependencies first, then higher priority, then lower id", () => {
  const tasks = [
    { id: 1, priority: 1 },
    { id: 2, priority: 5 },
    { id: 3, priority: 5 },
    { id: 4, priority: 9 },
  ];
  // 4 depends on 1, so the high-priority 4 has to wait for low-priority 1.
  const order = runOrder(tasks, new Map([[4, [1]]]));
  assert.deepEqual(order.map((t) => t.id), [2, 3, 1, 4]);
});

test("runOrder ignores dependencies outside the set and survives a cycle", () => {
  const tasks = [
    { id: 1, priority: 1 },
    { id: 2, priority: 2 },
    { id: 3, priority: 3 },
  ];
  assert.deepEqual(runOrder(tasks, new Map([[3, [99]]])).map((t) => t.id), [3, 2, 1]);
  const cyclic = runOrder(tasks, new Map([[1, [2]], [2, [1]], [3, [1]]]));
  assert.deepEqual(cyclic.map((t) => t.id).sort(), [1, 2, 3]);
});

// structured asks and assumptions.
test("parseAskArgs: plain question has no options", () => {
  const parsed = parseAskArgs(["5", "Which", "db?"]);
  assert.equal(parsed.id, 5);
  assert.equal(parsed.question, "Which db?");
  assert.deepEqual(parsed.structure, { options: [] });
});

test("parseAskArgs: options, rationale, context and a 1-based recommended", () => {
  const parsed = parseAskArgs([
    "5",
    "Which db?",
    "--context=The service needs one",
    "--option=Postgres|matches the rest of the homelab",
    "--option=SQLite",
    "--recommended=1",
    "--wait-seconds=10",
  ]);
  assert.equal(parsed.question, "Which db?");
  assert.deepEqual(parsed.structure, {
    context: "The service needs one",
    options: [{ label: "Postgres", rationale: "matches the rest of the homelab" }, { label: "SQLite" }],
    recommended: 0,
  });
});

test("parseAskArgs rejects 1 or 5 options, a missing/out-of-range recommended, and recommended without options", () => {
  assert.throws(() => parseAskArgs(["5", "q", "--option=a", "--recommended=1"]), /2-4/);
  assert.throws(() => parseAskArgs(["5", "q", ...Array(5).fill("--option=a"), "--recommended=1"]), /2-4/);
  assert.throws(() => parseAskArgs(["5", "q", "--option=a", "--option=b"]), /--recommended/);
  assert.throws(() => parseAskArgs(["5", "q", "--option=a", "--option=b", "--recommended=3"]), /--recommended/);
  assert.throws(() => parseAskArgs(["5", "q", "--recommended=1"]), /--option/);
  assert.throws(() => parseAskArgs(["5", "q", "--option=|why", "--option=b", "--recommended=1"]), /label/);
  assert.throws(() => parseAskArgs(["x", "q"]), /task id/);
});

test("parseAssumeArgs needs a decision and --why", () => {
  assert.deepEqual(parseAssumeArgs(["7", "Use", "SQLite", "--why=single user, no server"]), {
    id: 7,
    decision: "Use SQLite",
    why: "single user, no server",
  });
  assert.throws(() => parseAssumeArgs(["7", "Use SQLite"]), /--why/);
  assert.throws(() => parseAssumeArgs(["7", "Use SQLite", "--why"]), /--why/);
  assert.throws(() => parseAssumeArgs(["7", "--why=x"]), /decision/);
});

test("parseAnswerArgs reads a 1-based option, extra text, or free text", () => {
  assert.deepEqual(parseAnswerArgs(["12", "2"]), { askId: 12, option: 1 });
  assert.deepEqual(parseAnswerArgs(["12", "1", "but", "keep", "it", "small"]), { askId: 12, option: 0, text: "but keep it small" });
  assert.deepEqual(parseAnswerArgs(["12", "Use", "port", "8095"]), { askId: 12, text: "Use port 8095" });
  assert.throws(() => parseAnswerArgs(["12"]), /option number or text/);
  assert.throws(() => parseAnswerArgs(["x", "1"]), /ask id/);
  assert.throws(() => parseAnswerArgs(["12", "0"]), /start at 1/);
});

test("parseHandoffArgs: repeated --checklist builds the array", () => {
  const { id, input } = parseHandoffArgs(["7", "--summary=Done.", "--checklist=Play a round", "--checklist=Menu looks right"]);
  assert.equal(id, 7);
  assert.equal(input.summary, "Done.");
  assert.deepEqual(input.checklist, ["Play a round", "Menu looks right"]);
});

test("parseHandoffArgs: no --checklist leaves it out", () => {
  const { id, input } = parseHandoffArgs(["7", "--completed=All of it", "--effort=3"]);
  assert.equal(id, 7);
  assert.equal(input.checklist, undefined);
  assert.equal(input.completed, "All of it");
  assert.equal(input.estimatedNextEffort, 3);
});

test("--reasoning takes medium, high or none (none clears), and rejects anything else", () => {
  assert.equal(reasoningFlag(parseFlags([])), undefined);
  assert.equal(reasoningFlag(parseFlags(["--reasoning=high"])), "high");
  assert.equal(reasoningFlag(parseFlags(["--reasoning=medium"])), "medium");
  assert.equal(reasoningFlag(parseFlags(["--reasoning=none"])), null);
  assert.throws(() => reasoningFlag(parseFlags(["--reasoning=max"])), /--reasoning must be medium, high or none/);
});

test("task update --reasoning sets or clears the reasoning effort and leaves --effort as story points", () => {
  assert.deepEqual(parseUpdateArgs(["5", "--reasoning=high", "--effort=3"]).fields, { estimatedEffort: 3, reasoningEffort: "high" });
  assert.deepEqual(parseUpdateArgs(["5", "--reasoning=none"]).fields, { reasoningEffort: null });
});

test("the task line shows reasoning only when the task sets it", () => {
  const task = { id: 9, status: "queued", priority: 2, taskType: "feature", executorMode: "agent", estimatedEffort: 3, title: "T" } as Task;
  assert.equal(formatTaskLine(task), "#9  [queued] p2 feature/agent effort:3  T");
  assert.equal(formatTaskLine({ ...task, reasoningEffort: "high" }), "#9  [queued] p2 feature/agent effort:3 reasoning:high  T");
});

const reworkEvent: JournalEvent = {
  id: 9,
  taskId: 42,
  projectId: 1,
  eventType: "pipeline",
  actorType: "agent",
  actorName: "foreman-pipeline",
  payload: { from: "awaiting_ci", to: "rework", repairReason: "ci_failed" },
  createdAt: "2026-11-05T10:00:00.000Z",
  taskTitle: "Fix the thing",
  projectSlug: "media",
};

function comment(createdAt: string, body: string): Comment {
  return { id: 1, taskId: 42, authorType: "agent", authorName: "foreman-runner", body, createdAt };
}

function handoff(createdAt: string, fields: Partial<Handoff>): Handoff {
  return {
    id: 1, taskId: 42, agentId: null, completed: null, changed: null, verified: null, problems: null,
    discovered: null, next: null, estimatedNextEffort: null, costUsd: null, durationMs: null, numTurns: null,
    permissionDenials: null, createdAt, ...fields,
  };
}

test("parseSince reads <N>d back from now and ISO dates, default 7 days", () => {
  const now = new Date("2026-11-08T07:00:00Z");
  assert.equal(parseSince(undefined, now).toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(parseSince("1d", now).toISOString(), "2026-11-07T07:00:00.000Z");
  assert.equal(parseSince("2026-11-02", now).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.throws(() => parseSince("last week", now), /--since must be/);
});

test("reasonComment picks the last comment just before the move, not a later rework note", () => {
  const comments = [
    comment("2026-11-05T09:00:00.000Z", "too early"),
    comment("2026-11-05T09:59:58.000Z", "CI failed: lint"),
    comment("2026-11-05T12:00:00.000Z", "operator: try again with X"),
  ];
  assert.equal(reasonComment(reworkEvent, comments)?.body, "CI failed: lint");
  assert.equal(reasonComment(reworkEvent, [comments[0]]), undefined);
});

test("formatRework prints the move, its reason, the handoff before it and the latest one", () => {
  const text = formatRework(
    reworkEvent,
    { id: 42, status: "done" } as Task,
    [comment("2026-11-05T09:59:58.000Z", "CI failed:\n lint")],
    [
      handoff("2026-11-06T10:00:00.000Z", { completed: "fixed lint, added a rule" }),
      handoff("2026-11-05T09:50:00.000Z", { problems: "eslint not installed" }),
    ],
  );
  assert.equal(
    text,
    [
      "2026-11-05T10:00:00.000Z #42 [media] Fix the thing",
      "  awaiting_ci -> rework by agent:foreman-pipeline, now done",
      "  reason: ci_failed",
      "  comment (foreman-runner): CI failed: lint",
      "  problems (handoff before): eslint not installed",
      "  latest handoff, completed: fixed lint, added a rule",
    ].join("\n"),
  );
});
