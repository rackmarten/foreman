import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PullRequest } from "./pinboard.js";
import { checkMergeBase } from "./pipeline.js";
import { planRestacks, restackOpenPrs, type RestackDeps } from "./restack.js";

// A bare remote with main, plus a working clone ("dev") standing in for
// GitHub and whoever pushes to it.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foreman-restack-test-"));
  const remote = join(root, "remote.git");
  const dev = join(root, "dev");
  const git = (args: string[], cwd = dev): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  mkdirSync(remote);
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(dev);
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["remote", "add", "origin", remote]);
  const commit = (file: string, content: string, message = file): string => {
    writeFileSync(join(dev, file), content);
    git(["add", "."]);
    git(["commit", "-qm", message]);
    return git(["rev-parse", "HEAD"]);
  };
  // a branch off `from` with one commit, pushed
  const branch = (name: string, from: string, file: string, content = `${name}\n`): string => {
    git(["checkout", "-q", "-B", name, from]);
    const sha = commit(file, content);
    git(["push", "-q", "-f", "origin", name]);
    return sha;
  };
  const pushTo = (name: string, file: string, content: string): string => {
    git(["fetch", "-q", "origin"]);
    git(["checkout", "-q", "-B", name, `origin/${name}`]);
    const sha = commit(file, content);
    git(["push", "-q", "origin", name]);
    return sha;
  };
  // gh pr merge --squash --delete-branch
  const squashMerge = (name: string): string => {
    git(["fetch", "-q", "origin"]);
    git(["checkout", "-q", "-B", "main", "origin/main"]);
    git(["merge", "-q", "--squash", `origin/${name}`]);
    git(["commit", "-qm", `squash ${name}`]);
    git(["push", "-q", "origin", "main"]);
    git(["push", "-q", "origin", "--delete", name]);
    return git(["rev-parse", "HEAD"]);
  };
  const remoteSha = (name: string): string => git(["rev-parse", name], remote);
  commit("README.md", "# repo\n");
  git(["push", "-q", "-u", "origin", "main"]);
  return { root, remote, git, branch, pushTo, squashMerge, remoteSha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Fixture = ReturnType<typeof fixture>;

function prRow(id: number, taskId: number, branchName: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    id,
    taskId,
    url: `https://github.com/o/repo/pull/${id}`,
    repoSlug: "repo",
    branchName,
    state: "open",
    attemptNumber: 1,
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

// pinboard and gh, in memory; git is real.
function fakeDeps(f: Fixture, rows: PullRequest[], statuses: Record<number, string> = {}) {
  const calls = { retargets: [] as string[], comments: [] as { taskId: number; body: string }[], rework: [] as number[] };
  const bases = new Map(rows.map((r) => [r.url, r.baseBranch ?? "main"]));
  let n = 0;
  const deps: RestackDeps = {
    listOpen: async () => rows.filter((r) => r.state === "open"),
    listForTask: async (taskId) => rows.filter((r) => r.taskId === taskId),
    taskStatus: async (taskId) => statuses[taskId] ?? "review",
    defaultBranch: () => "main",
    prBase: (url) => bases.get(url) ?? null,
    retarget: (url, base) => {
      calls.retargets.push(`${url} -> ${base}`);
      bases.set(url, base);
      return true;
    },
    cloneFor: async () => {
      const path = join(f.root, `clone-${n++}`);
      execFileSync("git", ["clone", "-q", f.remote, path], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
      execFileSync("git", ["config", "user.name", "test"], { cwd: path });
      return { path, own: false, done: () => rmSync(path, { recursive: true, force: true }) };
    },
    recordStack: async (pr, baseBranch, sha) => {
      const row = rows.find((r) => r.id === pr.id) as PullRequest;
      row.baseBranch = baseBranch;
      row.stackedOnSha = sha;
    },
    comment: async (taskId, body) => calls.comments.push({ taskId, body }),
    toRework: async (taskId) => calls.rework.push(taskId),
  };
  return { deps, calls };
}

const changed = (f: Fixture, from: string, to: string): string[] =>
  f.git(["diff", "--name-only", from, to], f.remote).split("\n").filter(Boolean);
const commitsBetween = (f: Fixture, from: string, to: string): number => Number(f.git(["rev-list", "--count", `${from}..${to}`], f.remote));

test("a child of a squash-merged parent is retargeted and rebased so its diff against main is only its own", async () => {
  const f = fixture();
  try {
    const aTip = f.branch("a", "main", "a.txt");
    f.branch("b", "a", "b.txt");
    const mainTip = f.squashMerge("a");
    const rows = [prRow(1, 10, "a", { state: "merged", baseBranch: "main" }), prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: aTip })];
    const { deps, calls } = fakeDeps(f, rows);

    const outcomes = await restackOpenPrs(deps);

    assert.deepEqual(outcomes.map((o) => o.result), ["restacked"]);
    assert.deepEqual(calls.retargets, [`${rows[1].url} -> main`]);
    assert.deepEqual(changed(f, "main", "b"), ["b.txt"]);
    assert.equal(commitsBetween(f, "main", "b"), 1);
    assert.equal(f.git(["merge-base", "main", "b"], f.remote), mainTip);
    assert.equal(rows[1].baseBranch, "main");
    assert.equal(rows[1].stackedOnSha, mainTip);
    // the row is an ordinary PR now: a second pass leaves it alone
    assert.deepEqual(await restackOpenPrs(deps), []);
  } finally {
    f.cleanup();
  }
});

test("a parent's new commit is restacked into the child and recorded", async () => {
  const f = fixture();
  try {
    const aTip = f.branch("a", "main", "a.txt");
    f.branch("b", "a", "b.txt");
    const aNew = f.pushTo("a", "a2.txt", "more\n");
    const rows = [prRow(1, 10, "a", { baseBranch: "main" }), prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: aTip })];
    const { deps, calls } = fakeDeps(f, rows);

    const outcomes = await restackOpenPrs(deps);

    assert.deepEqual(outcomes.map((o) => o.result), ["restacked"]);
    assert.deepEqual(calls.retargets, []);
    assert.equal(f.git(["merge-base", "a", "b"], f.remote), aNew);
    assert.deepEqual(changed(f, "a", "b"), ["b.txt"]);
    assert.ok(changed(f, "main", "b").includes("a2.txt"));
    assert.equal(rows[1].stackedOnSha, aNew);
    // nothing moved since: no second push
    const bTip = f.remoteSha("b");
    assert.deepEqual((await restackOpenPrs(deps)).map((o) => o.result), ["current"]);
    assert.equal(f.remoteSha("b"), bTip);
  } finally {
    f.cleanup();
  }
});

test("a conflicting restack leaves the remote untouched and moves the child to rework naming the parent commit", async () => {
  const f = fixture();
  try {
    const aTip = f.branch("a", "main", "a.txt");
    f.branch("b", "a", "shared.txt", "child's version\n");
    const aNew = f.pushTo("a", "shared.txt", "parent's version\n");
    const before = f.remoteSha("b");
    const rows = [prRow(1, 10, "a", { baseBranch: "main" }), prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: aTip })];
    const { deps, calls } = fakeDeps(f, rows);

    const outcomes = await restackOpenPrs(deps);

    assert.deepEqual(outcomes.map((o) => o.result), ["conflict"]);
    assert.equal(f.remoteSha("b"), before);
    assert.deepEqual(calls.rework, [20]);
    assert.equal(calls.comments.length, 1);
    assert.equal(calls.comments[0].taskId, 20);
    assert.match(calls.comments[0].body, new RegExp(aNew));
    assert.equal(rows[1].stackedOnSha, aTip, "the record keeps the old base");
  } finally {
    f.cleanup();
  }
});

test("a three-level chain restacks parents before children", async () => {
  const f = fixture();
  try {
    const aTip = f.branch("a", "main", "a.txt");
    const bTip = f.branch("b", "a", "b.txt");
    f.branch("c", "b", "c.txt");
    const aNew = f.pushTo("a", "a2.txt", "more\n");
    // listed child-first, so the order has to come from the plan
    const rows = [
      prRow(3, 30, "c", { baseBranch: "b", stackedOnTaskId: 20, stackedOnSha: bTip }),
      prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: aTip }),
      prRow(1, 10, "a", { baseBranch: "main" }),
    ];
    const { deps } = fakeDeps(f, rows);

    const outcomes = await restackOpenPrs(deps);

    assert.deepEqual(outcomes.map((o) => [o.prUrl.slice(-1), o.result]), [["2", "restacked"], ["3", "restacked"]]);
    assert.equal(f.git(["merge-base", "a", "b"], f.remote), aNew);
    assert.equal(f.git(["merge-base", "b", "c"], f.remote), f.remoteSha("b"));
    assert.deepEqual(changed(f, "b", "c"), ["c.txt"]);
    assert.ok(changed(f, "main", "c").includes("a2.txt"));
    assert.equal(rows[0].stackedOnSha, f.remoteSha("b"));
    assert.equal(rows[1].stackedOnSha, aNew);
  } finally {
    f.cleanup();
  }
});

test("a child whose recorded parent commit was rewritten goes to rework rather than failing every pass", async () => {
  const f = fixture();
  try {
    f.branch("a", "main", "a.txt");
    f.branch("b", "a", "b.txt");
    f.pushTo("a", "a2.txt", "more\n");
    const before = f.remoteSha("b");
    const rows = [prRow(1, 10, "a"), prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: "0".repeat(40) })];
    const { deps, calls } = fakeDeps(f, rows);
    assert.deepEqual((await restackOpenPrs(deps)).map((o) => o.result), ["conflict"]);
    assert.equal(f.remoteSha("b"), before);
    assert.deepEqual(calls.rework, [20]);
  } finally {
    f.cleanup();
  }
});

test("a child whose task is running or in rework is not restacked", async () => {
  const f = fixture();
  try {
    const aTip = f.branch("a", "main", "a.txt");
    f.branch("b", "a", "b.txt");
    f.pushTo("a", "a2.txt", "more\n");
    const before = f.remoteSha("b");
    const rows = [prRow(1, 10, "a"), prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: aTip })];
    for (const status of ["executing", "rework"]) {
      const { deps } = fakeDeps(f, rows, { 20: status });
      assert.deepEqual((await restackOpenPrs(deps)).map((o) => o.result), ["skipped"]);
      assert.equal(f.remoteSha("b"), before);
    }
  } finally {
    f.cleanup();
  }
});

test("planRestacks skips unstacked rows, closed parents and rows already moved off the parent", () => {
  const parent = prRow(1, 10, "a");
  const rows = [
    prRow(2, 20, "b", { baseBranch: "a", stackedOnTaskId: 10, stackedOnSha: "x" }),
    prRow(3, 30, "c", { baseBranch: "main", stackedOnTaskId: 10, stackedOnSha: "x" }),
    prRow(4, 40, "d"),
  ];
  assert.deepEqual(planRestacks(rows, () => [parent]).map((p) => p.pr.id), [2]);
  assert.deepEqual(planRestacks(rows, () => [{ ...parent, state: "closed" }]), []);
  assert.equal(planRestacks(rows, () => [{ ...parent, state: "merged" }])[0].merged, true);
});

test("checkMergeBase never lets a PR with a non-default base through to the merge", () => {
  const calls: string[][] = [];
  const exec = (base: string | null) => (cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "view" && args[0] === "pr") return base === null ? { ok: false, stdout: "", stderr: "boom" } : { ok: true, stdout: `${base}\n`, stderr: "" };
    return { ok: true, stdout: "main\n", stderr: "" };
  };
  const url = "https://github.com/o/repo/pull/2";
  const stacked = checkMergeBase(url, "o", "repo", exec("a"));
  assert.equal(stacked?.moved, "rework");
  assert.match(stacked?.comment ?? "", /targets `a`/);
  assert.equal(checkMergeBase(url, "o", "repo", exec("main")), null);
  assert.equal(checkMergeBase(url, "o", "repo", exec(null))?.moved, null);
  // GitHub already retargeted it, but pinboard says the restack never landed
  assert.equal(checkMergeBase(url, "o", "repo", exec("main"), "a")?.moved, "rework");
  assert.equal(checkMergeBase(url, "o", "repo", exec("main"), "main"), null);
  assert.ok(!calls.some((args) => args.includes("merge")), "the guard itself never merges");
});
