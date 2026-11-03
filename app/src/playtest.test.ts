import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeOrder, nextBranchName, runPlaytest, type PlaytestDeps, type PlaytestEntry } from "./playtest.js";
import type { Handoff, Project, PullRequest, Task } from "./pinboard.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: ENV }).toString().trim();
}

function commitFile(cwd: string, file: string, content: string, msg: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
}

// bare origin plus a clone, with branches for: two independent PRs (10, 11),
// a two-level stack (20 <- 21) and one that conflicts with 10 (30)
function fixture(): { root: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "playtest-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "pipe" });
  git(seed, "checkout", "-q", "-b", "main");
  commitFile(seed, "shared.txt", "base\n", "base");
  git(seed, "push", "-q", "origin", "main");
  const branch = (name: string, from: string, file: string, content: string) => {
    git(seed, "checkout", "-q", "-b", name, from);
    commitFile(seed, file, content, name);
    git(seed, "push", "-q", "origin", name);
  };
  branch("feat-a", "main", "a.txt", "a\n");
  branch("feat-b", "main", "b.txt", "b\n");
  branch("stack-parent", "main", "p.txt", "p\n");
  branch("stack-child", "stack-parent", "c.txt", "c\n");
  branch("feat-a-conflict", "main", "a.txt", "other\n");
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "pipe" });
  return { root, clone };
}

const project = { id: 1, slug: "game", localPath: "org/game" } as Project;

// like pinboard's task list, which carries no stackOn: only GET /tasks/:id
// computes it, so the parent comes from the PR row's stackedOnTaskId.
function task(id: number): Task {
  return { id, title: `title ${id}`, status: "review" } as unknown as Task;
}

function deps(): PlaytestDeps {
  const branches: Record<number, string> = {
    10: "feat-a",
    11: "feat-b",
    20: "stack-parent",
    21: "stack-child",
    30: "feat-a-conflict",
  };
  const stackedOn: Record<number, number> = { 21: 20 };
  return {
    listTasks: async () => [task(30), task(21), task(11), task(10), task(20), task(40)],
    listPullRequests: async (taskId) =>
      branches[taskId]
        ? [
            {
              id: taskId,
              taskId,
              url: `https://example.invalid/pr/${taskId}`,
              repoSlug: "game",
              branchName: branches[taskId],
              state: "open",
              stackedOnTaskId: stackedOn[taskId] ?? null,
            } as PullRequest,
          ]
        : [],
    getTaskHandoffs: async (taskId) =>
      taskId === 10
        ? ([
            { createdAt: "2026-11-02T00:00:00Z", checklist: ["newest check"] },
            { createdAt: "2026-11-01T00:00:00Z", checklist: ["old check"] },
          ] as Handoff[])
        : [],
  };
}

test("mergeOrder merges stack leaves first, then independent PRs", () => {
  const e = (taskId: number, parentTaskId: number | null = null) => ({ taskId, parentTaskId }) as PlaytestEntry;
  const order = mergeOrder([e(5), e(3), e(7, 2), e(2), e(8, 7), e(1)]).map((x) => x.taskId);
  assert.deepEqual(order, [8, 1, 3, 5]);
});

test("nextBranchName takes the next free number for the day", () => {
  const now = new Date(2026, 10, 3);
  assert.equal(nextBranchName([], now), "playtest/20261103-1");
  assert.equal(nextBranchName(["playtest/20261103-1", "playtest/20261103-2"], now), "playtest/20261103-3");
});

test("runPlaytest merges independent PRs and a stack, and skips a conflict", async () => {
  const { root, clone } = fixture();
  Object.assign(process.env, ENV);
  try {
    const lines: string[] = [];
    const result = await runPlaytest(project, deps(), { cwd: clone, now: new Date(2026, 10, 3), log: (l) => lines.push(l) });
    assert.equal(result.branch, "playtest/20261103-1");
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "playtest/20261103-1");
    assert.deepEqual(result.merged, ["stack-child", "feat-a", "feat-b"]);
    assert.deepEqual(result.included.map((e) => e.taskId).sort(), [10, 11, 20, 21]);
    assert.deepEqual(
      result.skipped.map((s) => [s.taskId, s.reason.split(" ")[0]]),
      [[40, "no"], [30, "merge"]],
    );
    assert.equal(git(clone, "status", "--porcelain"), "");
    for (const f of ["a.txt", "b.txt", "p.txt", "c.txt"]) git(clone, "cat-file", "-e", `HEAD:${f}`);
    // every merge is a real merge commit
    assert.equal(git(clone, "rev-list", "--merges", "--count", "origin/main..HEAD"), "3");
    const out = lines.join("\n");
    assert.match(out, /#10 title 10\n\s+https:\/\/example.invalid\/pr\/10\n\s+\[ \] newest check/);
    assert.doesNotMatch(out, /old check/);
    assert.match(out, /#30 title 30: merge conflict/);

    // a second run the same day takes the next number
    git(clone, "checkout", "-q", "main");
    const again = await runPlaytest(project, deps(), { cwd: clone, now: new Date(2026, 10, 3), log: () => {} });
    assert.equal(again.branch, "playtest/20261103-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlaytest refuses a dirty worktree", async () => {
  const { root, clone } = fixture();
  try {
    writeFileSync(join(clone, "shared.txt"), "edited\n");
    await assert.rejects(runPlaytest(project, deps(), { cwd: clone, log: () => {} }), /uncommitted changes/);
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlaytest --dry-run prints the plan and leaves git untouched", async () => {
  const { root, clone } = fixture();
  try {
    const before = git(clone, "for-each-ref");
    const lines: string[] = [];
    const result = await runPlaytest(project, deps(), { cwd: clone, dryRun: true, log: (l) => lines.push(l) });
    assert.equal(git(clone, "for-each-ref"), before);
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.deepEqual(result.merged, []);
    assert.match(lines.join("\n"), /stack-child\s+\(#21, includes #20\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
