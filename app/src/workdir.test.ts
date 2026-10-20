import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  branchSlug,
  chooseTaskBranch,
  currentBranch,
  proposedTaskBranch,
  taskWorkdirBranch,
  withCollisionSuffix,
  deployLockPath,
  ensureTaskClone,
  isStaleLock,
  isSweepable,
  listTaskWorkdirIds,
  packageDirs,
  parseTaskWorkdirName,
  pruneTrustedWorkdirs,
  rebaseOntoMain,
  removeTaskWorkdir,
  repoWorkdir,
  resolveDefaultBranch,
  seedNodeModules,
  shouldSeedNodeModules,
  taskBranch,
  taskWorkdir,
  withDeployLock,
} from "./workdir.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "foreman-workdir-test-"));
}

test("paths and branch names are derived from the task id alone", () => {
  assert.equal(taskWorkdir(153, "/app/tasks"), "/app/tasks/task-153");
  assert.equal(repoWorkdir(153, "pinboard", "/app/tasks"), "/app/tasks/task-153/repos/pinboard");
  assert.equal(taskBranch(153), "task-153");
});

test("parseTaskWorkdirName only accepts a task directory", () => {
  assert.equal(parseTaskWorkdirName("task-153"), 153);
  assert.equal(parseTaskWorkdirName(".locks"), null);
  assert.equal(parseTaskWorkdirName("task-abc"), null);
  assert.equal(parseTaskWorkdirName("scratch"), null);
});

test("listTaskWorkdirIds ignores anything that is not a task directory", () => {
  const root = scratch();
  mkdirSync(join(root, "task-7"));
  mkdirSync(join(root, "task-12"));
  mkdirSync(join(root, ".locks"));
  assert.deepEqual(listTaskWorkdirIds(root).sort((a, b) => a - b), [7, 12]);
  assert.deepEqual(listTaskWorkdirIds(join(root, "missing")), []);
  rmSync(root, { recursive: true, force: true });
});

test("shouldSeedNodeModules only copies into an empty clone with an identical lockfile", () => {
  const lock = '{"lockfileVersion":3}';
  assert.equal(shouldSeedNodeModules({ lock, hasModules: true }, { lock, hasModules: false }), true);
  // lockfiles differ - the clone needs its own install
  assert.equal(shouldSeedNodeModules({ lock, hasModules: true }, { lock: "{}", hasModules: false }), false);
  // nothing installed in the workspace checkout to copy
  assert.equal(shouldSeedNodeModules({ lock, hasModules: false }, { lock, hasModules: false }), false);
  // clone already has its own - never overwrite it
  assert.equal(shouldSeedNodeModules({ lock, hasModules: true }, { lock, hasModules: true }), false);
  // a repo with no lockfile at all
  assert.equal(shouldSeedNodeModules({ lock: null, hasModules: true }, { lock: null, hasModules: false }), false);
});

test("packageDirs finds every package-lock.json without descending into node_modules", () => {
  const root = scratch();
  mkdirSync(join(root, "app", "pwa"), { recursive: true });
  mkdirSync(join(root, "app", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "app", "package-lock.json"), "{}");
  writeFileSync(join(root, "app", "pwa", "package-lock.json"), "{}");
  writeFileSync(join(root, "app", "node_modules", "dep", "package-lock.json"), "{}");

  assert.deepEqual(packageDirs(root).sort(), [join(root, "app"), join(root, "app", "pwa")]);
  rmSync(root, { recursive: true, force: true });
});

test("seedNodeModules copies a matching lockfile's modules and skips a mismatched one", () => {
  const root = scratch();
  const source = join(root, "source");
  const clone = join(root, "clone");
  for (const base of [source, clone]) mkdirSync(join(base, "app", "pwa"), { recursive: true });

  writeFileSync(join(source, "app", "package-lock.json"), '{"v":1}');
  writeFileSync(join(clone, "app", "package-lock.json"), '{"v":1}');
  mkdirSync(join(source, "app", "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(source, "app", "node_modules", "left-pad", "index.js"), "module.exports = 1;");

  // pwa's lockfile differs, so it must be left for the agent's own npm ci
  writeFileSync(join(source, "app", "pwa", "package-lock.json"), '{"v":2}');
  writeFileSync(join(clone, "app", "pwa", "package-lock.json"), '{"v":3}');
  mkdirSync(join(source, "app", "pwa", "node_modules"), { recursive: true });

  const seeded = seedNodeModules(source, clone);
  assert.deepEqual(seeded, [join(clone, "app")]);
  assert.ok(existsSync(join(clone, "app", "node_modules", "left-pad", "index.js")));
  assert.equal(existsSync(join(clone, "app", "pwa", "node_modules")), false);

  // a real copy, not a hardlink: writing in the clone must not reach the
  // workspace checkout's own node_modules
  writeFileSync(join(clone, "app", "node_modules", "left-pad", "index.js"), "module.exports = 2;");
  assert.equal(readFileSync(join(source, "app", "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;");
  rmSync(root, { recursive: true, force: true });
});

test("ensureTaskClone clones onto its own branch from origin/main and is idempotent", () => {
  const root = scratch();
  const source = join(root, "source");
  const tasks = join(root, "tasks");
  mkdirSync(source, { recursive: true });

  const git = (args: string[], cwd = source): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  // No `origin` remote on the fixture, so ensureTaskClone's remote/fetch step
  // is skipped and origin stays the local clone source - which still gives
  // the clone an origin/main to branch from, exactly as the real path does.

  const dest = ensureTaskClone({ taskId: 42, repoSlug: "source", sourceRepo: source, branch: taskBranch(42), root: tasks });
  assert.equal(dest, repoWorkdir(42, "source", tasks));
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dest).trim(), "task-42");
  assert.ok(existsSync(join(dest, "README.md")));

  // a second call (a resumed attempt, or another repo target in the same run)
  // leaves the existing clone and its commits alone
  writeFileSync(join(dest, "in-progress.txt"), "work\n");
  ensureTaskClone({ taskId: 42, repoSlug: "source", sourceRepo: source, branch: taskBranch(42), root: tasks });
  assert.ok(existsSync(join(dest, "in-progress.txt")));

  removeTaskWorkdir(42, tasks);
  assert.equal(existsSync(taskWorkdir(42, tasks)), false);
  rmSync(root, { recursive: true, force: true });
});

// a repair handback can arrive after the workdir sweep has removed
// the task's clone, and the branch's only copy of its work is then the remote
// one the PR is built on. Cutting a fresh branch from main again would lose
// it, and the resumed attempt's own --force-with-lease push would then
// overwrite the PR with a branch missing its own commits.
test("ensureTaskClone checks out a branch that already exists on the remote instead of cutting a new one", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const tasks = join(root, "tasks");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "main"], source);
  // The work an earlier attempt already pushed, present only on the remote.
  git(["checkout", "-qb", taskBranch(99)], source);
  writeFileSync(join(source, "already-pushed.txt"), "earlier attempt\n");
  git(["add", "."], source);
  git(["commit", "-qm", "earlier attempt"], source);
  git(["push", "-q", "-u", "origin", taskBranch(99)], source);
  git(["checkout", "-q", "main"], source);
  git(["branch", "-qD", taskBranch(99)], source);

  const dest = ensureTaskClone({ taskId: 99, repoSlug: "source", sourceRepo: source, branch: taskBranch(99), root: tasks });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dest).trim(), taskBranch(99));
  assert.ok(existsSync(join(dest, "already-pushed.txt")), "the branch's own commits should still be there");
  rmSync(root, { recursive: true, force: true });
});

// A past task moved this here from runner.ts because the pipeline's merge stage
// uses it to clear a stale branch without spending an agent run. The
// --empty=drop case is the one that matters: the pipeline squash-merges, so a
// resumed branch's own commits are already in main under a different hash.
test("rebaseOntoMain rebases onto origin/main, dropping commits main already has", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "main"], source);

  // The task's branch, and the same change landing on main separately - a
  // squash merge, as far as this branch can tell.
  git(["checkout", "-qb", taskBranch(7)], source);
  writeFileSync(join(source, "feature.txt"), "feature\n");
  git(["add", "."], source);
  git(["commit", "-qm", "feature"], source);
  const branchTip = git(["rev-parse", "HEAD"], source).trim();
  git(["checkout", "-q", "main"], source);
  writeFileSync(join(source, "feature.txt"), "feature\n");
  git(["add", "."], source);
  git(["commit", "-qm", "feature (squashed)"], source);
  git(["push", "-q", "origin", "main"], source);
  git(["checkout", "-q", taskBranch(7)], source);

  assert.deepEqual(rebaseOntoMain(source), { ok: true });
  assert.notEqual(git(["rev-parse", "HEAD"], source).trim(), branchTip);
  assert.equal(git(["rev-parse", "HEAD"], source).trim(), git(["rev-parse", "origin/main"], source).trim());
  rmSync(root, { recursive: true, force: true });
});

test("rebaseOntoMain reports a real conflict instead of throwing, and leaves no rebase in progress", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "shared.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "main"], source);

  git(["checkout", "-qb", taskBranch(8)], source);
  writeFileSync(join(source, "shared.txt"), "branch's version\n");
  git(["add", "."], source);
  git(["commit", "-qm", "branch change"], source);
  git(["checkout", "-q", "main"], source);
  writeFileSync(join(source, "shared.txt"), "main's version\n");
  git(["add", "."], source);
  git(["commit", "-qm", "main change"], source);
  git(["push", "-q", "origin", "main"], source);
  git(["checkout", "-q", taskBranch(8)], source);

  const result = rebaseOntoMain(source);
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(source, ".git", "rebase-merge")), false, "the failed rebase should have been aborted");
  rmSync(root, { recursive: true, force: true });
});

// my-moments' default branch is `master`, not `main` - every
// homelab repo happens to use `main`, which is how this went unnoticed until
// a non-homelab project's tasks failed every attempt on
// "fatal: couldn't find remote ref main".
test("ensureTaskClone follows a repo's real default branch instead of assuming main", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const tasks = join(root, "tasks");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "master", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "master", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "master"], source);

  const dest = ensureTaskClone({ taskId: 51, repoSlug: "source", sourceRepo: source, branch: taskBranch(51), root: tasks });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dest).trim(), taskBranch(51));
  assert.ok(existsSync(join(dest, "README.md")));
  rmSync(root, { recursive: true, force: true });
});

// Found live (a past task, the same incident the stale-ref test below covers):
// resolveDefaultBranch used to read the *clone's own* inherited
// refs/remotes/origin/HEAD, which just mirrors whatever branch the shared
// workspace checkout happened to have checked out at the moment this
// task's clone was cut - not the repo's real default branch. The shared
// pinboard checkout was on `task-174` for a few minutes while a past task's
// workdir got re-cloned after an earlier rebase conflict, which poisoned
// that clone with "task-174" as its "default branch" - dormant for 11
// hours, until a later rebase tried to fetch the long-merged task-174 and
// failed, which the rebase-failure fallback read as a real conflict and
// deleted the retained workdir over, taking a real fix that existed
// nowhere else with it. Asking the real remote (ls-remote) instead of
// reading a local symref is immune to this regardless of what either
// checkout has checked out.
test("ensureTaskClone resolves the real default branch even when the shared workspace checkout is on some other branch", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const tasks = join(root, "tasks");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "main"], source);

  // The shared workspace checkout, mid-clone, has some unrelated task's own
  // branch checked out - exactly what task-174 was doing to the pinboard
  // checkout live.
  git(["checkout", "-qb", "task-174"], source);

  const dest = ensureTaskClone({ taskId: 164, repoSlug: "source", sourceRepo: source, branch: taskBranch(164), root: tasks });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dest).trim(), taskBranch(164));
  assert.equal(resolveDefaultBranch(dest), "main");
  rmSync(root, { recursive: true, force: true });
});

// this reproduces the exact live failure - "! [rejected] ...
// (stale info)" - a rework attempt hit after its first PR on this branch was
// squash-merged with --delete-branch, leaving the clone's local
// refs/remotes/origin/<branch> pointing at a remote branch that no longer
// existed. Without passing `branch` through to rebaseOntoMain (so it can
// refresh/prune that ref), the force-with-lease push below fails exactly as
// it did live; with it, the same push succeeds.
test("rebaseOntoMain refreshes a task branch deleted on the remote so a later force-with-lease push does not see it as stale", () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  mkdirSync(remote, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], remote);
  mkdirSync(source, { recursive: true });
  git(["init", "-q", "-b", "main", "."], source);
  git(["config", "user.email", "test@example.com"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  writeFileSync(join(source, "README.md"), "# source\n");
  git(["add", "."], source);
  git(["commit", "-qm", "initial"], source);
  git(["push", "-q", "-u", "origin", "main"], source);

  // First pass: the task's branch is pushed, its PR opens, and (squash-)
  // merges - which, with --delete-branch, removes it from the remote.
  const branch = taskBranch(164);
  git(["checkout", "-qb", branch], source);
  writeFileSync(join(source, "feature.txt"), "first pass\n");
  git(["add", "."], source);
  git(["commit", "-qm", "first pass"], source);
  git(["push", "-q", "-u", "origin", branch], source);
  writeFileSync(join(source, "feature.txt"), "first pass (squashed)\n");
  git(["add", "."], source);
  git(["commit", "-qm", "first pass (squashed)"], source);
  git(["push", "-q", "origin", `HEAD:main`], source);
  git(["push", "-q", "origin", "--delete", branch], source);
  git(["checkout", "-q", branch], source);

  // Second pass (a rework attempt on the same retained clone): a real,
  // committed fix on top, with this clone's own refs/remotes/origin/<branch>
  // still pointing at the now-deleted remote branch's old tip.
  writeFileSync(join(source, "feature.txt"), "rework fix\n");
  git(["add", "."], source);
  git(["commit", "-qm", "rework fix"], source);

  assert.deepEqual(rebaseOntoMain(source, branch), { ok: true });
  assert.doesNotThrow(() => git(["push", "-u", "--force-with-lease", "origin", branch], source));
  rmSync(root, { recursive: true, force: true });
});

test("isStaleLock treats a missing, dead-holder or over-aged lock as stale", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const alive = () => true;
  const dead = () => false;
  const fresh = {
    info: { pid: 1234, taskId: 7, startedAt: "2026-09-17T11:55:00Z" },
    createdAtMs: Date.parse("2026-09-17T11:55:00Z"),
  };

  assert.equal(isStaleLock(null, now, alive), true);
  assert.equal(isStaleLock(fresh, now, alive), false);
  assert.equal(isStaleLock(fresh, now, dead), true);
  assert.equal(isStaleLock({ ...fresh, createdAtMs: Date.parse("2026-09-17T11:00:00Z") }, now, alive), true);
});

// The window this exists to close: a lock directory created microseconds ago,
// whose holder is still writing its own details into it. Reading that as a
// broken lock and taking it over would put two deploys of one service on the
// same LXC at once, which is the only thing this lock prevents.
test("isStaleLock leaves a just-created lock alone while its holder file is still being written", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const justCreated = { info: null, createdAtMs: now - 5 };
  assert.equal(isStaleLock(justCreated, now, () => true), false);
  // ...but one that never gained a holder file still ages out normally.
  assert.equal(isStaleLock({ info: null, createdAtMs: now - 60 * 60 * 1000 }, now, () => true), true);
});

test("withDeployLock serialises two deploys of the same repo and releases afterwards", async () => {
  const root = scratch();
  const order: string[] = [];
  let firstHolds: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => {
    firstHolds = resolve;
  });

  const first = withDeployLock(
    "pinboard",
    1,
    async () => {
      order.push("first-start");
      await firstReleased;
      order.push("first-end");
      return "a";
    },
    { root, pollMs: 10 },
  );

  // Give the first call time to take the lock before the second asks for it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(deployLockPath("pinboard", root)));

  const second = withDeployLock(
    "pinboard",
    2,
    async () => {
      order.push("second-start");
      return "b";
    },
    { root, pollMs: 10 },
  );

  firstHolds?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.deepEqual(firstResult, { ran: true, value: "a" });
  assert.deepEqual(secondResult, { ran: true, value: "b" });
  assert.equal(existsSync(deployLockPath("pinboard", root)), false);
  rmSync(root, { recursive: true, force: true });
});

test("withDeployLock gives up rather than deploying on top of a live holder", async () => {
  const root = scratch();
  let ran = false;
  const held = withDeployLock("glance", 1, () => new Promise<void>(() => {}), { root, pollMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = await withDeployLock(
    "glance",
    2,
    async () => {
      ran = true;
    },
    { root, waitMs: 30, pollMs: 10 },
  );

  assert.equal(ran, false);
  assert.equal(result.ran, false);
  assert.equal(result.ran === false && result.heldBy?.taskId, 1);
  void held;
  rmSync(root, { recursive: true, force: true });
});

test("withDeployLock takes over a lock whose holder is gone", async () => {
  const root = scratch();
  mkdirSync(deployLockPath("keep", root), { recursive: true });
  // pid 2**22 is above Linux's default pid_max, so it can never be live.
  writeFileSync(
    join(deployLockPath("keep", root), "holder.json"),
    JSON.stringify({ pid: 4194304, taskId: 99, startedAt: new Date().toISOString() }),
  );

  const result = await withDeployLock("keep", 5, async () => "deployed", { root, waitMs: 50, pollMs: 10 });
  assert.deepEqual(result, { ran: true, value: "deployed" });
  rmSync(root, { recursive: true, force: true });
});

test("isSweepable keeps a live task's workdir until it is finished or aged out", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const retention = 3 * 24 * 60 * 60 * 1000;
  const fresh = "2026-09-17T11:00:00Z";
  const old = "2026-09-10T11:00:00Z";

  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention), false);
  assert.equal(isSweepable({ status: "rework", updatedAt: fresh }, now, retention), false);
  assert.equal(isSweepable({ status: "done", updatedAt: fresh }, now, retention), true);
  assert.equal(isSweepable({ status: "rejected", updatedAt: fresh }, now, retention), true);
  assert.equal(isSweepable({ status: "review", updatedAt: old }, now, retention), true);
});

test("isSweepable removes a review task's workdir once every PR is merged, and nothing else early", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const retention = 3 * 24 * 60 * 60 * 1000;
  const fresh = "2026-09-17T11:00:00Z";
  const merged = [{ state: "merged" }, { state: "merged" }];

  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention, merged), true);
  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention, [{ state: "merged" }, { state: "open" }]), false);
  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention, [{ state: "closed" }]), false);
  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention, []), false);
  assert.equal(isSweepable({ status: "review", updatedAt: fresh }, now, retention, undefined), false);
  for (const status of ["queued", "in_progress", "rework", "awaiting_ci", "awaiting_merge", "deploying", "verifying"]) {
    assert.equal(isSweepable({ status, updatedAt: fresh }, now, retention, merged), false, status);
  }
});

test("pruneTrustedWorkdirs drops only task-root entries whose directory is gone", () => {
  const root = scratch();
  const tasks = join(root, "tasks");
  const live = join(tasks, "task-1", "repos", "pinboard");
  mkdirSync(live, { recursive: true });

  const configPath = join(root, ".claude.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      projects: {
        [live]: { hasTrustDialogAccepted: true },
        [join(tasks, "task-2", "repos", "pinboard")]: { hasTrustDialogAccepted: true },
        "/home/marek/projects/my-org/pinboard": { hasTrustDialogAccepted: true },
      },
    }),
  );

  assert.equal(pruneTrustedWorkdirs(configPath, tasks), 1);
  const after = JSON.parse(readFileSync(configPath, "utf8")).projects as Record<string, unknown>;
  assert.deepEqual(Object.keys(after).sort(), [live, "/home/marek/projects/my-org/pinboard"].sort());
  rmSync(root, { recursive: true, force: true });
});

test("isSweepable never ages out a task that may still run in its checkout", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const retention = 3 * 24 * 60 * 60 * 1000;
  const old = "2026-09-10T11:00:00Z";
  for (const status of ["queued", "executing", "needs_input", "rework", "awaiting_ci", "deploying"]) {
    assert.equal(isSweepable({ status, updatedAt: old }, now, retention), false, status);
  }
  assert.equal(isSweepable({ status: "handoff", updatedAt: old }, now, retention), true);
});

test("branchSlug lowercases, folds accents and turns punctuation into word breaks", () => {
  assert.equal(branchSlug("Add: player launcher!"), "add-player-launcher");
  assert.equal(branchSlug("  Fix   the (CI) -- timeout... "), "fix-the-ci-timeout");
  assert.equal(branchSlug("Príliš žluťoučký kůň"), "prilis-zlutoucky-kun");
  assert.equal(branchSlug("Ünïcödé 日本語 emoji 🚀 ok"), "unicode-emoji-ok");
});

test("branchSlug keeps at most 5 words and 40 chars, with no trailing hyphen", () => {
  assert.equal(branchSlug("one two three four five six seven"), "one-two-three-four-five");
  const long = branchSlug("Reconcile the deployment orchestration pipeline's retries");
  assert.ok(long.length <= 40, long);
  assert.equal(long, "reconcile-the-deployment-orchestration");
  assert.doesNotMatch(long, /-$/);
  assert.equal(branchSlug("a".repeat(60)), "a".repeat(40));
});

test("branchSlug of a title with nothing usable is empty", () => {
  assert.equal(branchSlug(""), "");
  assert.equal(branchSlug("!!! ??? 日本語"), "");
});

test("proposedTaskBranch: public repos get the slug only, private ones <id>-<slug>", () => {
  assert.equal(proposedTaskBranch(832, "Add player launcher", true), "add-player-launcher");
  assert.equal(proposedTaskBranch(832, "Add player launcher", false), "832-add-player-launcher");
  assert.equal(proposedTaskBranch(832, "???", false), taskBranch(832));
  assert.equal(proposedTaskBranch(832, "???", true), "change");
});

test("withCollisionSuffix appends -2, -3, ... until the name is free", () => {
  assert.equal(withCollisionSuffix("fix-ci", () => false), "fix-ci");
  const taken = new Set(["fix-ci", "fix-ci-2"]);
  assert.equal(withCollisionSuffix("fix-ci", (n) => taken.has(n)), "fix-ci-3");
  assert.throws(() => withCollisionSuffix("fix-ci", () => true, 3), /no free branch name/);
});

test("chooseTaskBranch reuses a recorded or cloned branch before deriving one", () => {
  const base = { taskId: 9, title: "Renamed title", isPublic: true, taken: () => false };
  assert.equal(chooseTaskBranch({ ...base, recorded: "original-title", cloneBranch: "other" }), "original-title");
  assert.equal(chooseTaskBranch({ ...base, recorded: null, cloneBranch: "original-title" }), "original-title");
  assert.equal(chooseTaskBranch({ ...base, recorded: "task-9", cloneBranch: null }), "task-9");
  assert.equal(chooseTaskBranch({ ...base, recorded: null, cloneBranch: null }), "renamed-title");
  assert.equal(
    chooseTaskBranch({ ...base, recorded: null, cloneBranch: null, taken: (n) => n === "renamed-title" }),
    "renamed-title-2",
  );
  // a private name has the id in it, so it cannot collide with another task's
  assert.equal(chooseTaskBranch({ ...base, isPublic: false, recorded: null, cloneBranch: null, taken: () => true }), "9-renamed-title");
});

test("a later attempt reads the branch back from the clone instead of the title", () => {
  const root = mkdtempSync(join(tmpdir(), "branch-reuse-"));
  const git = (args: string[], cwd: string): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();
  try {
    const source = join(root, "source");
    mkdirSync(source);
    git(["init", "-q", "-b", "main"], source);
    writeFileSync(join(source, "f.txt"), "x\n");
    git(["add", "f.txt"], source);
    git(["commit", "-qm", "base"], source);
    const tasks = join(root, "tasks");
    const first = proposedTaskBranch(77, "Add player launcher", true);
    const dest = ensureTaskClone({ taskId: 77, repoSlug: "source", sourceRepo: source, branch: first, root: tasks });
    assert.equal(currentBranch(dest), "add-player-launcher");
    assert.equal(taskWorkdirBranch(77, tasks), "add-player-launcher");
    const again = chooseTaskBranch({
      taskId: 77,
      title: "Add a game launcher instead",
      recorded: null,
      cloneBranch: currentBranch(dest),
      isPublic: true,
      // its own branch being on origin is not a collision when it is read back
      taken: () => true,
    });
    assert.equal(again, first);
    assert.equal(currentBranch(join(root, "missing")), null);
    assert.equal(taskWorkdirBranch(78, tasks), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
