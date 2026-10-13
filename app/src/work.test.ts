import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedByIds,
  parentRelation,
  parseAskArgs,
  parseAnswerArgs,
  parseAssumeArgs,
  parseFlags,
  parseUpdateArgs,
  positionals,
  repeatedFlag,
  resolveProject,
  runOrder,
} from "./work.js";
import type { Project, TaskRelation } from "./pinboard.js";

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
