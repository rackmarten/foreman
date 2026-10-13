import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { withRetry } from "./pipeline.js";
import {
  PR_PINBOARD_RETRY,
  GH_PR_CREATE_RETRY_DELAYS_MS,
  createPrWithRetry,
  isTransientGhError,
  advanceTimeoutTracker,
  askHistoryLines,
  autonomyPolicy,
  formatPrBody,
  formatPrTitle,
  publicRepoRulesLines,
  handoffSummaryPolicy,
  dockerPolicy,
  DEFAULT_RUN_OPTIONS,
  computeSleepMs,
  decideNoCommitOutcome,
  formatNeedsInputComment,
  dispatchOnce,
  earliestWait,
  ensureWorkspaceTrusted,
  formatHandoffComment,
  handleClaimRefusal,
  hasTimedOut,
  isSessionResumableBy,
  prepareAttempt,
  pushForceArgs,
  pushNeedsForce,
  pushTaskBranch,
  findExistingPr,
  remoteBranchSha,
  relatedRepoLines,
  relatedTargetsAfterSession,
  cloneRelatedRepoMidRun,
  recordWorkspaceRoot,
  repairPromptLines,
  dispatchCapacity,
  summarizeStreamLine,
  validateRunOptions,
  type TimeoutTrackerState,
} from "./runner.js";
import { ensureTaskClone, repoWorkdir, taskBranch, TASK_ROOT } from "./workdir.js";
import type { Project, Task } from "./pinboard.js";

function task(priority = 0): Task {
  return { priority } as Task;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    slug: "self",
    name: "Self",
    description: null,
    localPath: "my-org/self",
    autoDeployAllowed: false,
    relatedProjectIds: [],
    ...overrides,
  };
}

const WORKSPACE_ROOT = join(homedir(), "projects");
function projectAt(repoPath: string, overrides: Partial<Project> = {}): Project {
  return project({ localPath: relative(WORKSPACE_ROOT, repoPath), ...overrides });
}

test("relatedRepoLines with no related projects only explains add-related-repo", () => {
  const t = { ...task(), id: 1, relatedProjectIds: [] } as Task;
  const lines = relatedRepoLines(t, project(), [project()]);
  assert.ok(lines.some((l) => l.includes("work task add-related-repo 1")));
  assert.ok(lines.every((l) => !l.includes("commit it on its own branch")));
});

test("relatedRepoLines lists the union of the project's and task's related projects, excluding self", () => {
  const self = project({ id: 1, relatedProjectIds: [2] });
  const other = project({ id: 2, slug: "foreman", localPath: "my-org/foreman" });
  const t = { ...task(), id: 5, relatedProjectIds: [1, 3] } as Task;
  const missing = project({ id: 3, slug: "gone", localPath: null });
  const lines = relatedRepoLines(t, self, [self, other, missing]);
  // the path handed to the agent is that repo's clone inside this
  // task's own workdir, not the workspace checkout it was cloned from.
  assert.ok(lines.some((l) => l.includes(repoWorkdir(5, "foreman"))));
  assert.ok(lines.every((l) => !l.includes(repoWorkdir(5, "self"))));
  assert.ok(lines.every((l) => !l.includes("gone")));
  assert.ok(lines.some((l) => l.includes("work task add-related-repo 5")));
});

// what dispatchOnce still decides for itself, now that pinboard
// picks the tasks - which of the offered ones to actually start, and how long
// to wait before asking again.

test("dispatchCapacity offers the full limit when nothing is in flight", () => {
  assert.equal(dispatchCapacity(2, 2, 0, 0), 2);
});

test("dispatchCapacity counts in-flight tasks against the limit", () => {
  assert.equal(dispatchCapacity(2, 2, 1, 1), 1);
});

test("dispatchCapacity offers nothing when the limit is already full", () => {
  assert.equal(dispatchCapacity(1, 1, 1, 1), 0);
});

test("dispatchCapacity never goes negative", () => {
  assert.equal(dispatchCapacity(1, 1, 3, 0), 0);
});


test("computeSleepMs uses the normal interval when the plan gave no wait", () => {
  assert.equal(computeSleepMs(null, 60), 60_000);
});

test("computeSleepMs waits for the session window reset when one is pending", () => {
  const now = Date.now();
  const resetsIn3Min = new Date(now + 3 * 60_000).toISOString();
  assert.equal(computeSleepMs(resetsIn3Min, 60, now), 3 * 60_000);
});

test("computeSleepMs re-checks every 5 minutes during a long wait, so a manual reset is noticed", () => {
  const now = Date.now();
  const resetsIn2h = new Date(now + 2 * 60 * 60_000).toISOString();
  assert.equal(computeSleepMs(resetsIn2h, 60, now), 5 * 60_000);
});

test("computeSleepMs never sleeps less than the normal interval", () => {
  const now = Date.now();
  const resetsIn5s = new Date(now + 5_000).toISOString();
  assert.equal(computeSleepMs(resetsIn5s, 60, now), 60_000);
});

test("computeSleepMs ignores a wait already in the past", () => {
  const now = Date.now();
  assert.equal(computeSleepMs(new Date(now - 60_000).toISOString(), 60, now), 60_000);
});

test("computeSleepMs caps a bad timestamp at the re-check interval", () => {
  const now = Date.now();
  const wayOff = new Date(now + 40 * 24 * 60 * 60_000).toISOString();
  assert.equal(computeSleepMs(wayOff, 60, now), 5 * 60_000);
  assert.equal(computeSleepMs("not-a-date", 60, now), 60_000);
});

// the checkGovernor and rankRunnableTasks/pickNextRunnableTask
// tests that used to sit here went with the code they covered - the queue's
// ordering/eligibility rules and the budget gate are pinboard's now, and are
// tested in its own plan.test.ts. Keeping a copy here would have meant
// asserting foreman's behaviour against rules foreman no longer implements.

// I9: the hard timeout is measured in active (non-paused) time.
test("advanceTimeoutTracker accumulates elapsed time while not paused", () => {
  let state: TimeoutTrackerState = { activeElapsedMs: 0 };
  state = advanceTimeoutTracker(state, 5_000, false);
  state = advanceTimeoutTracker(state, 5_000, false);
  assert.equal(state.activeElapsedMs, 10_000);
});

test("advanceTimeoutTracker does not accumulate while paused", () => {
  let state: TimeoutTrackerState = { activeElapsedMs: 1_000 };
  state = advanceTimeoutTracker(state, 60_000, true);
  assert.equal(state.activeElapsedMs, 1_000);
});

test("hasTimedOut fires only once active elapsed time reaches the budget, regardless of paused wall-clock time in between", () => {
  let state: TimeoutTrackerState = { activeElapsedMs: 0 };
  const timeoutMs = 10_000;
  // 8s of real work.
  state = advanceTimeoutTracker(state, 8_000, false);
  assert.equal(hasTimedOut(state, timeoutMs), false);
  // An hour blocked on an open question - none of it counts.
  state = advanceTimeoutTracker(state, 60 * 60 * 1000, true);
  assert.equal(hasTimedOut(state, timeoutMs), false);
  // 2 more seconds of real work reaches the 10s budget.
  state = advanceTimeoutTracker(state, 2_000, false);
  assert.equal(hasTimedOut(state, timeoutMs), true);
});

// formatHandoffComment turns the structured handoff into the same comment a
// human would otherwise only find by opening the "Live activity" panel.
test("formatHandoffComment renders every non-empty field as its own section, in order", () => {
  const comment = formatHandoffComment({
    completed: "Added ensureWorkspaceTrusted.",
    changed: "runner.ts, runner.test.ts",
    verified: "85/85 tests pass, tsc builds clean.",
    problems: "",
    discovered: "",
    next: "Re-run job #113.",
    estimatedNextEffort: null,
  });
  assert.equal(
    comment,
    [
      "## Completed\nAdded ensureWorkspaceTrusted.",
      "## Changed\nrunner.ts, runner.test.ts",
      "## Verified\n85/85 tests pass, tsc builds clean.",
      "## Next\nRe-run job #113.",
    ].join("\n\n"),
  );
});

test("formatHandoffComment omits problems/discovered when the agent left them blank", () => {
  const comment = formatHandoffComment({
    completed: "Done.",
    changed: "x.ts",
    verified: "Ran tests.",
    problems: "",
    discovered: "",
    next: "",
    estimatedNextEffort: null,
  });
  assert.doesNotMatch(comment, /Problems/);
  assert.doesNotMatch(comment, /Discovered/);
  assert.doesNotMatch(comment, /Next/);
});

test("summarizeStreamLine extracts assistant text and tool_use blocks", () => {
  const line = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "looking at the file" },
        { type: "tool_use", name: "Read", input: { file_path: "/app/foo.ts" } },
      ],
    },
  };
  const activity = summarizeStreamLine(line);
  assert.deepEqual(activity, [
    { kind: "text", detail: { text: "looking at the file" } },
    { kind: "tool_use", detail: { name: "Read", input: '{"file_path":"/app/foo.ts"}' } },
  ]);
});

test("summarizeStreamLine extracts user tool_result blocks", () => {
  const line = {
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "command not found" }] },
  };
  assert.deepEqual(summarizeStreamLine(line), [
    { kind: "tool_result", detail: { isError: true, content: "command not found" } },
  ]);
});

test("summarizeStreamLine skips blank assistant text and non-content lines", () => {
  assert.deepEqual(summarizeStreamLine({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } }), []);
  assert.deepEqual(summarizeStreamLine({ type: "system", subtype: "init" }), []);
  assert.deepEqual(summarizeStreamLine({ type: "result", is_error: false }), []);
});

// prepareAttempt's decision logic, now against a past task's
// per-task clones rather than worktrees. The two "nothing to resume" cases
// never touch git or the network at all; the successful-rebase cases use a
// real throwaway git repo (and a real clone made by ensureTaskClone) so the
// rebase itself is exercised for real, not mocked. Deliberately not covering
// the rebase-conflict fallback here - that path calls addComment (a real
// pinboard network call, no DI seam to swap in a fake), so it's left to the
// plan's manual smoke test instead of risking a unit test writing a real
// comment somewhere.
function sessionTask(overrides: Partial<Task> = {}): Task {
  return { id: 1, claudeSessionId: null, activeWorktreeName: null, relatedProjectIds: [], ...overrides } as Task;
}

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, ["add", file]);
  execFileSync("git", ["commit", "-m", msg], { cwd, stdio: "pipe", env: { ...process.env, ...gitEnv } });
};

// A bare origin, a workspace checkout cloned from it with one commit on main,
// and (via ensureTaskClone) the task's own clone on its own branch - the same
// shape runOneAttempt sets up for a real attempt.
function taskClone(root: string, taskId: number): { originPath: string; repoPath: string; clonePath: string } {
  const originPath = join(root, "origin.git");
  const repoPath = join(root, "repo");
  git(root, ["init", "--bare", "-b", "main", originPath]);
  git(root, ["clone", originPath, repoPath]);
  git(repoPath, ["checkout", "-b", "main"]);
  commit(repoPath, "base.txt", "base");
  git(repoPath, ["push", "origin", "main"]);

  const clonePath = ensureTaskClone({
    taskId,
    repoSlug: "repo",
    sourceRepo: repoPath,
    branch: taskBranch(taskId),
    root: join(root, "tasks"),
  });
  // The rebase in prepareAttempt commits as whoever the clone says; a CI
  // runner has no global git identity (a past task moved CI to ubuntu-latest).
  git(clonePath, ["config", "user.name", "t"]);
  git(clonePath, ["config", "user.email", "t@t"]);
  return { originPath, repoPath, clonePath };
}

test("prepareAttempt returns fresh when the task has no stored session", async () => {
  const result = await prepareAttempt(sessionTask(), projectAt("/nonexistent/repo"), [], {
    actorType: "agent",
    actorName: "test",
  });
  assert.deepEqual(result, { mode: "fresh" });
});

test("prepareAttempt returns fresh when the task's workdir is gone", async () => {
  const result = await prepareAttempt(
    sessionTask({ claudeSessionId: "sess-1", activeWorktreeName: "task-1" }),
    projectAt("/nonexistent/repo"),
    [],
    { actorType: "agent", actorName: "test" },
    null,
    "/nonexistent/tasks",
  );
  assert.deepEqual(result, { mode: "fresh" });
});

test("prepareAttempt rebases a retained clone onto origin/main and returns resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-prepare-attempt-"));
  try {
    const { repoPath, clonePath } = taskClone(root, 1);
    commit(clonePath, "attempt.txt", "attempt work");

    // Simulate main having moved on (e.g. an unrelated merge) since the
    // task's branch was created.
    commit(repoPath, "other.txt", "unrelated main progress");
    git(repoPath, ["push", "origin", "main"]);

    const result = await prepareAttempt(
      sessionTask({ claudeSessionId: "sess-1", activeWorktreeName: "task-1" }),
      projectAt(repoPath),
      [],
      { actorType: "agent", actorName: "test" },
      null,
      join(root, "tasks"),
    );
    assert.deepEqual(result, { mode: "resume", sessionId: "sess-1", branch: "task-1" });
    assert.equal(clonePath, repoWorkdir(1, "repo", join(root, "tasks")));

    const log = execFileSync("git", ["log", "--oneline"], { cwd: clonePath }).toString();
    assert.match(log, /unrelated main progress/);
    assert.match(log, /attempt work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareAttempt resumes cleanly after the branch's own work was squash-merged into main", async () => {
  // mergeAndDeploy squash-merges (gh pr merge --squash), so main ends up
  // with a single commit whose content matches the branch's commit(s) but
  // whose hash differs - a plain `git rebase origin/main` would otherwise
  // hit "previous commit is now empty" on every one of the branch's own
  // already-landed commits and mistake that for a real conflict.
  const root = mkdtempSync(join(tmpdir(), "foreman-prepare-attempt-squash-"));
  try {
    const { repoPath, clonePath } = taskClone(root, 2);
    commit(clonePath, "feature.txt", "feature work");
    git(clonePath, ["push", "origin", taskBranch(2)]);

    // Simulate mergeAndDeploy: squash the task's branch straight onto main in
    // the workspace checkout and push it, as `gh pr merge --squash` would
    // leave it - a brand-new commit with the same tree, unrelated hash and
    // history to the clone's own commit.
    git(repoPath, ["fetch", "origin", taskBranch(2)]);
    execFileSync("git", ["merge", "--squash", "FETCH_HEAD"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "feature work (#2) (squashed)"], {
      cwd: repoPath,
      stdio: "pipe",
      env: { ...process.env, ...gitEnv },
    });
    git(repoPath, ["push", "origin", "main"]);

    const result = await prepareAttempt(
      sessionTask({ id: 2, claudeSessionId: "sess-2", activeWorktreeName: "task-2" }),
      projectAt(repoPath),
      [],
      { actorType: "agent", actorName: "test" },
      null,
      join(root, "tasks"),
    );
    assert.deepEqual(result, { mode: "resume", sessionId: "sess-2", branch: "task-2" });

    // The clone's own now-redundant commit should have been dropped by
    // --empty=drop rather than left duplicated on top of the squashed one.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: clonePath }).toString().trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /squashed/);
    assert.match(log[1], /base/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// the decision prepareAttempt makes before ever considering a
// resume. Split into its own pure function specifically so this could be
// unit-tested without going through prepareAttempt itself, which calls
// addComment (a real pinboard network call) on a mismatch - see the note
// above the squash-merge test for why that path is left to the manual smoke
// test instead.
test("isSessionResumableBy allows resuming across licenses, since every seat runs as the same Linux user", () => {
  assert.equal(isSessionResumableBy(sessionTask({ claudeSessionLicenseId: 3 }), 3), true);
  assert.equal(isSessionResumableBy(sessionTask({ claudeSessionLicenseId: 3 }), 7), true);
  assert.equal(isSessionResumableBy(sessionTask({ claudeSessionLicenseId: null }), 3), true);
  assert.equal(isSessionResumableBy(sessionTask({ claudeSessionLicenseId: null }), null), true);
});

test("prepareAttempt still resumes a retained clone when the resuming license matches the session's owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-prepare-attempt-license-match-"));
  try {
    const { repoPath, clonePath } = taskClone(root, 3);
    commit(clonePath, "attempt.txt", "attempt work");

    const result = await prepareAttempt(
      sessionTask({ id: 3, claudeSessionId: "sess-3", claudeSessionLicenseId: 5, activeWorktreeName: "task-3" }),
      projectAt(repoPath),
      [],
      { actorType: "agent", actorName: "test" },
      5,
      join(root, "tasks"),
    );
    assert.deepEqual(result, { mode: "resume", sessionId: "sess-3", branch: "task-3" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceTrusted marks a new repo path trusted without touching other entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  const configPath = join(dir, "claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({ projects: { "/other/repo": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] } } }),
  );
  try {
    ensureWorkspaceTrusted("/repo/a", configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.projects["/repo/a"].hasTrustDialogAccepted, true);
    assert.deepEqual(config.projects["/other/repo"], { hasTrustDialogAccepted: false, allowedTools: ["Bash"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceTrusted is a no-op once a repo path is already trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  const configPath = join(dir, "claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({ projects: { "/repo/a": { hasTrustDialogAccepted: true, allowedTools: ["Bash", "Edit"] } } }),
  );
  try {
    ensureWorkspaceTrusted("/repo/a", configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.projects["/repo/a"], { hasTrustDialogAccepted: true, allowedTools: ["Bash", "Edit"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceTrusted preserves other fields already on an untrusted repo entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  const configPath = join(dir, "claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({ projects: { "/repo/a": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] } } }),
  );
  try {
    ensureWorkspaceTrusted("/repo/a", configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.projects["/repo/a"].hasTrustDialogAccepted, true);
    assert.deepEqual(config.projects["/repo/a"].allowedTools, ["Bash"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a seat's own capacity on top of the global limit.
test("dispatchCapacity caps a seat that already holds its share", () => {
  // A seat holding 2 of a 3-wide limit may start one more, not three.
  assert.equal(dispatchCapacity(3, 3, 2, 2), 1);
});

test("dispatchCapacity stays bound by the global limit when a seat is idle", () => {
  // Other seats hold 2 of 2; this seat has started nothing and still gets none.
  assert.equal(dispatchCapacity(2, 2, 2, 0), 0);
});

test("a seat's own limit binds while the global cap still has room", () => {
  // Global 6, this seat 1: nothing in flight anywhere, one start allowed.
  assert.equal(dispatchCapacity(1, 6, 0, 0), 1);
});

test("a seat at its own limit gets nothing even with the global cap wide open", () => {
  assert.equal(dispatchCapacity(1, 6, 1, 1), 0);
});

test("earliestWait picks the soonest of several seats' waits", () => {
  assert.equal(
    earliestWait(["2026-09-17T18:00:00.000Z", "2026-09-17T16:30:00.000Z"]),
    "2026-09-17T16:30:00.000Z",
  );
});

// one seat waiting out its 5h window must not park a seat that
// isn't waiting at all, or work queued for the free seat sits until the
// other one resets.
test("earliestWait returns null when any seat is not waiting", () => {
  assert.equal(earliestWait(["2026-09-17T18:00:00.000Z", null]), null);
});

test("earliestWait returns null when no seat asked to wait", () => {
  assert.equal(earliestWait([null, null]), null);
});

test("earliestWait ignores an unparseable timestamp", () => {
  assert.equal(earliestWait(["not a date", "2026-09-17T16:30:00.000Z"]), "2026-09-17T16:30:00.000Z");
});

// The attempt cap only holds if opts.attempts is a real number, so every
// numeric option is checked before a run starts. It checks *only* those: the
// earlier version walked every key and skipped three by name, so a past task's
// `budgetExplicit` fell through to the numeric check and threw on its own
// default value, which killed every dispatched run until it was noticed.
test("validateRunOptions accepts the defaults, including the boolean options", () => {
  assert.doesNotThrow(() => validateRunOptions(DEFAULT_RUN_OPTIONS));
  assert.doesNotThrow(() => validateRunOptions({ ...DEFAULT_RUN_OPTIONS, budgetExplicit: true, agentExplicit: true, override: true }));
});

test("validateRunOptions rejects a numeric option that is not a positive number", () => {
  for (const key of ["timeoutMs", "budgetUsd", "attempts", "leaseSeconds"] as const) {
    assert.throws(() => validateRunOptions({ ...DEFAULT_RUN_OPTIONS, [key]: Number.NaN }), new RegExp(key));
    assert.throws(() => validateRunOptions({ ...DEFAULT_RUN_OPTIONS, [key]: 0 }), new RegExp(key));
  }
});

// a resumed repair run has to know which stage failed and what the
// evidence was - without it the session reads as an ordinary retry of a task
// it believes it already finished.
test("repairPromptLines carries the stage's own evidence into the prompt", () => {
  const prompt = repairPromptLines("ci_failed", "lint: src/work.ts(12,3): error TS2304", 161).join("\n");
  assert.match(prompt, /ci_failed/);
  assert.match(prompt, /CI failed on it/);
  assert.match(prompt, /still\s+open on your branch/);
  assert.match(prompt, /error TS2304/);
  assert.match(prompt, /work task ask 161/);
});

test("repairPromptLines tells a deploy_failed run its change already landed on main", () => {
  const prompt = repairPromptLines("deploy_failed", "healthcheck.sh: container unhealthy", 42).join("\n");
  assert.match(prompt, /MERGED to main/);
  assert.match(prompt, /new\s+commit on your branch on top of current main/);
  assert.doesNotMatch(prompt, /still open on your branch/);
});

test("repairPromptLines survives a handback with no evidence recorded", () => {
  const prompt = repairPromptLines("merge_conflict", null, 7).join("\n");
  assert.match(prompt, /conflict/);
  assert.match(prompt, /none recorded/);
});

// a fresh attempt (no retained session to resume) still needs a
// forced push when it is a repair handback, because prepareAttempt's fresh
// fallback clones the branch's own existing remote tip and the repair prompt
// then has the agent rebase it - rewriting a branch the remote already has
// an open PR on. A fresh attempt with no repairReason is a brand-new branch,
// where a plain push is correct (and safer, since nothing should already be
// there to overwrite).
test("pushNeedsForce forces a resumed attempt's push regardless of repair reason", () => {
  assert.equal(pushNeedsForce(true, null), true);
  assert.equal(pushNeedsForce(true, "merge_conflict"), true);
});

test("pushNeedsForce forces a fresh attempt's push when it is a repair handback", () => {
  assert.equal(pushNeedsForce(false, "merge_conflict"), true);
  assert.equal(pushNeedsForce(false, "ci_failed"), true);
  assert.equal(pushNeedsForce(false, "deploy_failed"), true);
});

test("pushNeedsForce leaves a fresh, non-repair attempt's push unforced", () => {
  assert.equal(pushNeedsForce(false, null), false);
});

// one PR per repo on a multi-repo task's shared branch name.
test("findExistingPr matches the repo as well as the branch", () => {
  const prs = [
    { url: "https://gh/foreman/pull/1", branchName: "task-9", repoSlug: "foreman", state: "open" },
    { url: "https://gh/pinboard/pull/2", branchName: "task-9", repoSlug: "pinboard", state: "closed" },
  ];
  assert.equal(findExistingPr(prs, "task-9", "foreman")?.url, "https://gh/foreman/pull/1");
  // pinboard's only PR is closed, so a new one gets opened rather than reusing foreman's
  assert.equal(findExistingPr(prs, "task-9", "pinboard"), undefined);
  assert.equal(findExistingPr(prs, "task-10", "foreman"), undefined);
});

// "Pushed additional commits" is only posted when the remote moved.
test("remoteBranchSha changes only when a push actually moves the branch", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-sha-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
  try {
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(root, "clone", "-q", remote, clone);
    assert.equal(remoteBranchSha(clone, "task-1"), null);
    git(clone, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(clone, "a"), "1");
    git(clone, "add", "a");
    git(clone, "commit", "-q", "-m", "one");
    git(clone, "push", "-q", "origin", "task-1");
    const first = remoteBranchSha(clone, "task-1");
    assert.equal(first, git(clone, "rev-parse", "HEAD"));
    git(clone, "push", "-q", "origin", "task-1");
    assert.equal(remoteBranchSha(clone, "task-1"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// the push decides force from the remote tip, not only from
// isResume/repairReason.
test("pushForceArgs: new branch and fast-forward push plainly, a rewrite leases the sha read before", () => {
  assert.deepEqual(pushForceArgs("task-1", false, null, null), []);
  assert.deepEqual(pushForceArgs("task-1", false, "abc", "ancestor"), []);
  assert.deepEqual(pushForceArgs("task-1", false, "abc", "rewritten"), ["--force-with-lease=task-1:abc"]);
  // a tip this clone never saw is someone else's work: plain push, git refuses it
  assert.deepEqual(pushForceArgs("task-1", false, "abc", "unknown"), []);
  // resume/repair keep their implicit lease
  assert.deepEqual(pushForceArgs("task-1", true, null, null), ["--force-with-lease"]);
  assert.deepEqual(pushForceArgs("task-1", true, "abc", "rewritten"), ["--force-with-lease"]);
});

test("pushTaskBranch pushes new, fast-forwarded and rewritten branches, and refuses one moved by someone else", () => {
  const root = mkdtempSync(join(tmpdir(), "push-lease-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", file);
  };
  const push = (cwd: string) => {
    const before = remoteBranchSha(cwd, "task-1");
    pushTaskBranch(cwd, "task-1", false, before);
  };
  try {
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    const other = join(root, "other");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(root, "clone", "-q", remote, clone);
    git(clone, "checkout", "-q", "-b", "task-1");
    commit(clone, "a");
    push(clone); // new branch
    assert.equal(remoteBranchSha(clone, "task-1"), git(clone, "rev-parse", "HEAD"));
    commit(clone, "b");
    push(clone); // fast-forward
    assert.equal(remoteBranchSha(clone, "task-1"), git(clone, "rev-parse", "HEAD"));
    git(clone, "commit", "-q", "--amend", "-m", "b rewritten");
    push(clone); // rewritten, e.g. rebased inside the session
    assert.equal(remoteBranchSha(clone, "task-1"), git(clone, "rev-parse", "HEAD"));

    // rewrite again, read the tip, then someone else moves the branch
    git(clone, "commit", "-q", "--amend", "-m", "b rewritten twice");
    const before = remoteBranchSha(clone, "task-1");
    git(root, "clone", "-q", "-b", "task-1", remote, other);
    commit(other, "c");
    git(other, "push", "-q", "origin", "task-1");
    const moved = remoteBranchSha(clone, "task-1");
    assert.throws(() => pushTaskBranch(clone, "task-1", false, before));
    assert.equal(remoteBranchSha(clone, "task-1"), moved);
    // and with the moved tip read fresh, it is unknown here, so still refused
    assert.throws(() => push(clone));
    assert.equal(remoteBranchSha(clone, "task-1"), moved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// a claim refused mid-run for capacity must requeue (refunding the
// unstarted attempt) with a comment; one refused because another live run
// holds the lease must leave the task alone.
async function recordClaimRefusal(claim: { reason: string; leaseExpiresAt?: string }, offQueue: boolean) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  const exitCode = process.exitCode;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ id: 75 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const requeued = await handleClaimRefusal(75, { actorType: "agent", actorName: "foreman-runner" }, claim, 1, offQueue);
    return { requeued, calls };
  } finally {
    globalThis.fetch = original;
    process.exitCode = exitCode;
  }
}

test("handleClaimRefusal: capacity refusal mid-run requeues with the spent attempts and comments why", async () => {
  const { requeued, calls } = await recordClaimRefusal({ reason: "per-project concurrency limit (1) reached for this project" }, true);
  assert.equal(requeued, true);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch?.url.endsWith("/tasks/75"));
  assert.deepEqual(patch?.body, { status: "queued", attemptCount: 1 });
  const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/tasks/75/comments"));
  assert.match(String((comment?.body as { body?: string })?.body), /concurrency limit.*Requeued/s);
});

test("handleClaimRefusal: already leased by a live run touches nothing", async () => {
  const { requeued, calls } = await recordClaimRefusal({ reason: "task is leased", leaseExpiresAt: "2026-09-18T13:30:00Z" }, true);
  assert.equal(requeued, false);
  assert.equal(calls.length, 0);
});

test("handleClaimRefusal: capacity refusal on a first claim of a queued task touches nothing", async () => {
  const { requeued, calls } = await recordClaimRefusal({ reason: "per-license concurrency limit" }, false);
  assert.equal(requeued, false);
  assert.equal(calls.length, 0);
});

// two seats, one at its 5h session limit. The limited seat alone
// waits for its window; the idle seat still gets its queued task, and the loop
// stays on the normal poll interval. Pinboard is stubbed at the fetch level
// and runTask is replaced, so no real run starts. dispatchOnce's disk
// preflight reads TASK_ROOT for real, hence the skip where it does not exist.
const LIMITED_SEAT = 1;
const IDLE_SEAT = 2;
const WINDOW_RESET = "2026-09-22T15:00:00.000Z";

function plan(overrides: Record<string, unknown>) {
  return {
    tasks: [], waitUntil: null, reason: null, periodConfigured: true, periodRemainingUsd: 50,
    sessionRemainingUsd: 5, concurrency: 1, concurrencyGlobal: 2, seatRunning: 0, ...overrides,
  };
}

async function dispatchWithSeats(plans: Record<number, unknown>, executorFor = (_licenseId: number) => "cli") {
  const polled: string[] = [];
  const started: { taskId: number; licenseId: number | undefined }[] = [];
  const original = globalThis.fetch;
  const minFree = process.env.FOREMAN_MIN_FREE_GB;
  process.env.FOREMAN_MIN_FREE_GB = "0";
  const agent = (id: number, licenseId: number) => ({
    id, name: `runner-${licenseId}`, role: null, provider: "anthropic", model: null, executor: executorFor(licenseId),
    autonomyLevel: 5, credentialRef: null, routingWeight: 1, enabled: true, licenseId,
  });
  const license = (id: number) => ({
    id, name: `seat-${id}`, provider: "anthropic", linuxUser: `user${id}`, sessionBudgetUsd: null, concurrencyLimit: null, enabled: true,
  });
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    polled.push(u.pathname + u.search);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/licenses")) return json([license(LIMITED_SEAT), license(IDLE_SEAT)]);
    if (u.pathname.endsWith("/agents")) return json([agent(11, LIMITED_SEAT), agent(12, IDLE_SEAT)]);
    if (u.pathname.endsWith("/routing-rules")) return json([]);
    if (u.pathname.endsWith("/plan/next")) {
      const seatPlan = plans[Number(u.searchParams.get("licenseId"))];
      return seatPlan instanceof Error ? json({ error: seatPlan.message }, 500) : json(seatPlan);
    }
    const task = u.pathname.match(/\/tasks\/(\d+)$/);
    if (task) return json({ id: Number(task[1]), taskType: "feature", labels: [], autonomyLevel: 3 });
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
  try {
    const result = await dispatchOnce(DEFAULT_RUN_OPTIONS, async (taskId, opts) => {
      started.push({ taskId, licenseId: opts.preferLicenseId });
    });
    return { result, started, polled };
  } finally {
    globalThis.fetch = original;
    if (minFree === undefined) delete process.env.FOREMAN_MIN_FREE_GB;
    else process.env.FOREMAN_MIN_FREE_GB = minFree;
  }
}

const noTaskRoot = !existsSync(TASK_ROOT) && `${TASK_ROOT} does not exist here`;
const limitedPlan = plan({ waitUntil: WINDOW_RESET, reason: "session window budget spent", sessionRemainingUsd: 0 });
const queued = (taskId: number) => ({
  taskId, title: "queued", projectId: 1, priority: 1, estimatedCostUsd: 1, estimateBasis: "default",
});

test("dispatchOnce starts the idle seat's queued task while the other seat waits for its window", { skip: noTaskRoot }, async () => {
  const { result, started } = await dispatchWithSeats({
    [LIMITED_SEAT]: limitedPlan,
    [IDLE_SEAT]: plan({ tasks: [queued(26801)] }),
  });
  assert.deepEqual(started, [{ taskId: 26801, licenseId: IDLE_SEAT }]);
  assert.equal(result.ran, true);
  assert.equal(computeSleepMs(result.waitUntil, 60, Date.parse("2026-09-22T14:14:00Z")), 60_000);
});

test("dispatchOnce keeps the normal interval when the idle seat simply has nothing queued", { skip: noTaskRoot }, async () => {
  const { result, started } = await dispatchWithSeats({ [LIMITED_SEAT]: limitedPlan, [IDLE_SEAT]: plan({}) });
  assert.deepEqual(started, []);
  assert.equal(result.ran, false);
  assert.equal(result.waitUntil, null);
  assert.match(String(result.reason), /seat-1: session window budget spent/);
});

test("dispatchOnce does not sleep behind a waiting seat when the other seat's poll fails", { skip: noTaskRoot }, async () => {
  const { result } = await dispatchWithSeats({ [LIMITED_SEAT]: limitedPlan, [IDLE_SEAT]: new Error("pinboard hiccup") });
  assert.equal(result.waitUntil, null);
});

test("dispatchOnce sleeps until the window resets only when every seat is waiting on it", { skip: noTaskRoot }, async () => {
  const { result, started } = await dispatchWithSeats({ [LIMITED_SEAT]: limitedPlan, [IDLE_SEAT]: limitedPlan });
  assert.deepEqual(started, []);
  assert.equal(result.waitUntil, WINDOW_RESET);
});

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = original;
  }
}

test("dispatchOnce logs a task no seat has an eligible agent for, once per task", { skip: noTaskRoot }, async () => {
  const plans = { [LIMITED_SEAT]: plan({ tasks: [queued(26802)] }), [IDLE_SEAT]: plan({ tasks: [queued(26802)] }) };
  const first = await captureLogs(() => dispatchWithSeats(plans, () => "cli-host"));
  assert.deepEqual(first.value.started, []);
  const lines = first.logs.filter((l) => l.includes("no eligible agent"));
  assert.deepEqual(lines, [
    'dispatch: task 26802 has no eligible agent (needs an enabled executor "cli" agent with autonomy >= 3 on a seat, or a routing rule)',
  ]);
  const second = await captureLogs(() => dispatchWithSeats(plans, () => "cli-host"));
  assert.equal(second.logs.filter((l) => l.includes("no eligible agent")).length, 0);
});

test("dispatchOnce does not log a task that is simply another seat's work", { skip: noTaskRoot }, async () => {
  // both seats are offered the task, but only the idle seat has a "cli"
  // runner, so the first seat skips it quietly and the idle seat starts it.
  const { value, logs } = await captureLogs(() =>
    dispatchWithSeats(
      { [LIMITED_SEAT]: plan({ tasks: [queued(26803)] }), [IDLE_SEAT]: plan({ tasks: [queued(26803)] }) },
      (licenseId) => (licenseId === IDLE_SEAT ? "cli" : "cli-host"),
    ),
  );
  assert.deepEqual(value.started, [{ taskId: 26803, licenseId: IDLE_SEAT }]);
  assert.equal(logs.filter((l) => l.includes("no eligible agent")).length, 0);
});

// a no-commit session on an ops task is a success, on a code task a failure.
const doneHandoff = { completed: "Upgraded CT 116 to Debian 13.", verified: "cat /etc/debian_version -> 13.1" };

test("decideNoCommitOutcome sends a no-commit root-access task with a full handoff to review", () => {
  const d = decideNoCommitOutcome(["infra", "root-access"], doneHandoff);
  assert.equal(d.to, "review");
  assert.match(d.comment, /expected for a `root-access` task/);
});

test("decideNoCommitOutcome treats the no-repo-change label the same way", () => {
  assert.equal(decideNoCommitOutcome(["no-repo-change"], doneHandoff).to, "review");
});

test("decideNoCommitOutcome still sends a no-commit code task to rework", () => {
  const d = decideNoCommitOutcome(["infra"], doneHandoff);
  assert.equal(d.to, "rework");
  assert.match(d.comment, /made no commits - nothing to open a PR for/);
});

test("decideNoCommitOutcome sends an ops task with no Completed/Verified to rework", () => {
  const d = decideNoCommitOutcome(["root-access"], { completed: "Did the upgrade.", verified: "  " });
  assert.equal(d.to, "rework");
  assert.match(d.comment, /no verified section/);
});

test("decideNoCommitOutcome closes an already-done task as done when Verified is filled in", () => {
  const d = decideNoCommitOutcome(["maintenance"], { ...doneHandoff, outcome: "already_done" });
  assert.equal(d.to, "done");
  assert.match(d.comment, /already done/);
});

test("decideNoCommitOutcome closes a task the session rejected as rejected", () => {
  assert.equal(decideNoCommitOutcome([], { ...doneHandoff, outcome: "rejected" }).to, "rejected");
});

test("decideNoCommitOutcome sends an unbacked outcome claim to rework", () => {
  assert.equal(decideNoCommitOutcome([], { completed: "x", verified: " ", outcome: "already_done" }).to, "rework");
  assert.equal(decideNoCommitOutcome([], { completed: "", verified: "x", outcome: "rejected" }).to, "rework");
});

// a repo related mid-run gets its clone from the CLI call, and is
// part of the post-session push/PR set.
test("cloneRelatedRepoMidRun clones the repo on the task branch inside a task workdir", () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-midrun-clone-"));
  try {
    const { repoPath: primary } = taskClone(root, 469);
    const other = join(root, "other");
    git(root, ["clone", primary, other]);
    const tasks = join(root, "tasks");
    recordWorkspaceRoot(469, tasks, root);
    const clonePath = cloneRelatedRepoMidRun(469, project({ id: 2, slug: "other", localPath: "other" }), tasks);
    assert.equal(clonePath, repoWorkdir(469, "other", tasks));
    assert.equal(git(clonePath as string, ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim(), taskBranch(469));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneRelatedRepoMidRun only records the relation outside a task workdir", () => {
  const root = mkdtempSync(join(tmpdir(), "foreman-midrun-noclone-"));
  try {
    const tasks = join(root, "tasks");
    assert.equal(cloneRelatedRepoMidRun(469, project({ id: 2, slug: "other", localPath: "other" }), tasks), null);
    assert.equal(existsSync(tasks), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relatedTargetsAfterSession includes a repo related during the session", async () => {
  const self = project({ id: 1 });
  const other = project({ id: 2, slug: "other", localPath: "my-org/other" });
  const before = { ...task(), id: 469, relatedProjectIds: [] } as Task;
  const after = { ...before, relatedProjectIds: [2] } as Task;
  const targets = await relatedTargetsAfterSession(before, self, [self, other], [], async () => after, "/t");
  assert.deepEqual(targets.map((t) => t.repoPath), [repoWorkdir(469, "other", "/t")]);
  const fallback = await relatedTargetsAfterSession(before, self, [self, other], [], async () => {
    throw new Error("pinboard down");
  });
  assert.deepEqual(fallback, []);
});

test("formatNeedsInputComment quotes every line of the pending question", () => {
  const c = formatNeedsInputComment("Which DB?\nPostgres or SQLite");
  assert.match(c, /^> Which DB\?$/m);
  assert.match(c, /^> Postgres or SQLite$/m);
  assert.match(c, /attempt not counted/);
});

// autonomy policy, prior Q&A in the prompt, PR body layout.
test("autonomyPolicy tells the run to assume reversible choices and ask only for the listed kinds", () => {
  const text = autonomyPolicy(42);
  assert.match(text, /work task assume 42 "<decision>" --why=/);
  assert.match(text, /work task ask 42 "<question>" --context=.* --option="<label>\|<rationale>".* --recommended=<n>/);
  for (const kind of ["irreversible", "destructive", "production-impacting", "secrets", "scope", "money", "contradicts the task"]) {
    assert.match(text, new RegExp(kind));
  }
  assert.match(text, /compatibility, expandability, and cost\/risk/);
  assert.doesNotMatch(text, /rather than guessing/);
  assert.match(handoffSummaryPolicy(), /at most 5 short lines/);
  assert.match(handoffSummaryPolicy(), /Needs you:/);
});

test("dockerPolicy keeps compose runs in the task directory under a per-task project name", () => {
  const policy = dockerPolicy(657);
  assert.match(policy, /never a copy under \/tmp/);
  assert.match(policy, /`-p task-657`/);
});

test("askHistoryLines lists every answered ask and skips open ones", () => {
  const base = { taskId: 1, threadId: null, context: null, answeredAt: null, createdAt: "" };
  const lines = askHistoryLines([
    { ...base, id: 1, kind: "question", question: "Which db?", options: [{ label: "Postgres", rationale: null, recommended: true }, { label: "SQLite", rationale: null, recommended: false }], status: "answered", answerOption: 1, answerText: "keep it simple" },
    { ...base, id: 2, kind: "question", question: "Port?", options: [], status: "answered", answerOption: null, answerText: "8080" },
    { ...base, id: 3, kind: "assumption", question: "Named it foo", options: [], status: "vetoed", answerOption: null, answerText: "call it bar" },
    { ...base, id: 4, kind: "question", question: "Still open?", options: [], status: "open", answerOption: null, answerText: null },
  ]);
  const text = lines.join("\n");
  assert.match(text, /Q: Which db\?\n    A: option "SQLite" - keep it simple/);
  assert.match(text, /Q: Port\?\n    A: 8080/);
  assert.match(text, /You assumed: Named it foo\n    Operator VETOED: call it bar/);
  assert.doesNotMatch(text, /Still open/);
  assert.deepEqual(askHistoryLines([]), []);
});

test("formatPrBody leads with the summary and collapses the agent detail", () => {
  const body = formatPrBody(
    { id: 503 },
    { name: "foreman" },
    {
      summary: "Runners assume reversible choices.\nNeeds you: deploy foreman.",
      howToVerify: "1. npm test",
      completed: "All of it.",
      changed: "runner.ts",
      verified: "tests pass",
      problems: "",
      discovered: "a thing",
      next: "",
      estimatedNextEffort: null,
    },
    ["app/src/runner.ts", "app/src/work.ts"],
  );
  assert.equal(
    body,
    [
      "Runners assume reversible choices.",
      "Needs you: deploy foreman.",
      "",
      "Closes pinboard #503 (foreman).",
      "",
      "## Changed",
      "- `app/src/runner.ts`",
      "- `app/src/work.ts`",
      "",
      "## How to verify",
      "1. npm test",
      "",
      "<details><summary>Agent detail</summary>",
      "",
      "### Completed\nAll of it.\n\n### Changed\nrunner.ts\n\n### Verified\ntests pass\n\n### Discovered\na thing",
      "",
      "</details>",
    ].join("\n"),
  );
  assert.doesNotMatch(body, /Opened unattended/);
});

// the push/PR path's pinboard calls ride out a pinboard deploy
// (~1 minute) instead of sending a finished task to rework on "fetch failed".
// Delay is overridden to 0 so the test stays fast; the attempt cap is the real one.
test("PR_PINBOARD_RETRY covers about a minute of pinboard being unreachable", () => {
  assert.equal(PR_PINBOARD_RETRY.attempts, 10);
  assert.equal(PR_PINBOARD_RETRY.delayMs, 6_000);
  assert.ok((PR_PINBOARD_RETRY.attempts - 1) * PR_PINBOARD_RETRY.delayMs >= 50_000);
});

test("withRetry with PR_PINBOARD_RETRY's attempts survives a few fetch failures", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls <= 5) throw new TypeError("fetch failed");
      return "ok";
    },
    PR_PINBOARD_RETRY.attempts,
    0,
  );
  assert.equal(result, "ok");
  assert.equal(calls, 6);
});

test("withRetry with PR_PINBOARD_RETRY's attempts rethrows after the cap", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      PR_PINBOARD_RETRY.attempts,
      0,
    ),
    { name: "TypeError", message: "fetch failed" },
  );
  assert.equal(calls, PR_PINBOARD_RETRY.attempts);
});

// gh pr create retries transient GitHub errors.
function ghError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh pr create --body "timeout 503"\n${stderr}`), { stderr: Buffer.from(stderr) });
}

test("isTransientGhError: GraphQL, 5xx, timeouts and resets are transient", () => {
  for (const msg of [
    "GraphQL: Something went wrong while executing your query. (createPullRequest)",
    "HTTP 502: Bad Gateway",
    "HTTP 503",
    "Post \"https://api.github.com/graphql\": read tcp: connection reset by peer",
    "dial tcp: i/o timeout",
    "ECONNRESET",
  ]) assert.equal(isTransientGhError(ghError(msg)), true, msg);
  assert.equal(isTransientGhError(Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" })), true);
});

test("isTransientGhError: validation, existing PR and auth are not, whatever the command line says", () => {
  for (const msg of [
    "a pull request for branch \"task-1\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/1",
    "GraphQL: No commits between main and task-1 (createPullRequest)",
    "HTTP 401: Bad credentials",
    "HTTP 422: Validation Failed",
  ]) assert.equal(isTransientGhError(ghError(msg)), false, msg);
});

test("GH_PR_CREATE_RETRY_DELAYS_MS gives 4 attempts over about 50s", () => {
  assert.deepEqual([...GH_PR_CREATE_RETRY_DELAYS_MS], [5_000, 15_000, 30_000]);
});

test("createPrWithRetry: transient then success", async () => {
  let creates = 0;
  const slept: number[] = [];
  const url = await createPrWithRetry({
    create: () => {
      if (++creates === 1) throw ghError("GraphQL: Something went wrong while executing your query.");
      return "https://github.com/o/r/pull/2";
    },
    findOpen: () => null,
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(url, "https://github.com/o/r/pull/2");
  assert.equal(creates, 2);
  assert.deepEqual(slept, [5_000]);
});

test("createPrWithRetry: transient but the PR was created, no second create", async () => {
  let creates = 0;
  let lookups = 0;
  const url = await createPrWithRetry({
    create: () => {
      creates++;
      throw ghError("GraphQL: Something went wrong while executing your query.");
    },
    findOpen: () => (++lookups, "https://github.com/o/r/pull/3"),
    sleep: async () => {},
  });
  assert.equal(url, "https://github.com/o/r/pull/3");
  assert.equal(creates, 1);
  assert.equal(lookups, 1);
});

test("createPrWithRetry: a non-transient error fails at once", async () => {
  let creates = 0;
  let lookups = 0;
  await assert.rejects(
    createPrWithRetry({
      create: () => {
        creates++;
        throw ghError("a pull request for branch \"task-1\" into branch \"main\" already exists");
      },
      findOpen: () => (++lookups, null),
      sleep: async () => assert.fail("must not sleep"),
    }),
    /already exists/,
  );
  assert.equal(creates, 1);
  assert.equal(lookups, 0);
});

test("createPrWithRetry: exhausted retries rethrow the last error", async () => {
  let creates = 0;
  const slept: number[] = [];
  await assert.rejects(
    createPrWithRetry({
      create: () => {
        creates++;
        throw ghError(`HTTP 50${creates}`);
      },
      findOpen: () => null,
      sleep: async (ms) => void slept.push(ms),
    }),
    (err: Error & { stderr: Buffer }) => err.stderr.toString() === "HTTP 504",
  );
  assert.equal(creates, 4);
  assert.deepEqual(slept, [5_000, 15_000, 30_000]);
});

// A past task
const HANDOFF_594 = {
  summary: "Adds the thing.",
  howToVerify: "1. npm test",
  completed: "All of it, see pinboard #594.",
  changed: "runner.ts",
  verified: "tests pass",
  problems: "",
  discovered: "",
  next: "",
  estimatedNextEffort: null,
};

test("formatPrBody for a public repo has no task ref or agent detail; private is unchanged", () => {
  const files = ["app/src/runner.ts"];
  const pub = formatPrBody({ id: 594 }, { name: "pinboard" }, HANDOFF_594, files, true);
  assert.equal(pub, ["Adds the thing.", "", "## Changed", "- `app/src/runner.ts`", "", "## How to verify", "1. npm test"].join("\n"));
  assert.doesNotMatch(pub, /task [#0-9]|#594|pinboard/i);
  assert.equal(
    formatPrBody({ id: 594 }, { name: "pinboard" }, HANDOFF_594, files, false),
    formatPrBody({ id: 594 }, { name: "pinboard" }, HANDOFF_594, files),
  );
  assert.match(formatPrBody({ id: 594 }, { name: "pinboard" }, HANDOFF_594, files), /Closes pinboard #594/);
});

test("formatPrTitle: public uses the first commit subject, private keeps the pinboard suffix", () => {
  const task = { id: 594, title: "Public-repo mode" };
  assert.equal(formatPrTitle(task, true, "Add: leak gate before push"), "Add: leak gate before push");
  assert.equal(formatPrTitle(task, true, null), "Public-repo mode");
  assert.equal(formatPrTitle(task, false, "Add: leak gate"), "Public-repo mode (pinboard #594)");
});

test("publicRepoRulesLines names exactly the public repos, and is empty with none", () => {
  assert.deepEqual(publicRepoRulesLines([]), []);
  const text = publicRepoRulesLines(["rackmarten/pinboard", "rackmarten/homelab-kit"], "/ws/patterns.txt").join("\n");
  assert.match(text, /Public repository rules/);
  assert.match(text, /^  - rackmarten\/pinboard$/m);
  assert.match(text, /^  - rackmarten\/homelab-kit$/m);
  assert.equal(text.match(/^  - /gm)?.length, 2);
  assert.match(text, /task numbers/);
  assert.match(text, /\/ws\/patterns\.txt/);
});
