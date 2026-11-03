// `work playtest`: one local branch with every open review PR of a project
// merged in, so the operator can build and play everything in review at once.
// Runs git in the caller's cwd (a clone of the project's repo, possibly on
// Windows through the `work` shim), so it never assumes where the repo lives.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Handoff, Project, PullRequest, Task } from "./pinboard.js";
import { resolveDefaultBranch } from "./workdir.js";

export interface PlaytestDeps {
  listTasks(projectId: number): Promise<Task[]>;
  listPullRequests(taskId: number): Promise<PullRequest[]>;
  getTaskHandoffs(taskId: number): Promise<Handoff[]>;
}

export interface PlaytestEntry {
  taskId: number;
  title: string;
  prUrl: string;
  branch: string;
  // the review task whose PR this one is stacked on, when that task is
  // also in this playtest
  parentTaskId: number | null;
  checklist: string[];
}

export interface PlaytestSkip {
  taskId: number;
  title: string;
  prUrl: string | null;
  reason: string;
}

export interface PlaytestOptions {
  cwd: string;
  push?: boolean;
  dryRun?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface PlaytestResult {
  branch: string;
  included: PlaytestEntry[];
  skipped: PlaytestSkip[];
  // branches merged, in order
  merged: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

// Leaves to merge, in order: stacks first (by their root's task id), then
// independent PRs (by task id). A stacked PR's head already contains its
// ancestors, so only a stack's leaves are merged.
export function mergeOrder(entries: PlaytestEntry[]): PlaytestEntry[] {
  const byId = new Map(entries.map((e) => [e.taskId, e]));
  const hasChild = new Set(entries.map((e) => e.parentTaskId).filter((id): id is number => id !== null && byId.has(id)));
  const rootOf = (e: PlaytestEntry): number => {
    const seen = new Set<number>();
    let cur = e;
    while (cur.parentTaskId !== null && byId.has(cur.parentTaskId) && !seen.has(cur.taskId)) {
      seen.add(cur.taskId);
      cur = byId.get(cur.parentTaskId) as PlaytestEntry;
    }
    return cur.taskId;
  };
  const leaves = entries.filter((e) => !hasChild.has(e.taskId));
  const stacked = (e: PlaytestEntry) => e.parentTaskId !== null && byId.has(e.parentTaskId);
  return leaves.sort((a, b) => {
    if (stacked(a) !== stacked(b)) return stacked(a) ? -1 : 1;
    return rootOf(a) - rootOf(b) || a.taskId - b.taskId;
  });
}

// playtest/<yyyymmdd>-<n> with the next n not taken locally or on origin.
export function nextBranchName(existing: string[], now: Date): string {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`playtest/${day}-${n}`)) n++;
  return `playtest/${day}-${n}`;
}

async function collect(
  project: Project,
  deps: PlaytestDeps,
): Promise<{ entries: PlaytestEntry[]; skipped: PlaytestSkip[] }> {
  if (!project.localPath) throw new Error(`project '${project.slug}' has no localPath, so its PRs can't be matched to a repo`);
  const repoSlug = basename(project.localPath);
  const tasks = (await deps.listTasks(project.id)).filter((t) => t.status === "review").sort((a, b) => a.id - b.id);
  const entries: PlaytestEntry[] = [];
  const skipped: PlaytestSkip[] = [];
  for (const task of tasks) {
    const pr = (await deps.listPullRequests(task.id))
      .filter((p) => p.state === "open" && p.repoSlug === repoSlug && p.branchName)
      .sort((a, b) => b.id - a.id)[0];
    if (!pr) {
      skipped.push({ taskId: task.id, title: task.title, prUrl: null, reason: `no open PR in ${repoSlug}` });
      continue;
    }
    const handoffs = await deps.getTaskHandoffs(task.id);
    const latest = [...handoffs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .find((h) => Array.isArray(h.checklist) && h.checklist.length > 0);
    entries.push({
      taskId: task.id,
      title: task.title,
      prUrl: pr.url,
      branch: pr.branchName as string,
      // from the PR row, not task.stackOn: the task list doesn't compute that.
      parentTaskId: pr.stackedOnTaskId ?? null,
      checklist: latest?.checklist ?? [],
    });
  }
  // a parent outside this playtest is not a stack link here
  const ids = new Set(entries.map((e) => e.taskId));
  for (const e of entries) if (e.parentTaskId !== null && !ids.has(e.parentTaskId)) e.parentTaskId = null;
  return { entries, skipped };
}

export async function runPlaytest(project: Project, deps: PlaytestDeps, opts: PlaytestOptions): Promise<PlaytestResult> {
  const { cwd } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!gitOk(cwd, ["rev-parse", "--is-inside-work-tree"])) throw new Error(`${cwd} is not a git checkout`);
  if (git(cwd, ["status", "--porcelain"]).trim()) {
    throw new Error("worktree has uncommitted changes; commit them before a playtest");
  }

  const { entries, skipped } = await collect(project, deps);
  const defaultBranch = resolveDefaultBranch(cwd);
  if (!opts.dryRun) git(cwd, ["fetch", "--prune", "origin"]);

  const refs = git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/playtest/", "refs/remotes/origin/playtest/"])
    .split("\n")
    .filter(Boolean)
    .map((r) => r.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, ""));
  const branch = nextBranchName(refs, opts.now ?? new Date());

  const byId = new Map(entries.map((e) => [e.taskId, e]));
  const order = mergeOrder(entries);
  const merged: string[] = [];
  const included = new Set<number>();
  const failed = new Set<number>();
  // a conflicting leaf falls back to its parent, so the rest of the stack
  // still gets in
  const queue = [...order];

  if (opts.dryRun) {
    log(`dry run: would create ${branch} from origin/${defaultBranch} and merge, in order:`);
    for (const e of order) log(`  ${e.branch}  (#${e.taskId}${stackLabel(e, byId)})`);
  } else {
    git(cwd, ["checkout", "-b", branch, `origin/${defaultBranch}`]);
    while (queue.length) {
      const e = queue.shift() as PlaytestEntry;
      if (included.has(e.taskId) || failed.has(e.taskId)) continue;
      const ref = `origin/${e.branch}`;
      const fallback = () => {
        const parent = e.parentTaskId !== null ? byId.get(e.parentTaskId) : undefined;
        if (parent && !included.has(parent.taskId)) queue.unshift(parent);
      };
      if (!gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
        failed.add(e.taskId);
        skipped.push({ taskId: e.taskId, title: e.title, prUrl: e.prUrl, reason: `branch ${e.branch} not on origin` });
        fallback();
        continue;
      }
      if (!gitOk(cwd, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${e.branch} for playtest`, ref])) {
        gitOk(cwd, ["merge", "--abort"]);
        failed.add(e.taskId);
        skipped.push({ taskId: e.taskId, title: e.title, prUrl: e.prUrl, reason: `merge conflict with ${branch}` });
        fallback();
        continue;
      }
      merged.push(e.branch);
      for (let cur: PlaytestEntry | undefined = e; cur && !included.has(cur.taskId); cur = byId.get(cur.parentTaskId ?? NaN)) {
        included.add(cur.taskId);
      }
    }
    if (opts.push) git(cwd, ["push", "-u", "origin", branch]);
  }

  const includedEntries = opts.dryRun ? entries : entries.filter((e) => included.has(e.taskId));
  printSummary(log, branch, includedEntries, skipped, opts);
  return { branch, included: includedEntries, skipped, merged };
}

function stackLabel(e: PlaytestEntry, byId: Map<number, PlaytestEntry>): string {
  const chain: number[] = [];
  for (let cur = byId.get(e.parentTaskId ?? NaN); cur && !chain.includes(cur.taskId); cur = byId.get(cur.parentTaskId ?? NaN)) {
    chain.push(cur.taskId);
  }
  return chain.length ? `, includes ${chain.map((id) => `#${id}`).join(", ")}` : "";
}

function printSummary(
  log: (line: string) => void,
  branch: string,
  included: PlaytestEntry[],
  skipped: PlaytestSkip[],
  opts: PlaytestOptions,
): void {
  log("");
  const where = opts.dryRun ? "(dry run, git untouched)" : opts.push ? "(pushed to origin)" : "(local only)";
  log(`${branch} ${where}`);
  log(`Included (${included.length}):`);
  for (const e of included) {
    log(`  #${e.taskId} ${e.title}`);
    log(`    ${e.prUrl}`);
    for (const item of e.checklist) log(`    [ ] ${item}`);
  }
  if (skipped.length) {
    log(`Skipped (${skipped.length}):`);
    for (const s of skipped) log(`  #${s.taskId} ${s.title}: ${s.reason}${s.prUrl ? ` (${s.prUrl})` : ""}`);
  }
}
