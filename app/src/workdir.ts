// one workdir per task, replacing the shared-repo git worktrees
// runner.ts used to create at <repo>/.claude/worktrees/<name>.
//
// Why the change: a worktree lives inside the one workspace checkout of that
// repo, which is why pinboard's governor had to refuse two tasks on the same
// repo at claim time - they would have been writing into the same directory
// tree. With two Claude seats drawing from one backlog that rule idled a seat
// far more often than it protected anything. A task's own clone shares
// nothing, so the rule goes away (the remaining real conflict, two deploys of
// one service racing on its LXC, is handled by withDeployLock below instead).
//
// Why under /app rather than ~/tasks: every other service in this homelab
// keeps its whole state in /app on its own LXC, which is what makes an LXC
// rebuildable. foreman has drifted from that (a second workspace clone in
// ~/projects, ~/.local-node, ~/.claude, systemd --user units, a sudoers
// drop-in), and task workdirs are new state, so they get placed the way the
// rest should eventually be - see a past task. /app/tasks is created
// 2775 marek by scripts/deploy.sh because the second license spawns runs as
// the `peter` Linux user and /app itself is 0755 marek.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TASK_ROOT = process.env.WORK_TASK_ROOT ?? "/app/tasks";

// Shared parent directories are created group-writable and setgid so both
// seats' Linux users (marek's dispatcher and peter's sudo-spawned runs, both
// in group `marek`) can create and clean up inside them.
const SHARED_DIR_MODE = 0o2775;

// mkdir(2) masks its mode argument with the calling process's umask, and both
// systemd units run under systemd's default 0022 - which silently strips
// exactly the group-write bit these directories exist to have (the setgid bit
// survives, so the symptom would be a confusing half-right mode). chmod is not
// masked, so set it explicitly afterwards. Only the owner may chmod, so a
// directory another seat created first is left as whoever created it set it.
function ensureSharedDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: SHARED_DIR_MODE });
  try {
    chmodSync(path, SHARED_DIR_MODE);
  } catch {
    // not ours to chmod - it was created by the other seat's user, already
    // with this same mode
  }
}

export function taskWorkdir(taskId: number, root: string = TASK_ROOT): string {
  return join(root, `task-${taskId}`);
}

export function repoWorkdir(taskId: number, repoSlug: string, root: string = TASK_ROOT): string {
  return join(taskWorkdir(taskId, root), "repos", repoSlug);
}

// One branch name per task, not per attempt - a later attempt resumes the
// same clone and keeps committing on it, exactly as the worktree scheme's
// `worktree-task-<id>-session` did.
export function taskBranch(taskId: number): string {
  return `task-${taskId}`;
}

export function parseTaskWorkdirName(name: string): number | null {
  const match = /^task-(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

export function listTaskWorkdirIds(root: string = TASK_ROOT): number[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(parseTaskWorkdirName)
    .filter((id): id is number => id !== null);
}

// Every directory in the repo holding its own package-lock.json - pinboard
// has app/ and app/pwa/, most repos have one or none. Bounded depth and no
// descent into node_modules so this stays a cheap scan of a fresh checkout.
export function packageDirs(repoRoot: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(join(dir, "package-lock.json"))) found.push(dir);
    if (depth >= maxDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  if (existsSync(repoRoot)) walk(repoRoot, 0);
  return found;
}

// Pure decision half of seedNodeModules, so the rule is unit-testable without
// a filesystem: copy the workspace checkout's installed dependencies only
// when its lockfile is byte-identical to the clone's, and only into a clone
// that has none yet. A mismatch is not an error - the agent's own `npm ci`
// handles it - it just means this shortcut does not apply.
export function shouldSeedNodeModules(
  source: { lock: string | null; hasModules: boolean },
  target: { lock: string | null; hasModules: boolean },
): boolean {
  if (!source.hasModules || target.hasModules) return false;
  if (source.lock === null || target.lock === null) return false;
  return source.lock === target.lock;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Deliberately `cp -a` (a real copy), never `cp -al` (hardlinks). Hardlinks
// would be near-free on disk, but any tool that rewrites a file in place
// rather than replacing it would then corrupt the workspace checkout's own
// node_modules through the link - a failure that would surface far away from
// whatever caused it.
export function seedNodeModules(sourceRepo: string, cloneRepo: string): string[] {
  const seeded: string[] = [];
  for (const sourceDir of packageDirs(sourceRepo)) {
    const relative = sourceDir.slice(sourceRepo.length + 1);
    const targetDir = relative ? join(cloneRepo, relative) : cloneRepo;
    const decision = shouldSeedNodeModules(
      { lock: readIfPresent(join(sourceDir, "package-lock.json")), hasModules: existsSync(join(sourceDir, "node_modules")) },
      { lock: readIfPresent(join(targetDir, "package-lock.json")), hasModules: existsSync(join(targetDir, "node_modules")) },
    );
    if (!decision) continue;
    try {
      execFileSync("cp", ["-a", join(sourceDir, "node_modules"), join(targetDir, "node_modules")], { stdio: "pipe" });
      seeded.push(targetDir);
    } catch (err) {
      // A cold `npm ci` still works, so a failed copy is worth reporting but
      // never worth failing the attempt over.
      console.error(`could not seed node_modules into ${targetDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return seeded;
}

function originUrl(repoPath: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoPath, stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

export interface CloneOptions {
  taskId: number;
  repoSlug: string;
  // The workspace checkout this repo is cloned from - the single fetch point,
  // so a clone costs no network.
  sourceRepo: string;
  branch: string;
  root?: string;
}

// Not every project's default branch is named `main` - my-moments (and
// presumably other repos outside the homelab org) uses `master`.
//
// Found live: this used to read the local refs/remotes/origin/HEAD symref
// instead of asking origin directly, on the theory that `git clone` carries
// the source's HEAD over for free. That is true, but "the source" is the
// *shared* workspace checkout (~/projects/<org>/<repo>), and what a
// local clone actually inherits is whichever branch that shared checkout
// happened to have checked out at the exact moment this task's own clone
// was cut - not the repo's real default branch. A human/agent had that
// shared pinboard checkout on `task-174` for a few minutes on 2026-09-17
// while a past task's workdir was being re-cloned after an earlier rebase
// conflict; the clone silently inherited `task-174` as its "default branch"
// and carried it, dormant, for the next 11 hours, until this function
// started being consulted and a fetch of the long-since-merged `task-174`
// failed - which the caller (rebaseOntoMain's caller in runner.ts) reads as
// a rebase conflict and responds to by deleting the retained workdir. That
// destroyed the one on-disk copy of a real, already-committed fix that had
// never been pushed anywhere (see the runner.ts and pipeline.ts commit this
// comment shipped alongside).
//
// Asking origin itself is the only value that cannot be poisoned this way -
// `git ls-remote --symref` queries the actual remote's HEAD live, the same
// thing `gh repo view --json defaultBranchRef` would report, immune to
// whatever any local checkout (this clone's or the shared workspace's) is
// doing at the time. `origin` is guaranteed to point at the real remote by
// the time every caller of this function runs (ensureTaskClone calls it only
// after `remote set-url`).
export function resolveDefaultBranch(repoPath: string): string {
  try {
    const out = execFileSync("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: repoPath, stdio: "pipe" }).toString();
    const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (match) return match[1];
  } catch {
    // origin unreachable, or not a real remote (e.g. a test fixture with no
    // origin at all) - fall through to the default below.
  }
  return "main";
}

// Creates the task's own clone of one repo, on its own branch, based on the
// repo's own default branch (usually origin/main, see resolveDefaultBranch).
// Idempotent: an existing clone (a resumed attempt, or a second repo target
// in the same run) is left exactly as it is.
//
// The branch is cut from the default branch rather than the source
// checkout's local one on purpose: the workspace clone is only fetched when
// something happens to pull it, so its default branch can be days behind.
// The old worktree path cut from the local branch and then relied on
// prepareAttempt's rebase to notice.
export function ensureTaskClone(opts: CloneOptions): string {
  const dest = repoWorkdir(opts.taskId, opts.repoSlug, opts.root ?? TASK_ROOT);
  if (existsSync(dest)) return dest;

  ensureSharedDir(taskWorkdir(opts.taskId, opts.root ?? TASK_ROOT));
  ensureSharedDir(join(taskWorkdir(opts.taskId, opts.root ?? TASK_ROOT), "repos"));
  // --no-hardlinks is required, not an optimisation to skip. `git clone
  // --local` hardlinks the source's objects by default, and this workspace
  // clone is shared by two operators, so some of its objects are owned by the
  // other user and mode 444 - which `fs.protected_hardlinks` (on by default)
  // forbids linking, since the linker neither owns them nor can write them.
  // Found live: 51 of pinboard's objects belong to `peter`, and the clone
  // died on the first one with "failed to create link: Operation not
  // permitted". Copying the objects instead costs a few MB per repo, against
  // the hundreds already spent copying node_modules.
  execFileSync("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", opts.sourceRepo, dest], { stdio: "pipe" });

  const remote = originUrl(opts.sourceRepo);
  // resolveDefaultBranch must run after origin is repointed at the real
  // remote (below), not before: it asks *origin* for its HEAD, and right
  // after `git clone --local` that still means the shared workspace
  // checkout's own currently-checked-out branch, not the repo's real
  // default branch - see resolveDefaultBranch's own comment for what that
  // ambiguity cost live.
  if (remote) execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: dest, stdio: "pipe" });
  const defaultBranch = resolveDefaultBranch(dest);
  if (remote) execFileSync("git", ["fetch", "origin", defaultBranch], { cwd: dest, stdio: "pipe" });
  // the branch usually does not exist on the remote yet, and is
  // cut from the default branch. It DOES exist when a task is handed back for
  // repair after its workdir was swept (or after `fresh` was forced by a
  // rebase conflict): the PR's own commits are only on the remote branch
  // then, so cutting from the default branch again would lose them and the
  // later `push --force-with-lease` would quietly overwrite the PR with a
  // branch that no longer contains its work. Check out the remote branch
  // instead when there is one.
  const base = remote && remoteBranchExists(dest, opts.branch) ? `origin/${opts.branch}` : `origin/${defaultBranch}`;
  if (base !== `origin/${defaultBranch}`) execFileSync("git", ["fetch", "origin", opts.branch], { cwd: dest, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", opts.branch, base], { cwd: dest, stdio: "pipe" });
  seedNodeModules(opts.sourceRepo, dest);
  return dest;
}

// Whether `origin` already has this branch. Any git failure reads as "no
// remote branch": the caller's fallback (cut from origin/main) is what a
// clone did before this check existed, so a `ls-remote` blip degrades to the
// old behaviour rather than failing the clone.
export function remoteBranchExists(repoPath: string, branch: string): boolean {
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin", branch], { cwd: repoPath, stdio: "pipe" })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Refreshes this repo's local view of one remote branch, so a later
// `push --force-with-lease` compares against the real current state instead
// of whatever this clone last happened to see.
//
// Found live: a rework attempt rebased its retained workdir onto
// main (below), then, much later, force-pushed the already-committed fix -
// and got "! [rejected] ... (stale info)". The task's own `origin/<branch>`
// remote-tracking ref here was stale - most likely because the first PR on
// this branch had already been squash-merged with `--delete-branch` (see
// pipeline.ts's handleAwaitingMerge), so the branch no longer existed on the
// remote at all, but this clone's cached ref still pointed at its old,
// pre-squash tip. `--force-with-lease`'s implicit lease is exactly that
// cached ref, so it refused a push that was otherwise completely safe (the
// PR it belonged to was already merged, so nothing on the branch could be
// lost). The fix's own commits sat correct and complete in the local clone
// the whole time; they just never reached GitHub, and because nothing
// wrapped this push in a try/catch, the failure never even reached a task
// comment - only this dispatcher's own systemd journal saw it.
function refreshRemoteBranch(repoPath: string, branch: string): void {
  try {
    execFileSync("git", ["fetch", "origin", branch], { cwd: repoPath, stdio: "pipe" });
  } catch {
    // Most likely the branch does not exist on the remote (deleted after an
    // earlier squash-merge, or never pushed at all) - drop the now-dangling
    // local tracking ref so a following --force-with-lease push treats this
    // as creating a fresh branch rather than refusing it as stale against a
    // remote state that no longer exists.
    try {
      execFileSync("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`], { cwd: repoPath, stdio: "pipe" });
    } catch {
      // no local tracking ref to remove - fine
    }
  }
}

// Rebases one checkout onto its default branch (see resolveDefaultBranch).
// Any git failure (most commonly a real rebase conflict) is reported rather
// than thrown, so the caller can decide what to do with it - runner.ts's
// prepareAttempt falls back to a fresh attempt, pipeline.ts's merge stage
// hands the task back to an agent.
//
// `branch`, when given, is the task's own branch that a caller intends to
// `push --force-with-lease` afterwards - see refreshRemoteBranch above for
// why that needs refreshing here rather than left to go stale.
//
// A past task moved this here from runner.ts: the pipeline poller needs the
// same rebase to clear a merge conflict without spending an agent run, and
// importing runner.ts (the dispatcher, the claude spawn, the whole attempt
// loop) into the poller for one git helper would be the wrong direction.
export function rebaseOntoMain(path: string, branch?: string): { ok: true } | { ok: false; error: string } {
  try {
    const defaultBranch = resolveDefaultBranch(path);
    execFileSync("git", ["fetch", "origin", defaultBranch], { cwd: path, stdio: "pipe" });
    if (branch) refreshRemoteBranch(path, branch);
    // --empty=drop: the pipeline squash-merges (gh pr merge --squash), which
    // gives the default branch a single commit with a different hash than
    // this branch's original commits even though the diff is identical -
    // without this flag, a post-review resume would hit "previous commit is
    // now empty" on every one of its own already-landed commits and be
    // treated as a real conflict every time, which would defeat this feature
    // for exactly the case it was built for.
    execFileSync("git", ["rebase", "--empty=drop", `origin/${defaultBranch}`], { cwd: path, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    try {
      execFileSync("git", ["rebase", "--abort"], { cwd: path, stdio: "pipe" });
    } catch {
      // wasn't mid-rebase - fine
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function removeTaskWorkdir(taskId: number, root: string = TASK_ROOT): void {
  // A plain recursive delete is enough here, unlike the worktree scheme's
  // `git worktree remove` plus `git branch -D` dance: nothing outside this
  // directory knows the clone exists, so there is no shared repo left holding
  // a registration or a stranded branch afterwards.
  rmSync(taskWorkdir(taskId, root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deploy lock
//
// A past task removed pinboard's claim-time repo-conflict rule, so two tasks may
// now run and open PRs against one repo at the same time. The one thing that
// genuinely must not overlap is the deploy: two `deploy-service.sh <repo>`
// runs against the same LXC would race each other's containers. This lock
// serialises only that step, and it is a file rather than an in-process mutex
// because a manual `work task run` is a separate process from the dispatcher
// and has to respect the same boundary.

const LOCK_DIR_NAME = ".locks";
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_POLL_MS = 5_000;
const LOCK_WAIT_MS = 20 * 60 * 1000;

export interface DeployLockInfo {
  pid: number;
  taskId: number;
  startedAt: string;
}

// The lock is a *directory*, not a file, because mkdir(2) is the atomic
// create-or-fail primitive here: it either creates the directory or fails
// with EEXIST, with no window in between. A lock file would have to be
// created and then written in two steps, and a second process arriving in
// that window would read an empty file, conclude the lock was corrupt, delete
// it and take it - leaving two deploys of one service running at once, which
// is the exact thing this prevents. The holder's details go in a file inside
// the directory, which may briefly be missing; isStaleLock treats that as a
// live lock someone has just taken, not a broken one.
export function deployLockPath(repoSlug: string, root: string = TASK_ROOT): string {
  return join(root, LOCK_DIR_NAME, `${repoSlug}.deploy.lock`);
}

function lockInfoPath(lockPath: string): string {
  return join(lockPath, "holder.json");
}

export interface DeployLockState {
  info: DeployLockInfo | null;
  // When the lock directory itself was created - the one fact available even
  // while its holder file is still being written.
  createdAtMs: number;
}

// A lock is stale when it has outlived any plausible deploy, or when the
// process that took it is gone. A lock whose holder file has not appeared yet
// is deliberately *not* stale: it was created moments ago by a process still
// writing it.
export function isStaleLock(
  state: DeployLockState | null,
  now: number,
  pidAlive: (pid: number) => boolean,
  staleMs = LOCK_STALE_MS,
): boolean {
  if (!state) return true;
  if (now - state.createdAtMs > staleMs) return true;
  if (!state.info) return false;
  return !pidAlive(state.info.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH is the only "it's gone" answer. EPERM means the process is very
    // much alive but belongs to a Linux user this one may not signal - which
    // is the normal case here, since the two license seats run as different
    // users. Reading EPERM as "dead" would let one seat steal a lock out from
    // under the other seat's running deploy.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): DeployLockState | null {
  let createdAtMs: number;
  try {
    createdAtMs = statSync(path).ctimeMs;
  } catch {
    return null;
  }
  try {
    return { info: JSON.parse(readFileSync(lockInfoPath(path), "utf8")) as DeployLockInfo, createdAtMs };
  } catch {
    return { info: null, createdAtMs };
  }
}

function releaseLock(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function tryAcquire(path: string, taskId: number): boolean {
  ensureSharedDir(dirname(path));
  try {
    mkdirSync(path, { mode: SHARED_DIR_MODE });
  } catch {
    return false;
  }
  writeFileSync(
    lockInfoPath(path),
    JSON.stringify({ pid: process.pid, taskId, startedAt: new Date().toISOString() } satisfies DeployLockInfo),
  );
  return true;
}

// Runs `fn` with this repo's deploy lock held, waiting for whoever holds it.
// Returns null instead of running `fn` if the wait runs out - the caller
// reports that on the task the same way it reports any other deploy failure,
// rather than deploying anyway.
export async function withDeployLock<T>(
  repoSlug: string,
  taskId: number,
  fn: () => Promise<T>,
  opts: { root?: string; waitMs?: number; pollMs?: number } = {},
): Promise<{ ran: true; value: T } | { ran: false; heldBy: DeployLockInfo | null }> {
  const path = deployLockPath(repoSlug, opts.root ?? TASK_ROOT);
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);

  for (;;) {
    if (tryAcquire(path, taskId)) break;
    const state = readLock(path);
    if (isStaleLock(state, Date.now(), processAlive)) {
      releaseLock(path);
      continue;
    }
    if (Date.now() >= deadline) return { ran: false, heldBy: state?.info ?? null };
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? LOCK_POLL_MS));
  }

  try {
    return { ran: true, value: await fn() };
  } finally {
    releaseLock(path);
  }
}

// ---------------------------------------------------------------------------

// A past task's trust patching writes one ~/.claude.json entry per workspace
// path. Under the worktree scheme those were a handful of stable repo paths;
// a per-task clone means a new entry per task per repo, forever. Drop the
// ones whose directory no longer exists so the file does not grow without
// bound - purely housekeeping, and only ever touches paths under the task
// root.
export function pruneTrustedWorkdirs(configPath: string, root: string = TASK_ROOT): number {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return 0;
  }
  const projects = config.projects as Record<string, unknown> | undefined;
  if (!projects) return 0;

  let pruned = 0;
  for (const path of Object.keys(projects)) {
    if (!path.startsWith(root + "/")) continue;
    if (existsSync(path)) continue;
    delete projects[path];
    pruned += 1;
  }
  if (pruned > 0) writeFileSync(configPath, JSON.stringify(config, null, 2));
  return pruned;
}

// Whether a task's workdir may be removed: the same rule the worktree sweep
// used (finished, or untouched for the retention window), kept pure so the
// sweep's decision is testable without a filesystem or a pinboard.
//
// a task in review whose PRs are all merged has nothing left to
// resume in its clone (a rework attempt re-clones from main), so it goes too.
// Only 'review' qualifies: queued/in_progress/rework and the pipeline stages
// may still need the checkout. `prs` is only fetched for review tasks, so
// undefined (or empty, nothing opened yet) keeps the workdir.
//
// the retention window alone never removes a task that may still
// run in its checkout (queued, executing, needs_input, rework, or a pipeline
// stage), so a task parked on an unanswered question keeps its session.
export const PROTECTED_WORKDIR_STATUSES: readonly string[] = [
  "queued",
  "executing",
  "needs_input",
  "rework",
  "awaiting_ci",
  "awaiting_merge",
  "awaiting_review",
  "deploying",
  "verifying",
];

export function isSweepable(
  task: { status: string; updatedAt: string },
  now: number,
  retentionMs: number,
  prs?: { state: string }[],
): boolean {
  if (task.status === "done" || task.status === "rejected") return true;
  if (task.status === "review" && prs && prs.length > 0 && prs.every((pr) => pr.state === "merged")) return true;
  if (PROTECTED_WORKDIR_STATUSES.includes(task.status)) return false;
  return now - new Date(task.updatedAt).getTime() > retentionMs;
}
