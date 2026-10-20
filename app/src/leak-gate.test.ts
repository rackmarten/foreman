import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addedLines,
  buildScanInput,
  formatLeakComment,
  leakGateForPush,
  mapLeakOutput,
  parseLeakAllow,
  type LeakGateOptions,
} from "./leak-gate.js";

const DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -3,0 +4,2 @@",
  "+Fixes ticket #12.",
  "+plain line",
  "diff --git a/docs/allowed.md b/docs/allowed.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/allowed.md",
  "@@ -0,0 +1 @@",
  "+mentions private.example on purpose",
  "",
].join("\n");

test("addedLines keeps each + line with its new-file line number", () => {
  assert.deepEqual(addedLines(DIFF), [
    { file: "README.md", line: 4, text: "Fixes ticket #12." },
    { file: "README.md", line: 5, text: "plain line" },
    { file: "docs/allowed.md", line: 1, text: "mentions private.example on purpose" },
  ]);
});

test("mapLeakOutput maps stdin lines back to files and PR text, honouring .leak-allow", () => {
  const { text, locations } = buildScanInput(addedLines(DIFF), "Title", "body one\nbody two");
  assert.equal(text.split("\n").length - 1, 6);
  const allow = parseLeakAllow("# comment\ndocs/*.md:P03\n");
  const hits = mapLeakOutput("P01 stdin:1\nP03 stdin:3\nP04 stdin:6\nP02 commit 0123456789abcdef0123\n", locations, allow);
  assert.deepEqual(hits, [
    { id: "P01", location: "README.md:4" },
    { id: "P04", location: "PR body line 2" },
    { id: "P02", location: "commit message 0123456789ab" },
  ]);
});

function gateFixture(status: number, stdout: string) {
  const dir = mkdtempSync(join(tmpdir(), "foreman-leak-"));
  const script = join(dir, "leak-check.sh");
  const patterns = join(dir, "patterns.txt");
  writeFileSync(script, "");
  writeFileSync(patterns, "");
  const calls: Array<{ args: string[]; input: string }> = [];
  const opts: LeakGateOptions = {
    script,
    patterns,
    git: () => DIFF,
    exec: (args, _cwd, input) => {
      calls.push({ args, input });
      return { status, stdout, stderr: "" };
    },
  };
  return { dir, opts, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a leak hit blocks a public push, and the comment carries ids and locations, not text", () => {
  const f = gateFixture(1, "P01 stdin:1\nP01 stdin:4\n");
  try {
    const gated = leakGateForPush(f.dir, "main", true, "Fix ticket #12", "Summary", f.opts);
    assert.ok(gated.blocked);
    assert.deepEqual(gated.hits, [
      { id: "P01", location: "README.md:4" },
      { id: "P01", location: "PR title" },
    ]);
    assert.deepEqual(f.calls[0].args.slice(1), ["--patterns", f.opts.patterns, "--log", "origin/main..HEAD", "--stdin"]);
    assert.match(f.calls[0].input, /^Fixes ticket #12\.\nplain line\n/);
    const comment = formatLeakComment("pinboard", gated, "/ws/patterns.txt");
    assert.match(comment, /^Not pushed: `pinboard` is a public repository/);
    assert.match(comment, /- P01 README\.md:4\n- P01 PR title/);
    assert.match(comment, /\/ws\/patterns\.txt/);
    assert.doesNotMatch(comment, /Fixes ticket #12/);
  } finally {
    f.cleanup();
  }
});

test("exit 3 (no patterns) blocks a public push and is ignored for a private one", () => {
  const f = gateFixture(3, "");
  try {
    const pub = leakGateForPush(f.dir, "main", true, "t", "b", f.opts);
    assert.ok(pub.blocked);
    assert.match(pub.reason, /no patterns/);
    assert.deepEqual(leakGateForPush(f.dir, "main", false, "t", "b", f.opts), { blocked: false });
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a clean run, or hits that are all allowlisted, lets the push through", () => {
  const clean = gateFixture(0, "");
  const allowed = gateFixture(1, "P03 stdin:3\n");
  try {
    assert.deepEqual(leakGateForPush(clean.dir, "main", true, "t", "b", clean.opts), { blocked: false });
    writeFileSync(join(allowed.dir, ".leak-allow"), "docs/allowed.md:P03\n");
    assert.deepEqual(leakGateForPush(allowed.dir, "main", true, "t", "b", allowed.opts), { blocked: false });
  } finally {
    clean.cleanup();
    allowed.cleanup();
  }
});

test("exit 1 with no hit lines is a script failure and blocks", () => {
  const f = gateFixture(1, "");
  try {
    const result = leakGateForPush(f.dir, "main", true, "t", "b", f.opts);
    assert.ok(result.blocked);
    assert.match(result.reason, /leak-check failed \(exit 1\)/);
  } finally {
    f.cleanup();
  }
});

test("buildScanInput puts the branch name first when one is given", () => {
  const { text, locations } = buildScanInput([], "t", "b", "fix-ci");
  assert.equal(text, "fix-ci\nt\nb\n");
  assert.deepEqual(locations[0], { file: null, label: "branch name" });
  assert.equal(buildScanInput([], "t", "b").locations[0].label, "PR title");
});

test("a branch name with a task id blocks a public push and passes a private one", () => {
  // stdin line 1 is the branch name when one is passed
  const f = gateFixture(1, "P26 stdin:1\n");
  try {
    const opts = { ...f.opts, branchName: "task-832" };
    const gated = leakGateForPush(f.dir, "main", true, "Add: launcher", "Summary", opts);
    assert.ok(gated.blocked);
    assert.deepEqual(gated.hits, [{ id: "P26", location: "branch name" }]);
    assert.match(f.calls[0].input, /^task-832\nFixes ticket #12\./);
    assert.deepEqual(leakGateForPush(f.dir, "main", false, "Add: launcher", "Summary", opts), { blocked: false });
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a .leak-allow entry never covers the branch name", () => {
  const f = gateFixture(1, "P26 stdin:1\n");
  try {
    writeFileSync(join(f.dir, ".leak-allow"), "*:P26\n");
    const gated = leakGateForPush(f.dir, "main", true, "t", "b", { ...f.opts, branchName: "task-832" });
    assert.ok(gated.blocked);
  } finally {
    f.cleanup();
  }
});
