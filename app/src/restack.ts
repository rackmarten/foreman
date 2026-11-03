// Keeps stacked PRs (see "Stacked branches" in the README) correct as their
// parents move. A stacked PR's pinboard row records the branch it targets
// (`baseBranch`, the parent's PR branch) and the parent commit it sits on
// (`stackedOnSha`). A pass compares that with the remote:
//
//   - the parent's branch has a new head (an agent rework, a commit pushed by
//     hand): rebase the child's own commits onto it, `git rebase --onto
//     origin/<parent> <old parent sha>`;
//   - the parent's PR merged: the squash commit on the default branch holds
//     the parent's work under a new hash, so the same rebase goes onto
//     `origin/<default>` instead, after making sure GitHub retargeted the PR.
//
// Either way the result is force-pushed with a lease on the head that was
// rebased, and the new base is written back to pinboard. A rebase that
// conflicts is aborted before anything is pushed and the child goes to
// `rework` with a comment naming the parent commit it could not land on.
//
// Chains (A <- B <- C) work because a pass handles parents before children:
// restacking B gives it a new head, which C then sees as a moved parent.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { workspaceRoot } from "./paths.js";
import {
  addComment,
  getTask,
  listOpenPullRequests,
  listProjects,
  listPullRequests,
  setTaskStatus,
  updatePullRequestStack,
  type Actor,
  type PullRequest,
} from "./pinboard.js";
import { clearStackRecord, repoWorkdir, resolveDefaultBranch, updateStackSha } from "./workdir.js";

const RESTACK_ACTOR: Actor = { actorType: "agent", actorName: "foreman-pipeline" };

// Statuses a child is restacked in. A running session owns its clone and
// branch (and rebases onto its base before it pushes anyway), and a task
// already in rework or waiting on a question is left to whoever has it, so
// a conflict there is not reported again on every pass.
export const RESTACK_STATUSES = ["review", "awaiting_review", "awaiting_ci", "awaiting_merge"];

export type RestackResult =
  | { status: "restacked"; ontoSha: string; sha: string }
  | { status: "current"; ontoSha: string; sha: string }
  | { status: "conflict"; ontoSha: string; error: string }
  | { status: "failed"; error: string };

function gitIn(repoPath: string) {
  return (...args: string[]): string => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
}

function errorText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  return String(e.stderr ?? "").trim() || String(e.message ?? err);
}

// Moves `branch`'s own commits (those after `oldBase`) onto `origin/<onto>`
// and force-pushes the result. Pure git against `repoPath`'s origin, so it
// is tested against a bare remote. The clone must be clean and hold nothing
// unpushed on `branch`: the remote branch is what gets rebased, and the
// local one is reset to it first.
export function restackBranch(repoPath: string, opts: { branch: string; onto: string; oldBase: string }): RestackResult {
  const git = gitIn(repoPath);
  const isAncestor = (a: string, b: string): boolean => {
    try {
      git("merge-base", "--is-ancestor", a, b);
      return true;
    } catch {
      return false;
    }
  };
  let ontoSha: string;
  let headSha: string;
  try {
    git("fetch", "origin", opts.onto, opts.branch);
    ontoSha = git("rev-parse", `origin/${opts.onto}`);
    headSha = git("rev-parse", `origin/${opts.branch}`);
  } catch (err) {
    return { status: "failed", error: `could not fetch ${opts.onto} and ${opts.branch}: ${errorText(err)}` };
  }
  // Already on top of the new base (a resumed run rebased it, or an earlier
  // pass did and only the record is behind).
  if (isAncestor(ontoSha, headSha)) return { status: "current", ontoSha, sha: headSha };
  // Rewritten under the record (the parent was force-pushed, or the child
  // rebased by hand): no pass will ever get further, so it goes to a human
  // like a conflict rather than failing quietly every time.
  if (!isAncestor(opts.oldBase, headSha)) {
    return { status: "conflict", ontoSha, error: `the recorded parent commit ${opts.oldBase} is no longer in ${opts.branch}, so its own commits cannot be told apart from the parent's` };
  }
  try {
    if (git("status", "--porcelain")) return { status: "failed", error: `${repoPath} has uncommitted changes` };
    if (git("branch", "--list", opts.branch) && git("rev-list", `origin/${opts.branch}..${opts.branch}`)) {
      return { status: "failed", error: `${opts.branch} has commits in ${repoPath} that are not on the remote` };
    }
    git("checkout", "-q", "-B", opts.branch, `origin/${opts.branch}`);
  } catch (err) {
    return { status: "failed", error: errorText(err) };
  }
  try {
    // --empty=drop: a parent commit the child already carried (a resumed run
    // rebased it by hand) applies as empty and is dropped, not a conflict.
    git("rebase", "--empty=drop", "--onto", `origin/${opts.onto}`, opts.oldBase);
  } catch (err) {
    try {
      git("rebase", "--abort");
    } catch {
      // not mid-rebase
    }
    return { status: "conflict", ontoSha, error: errorText(err) };
  }
  const sha = git("rev-parse", "HEAD");
  try {
    git("push", `--force-with-lease=${opts.branch}:${headSha}`, "origin", `${opts.branch}:${opts.branch}`);
  } catch (err) {
    return { status: "failed", error: `push failed: ${errorText(err)}` };
  }
  return { status: "restacked", ontoSha, sha };
}

// One stacked PR to restack, and where onto.
export interface RestackPlan {
  pr: PullRequest;
  parent: PullRequest;
  // The branch the child moves onto: the parent's while it is open, the
  // default branch once it merged.
  merged: boolean;
}

// Which open PRs are stacked on a parent that moved or merged, parents
// first. `parentsOf` returns the parent task's PR rows. A row only counts as
// stacked while its recorded base is still its parent's PR branch: once a
// restack moved it to the default branch it is an ordinary PR. A closed
// (rejected) parent is pinboard's to handle.
export function planRestacks(open: readonly PullRequest[], parentsOf: (taskId: number) => readonly PullRequest[]): RestackPlan[] {
  const plans: RestackPlan[] = [];
  for (const pr of open) {
    if (pr.stackedOnTaskId == null || !pr.baseBranch || !pr.branchName) continue;
    const parent = parentsOf(pr.stackedOnTaskId).find((p) => p.repoSlug === pr.repoSlug && p.branchName === pr.baseBranch);
    if (!parent || parent.state === "closed") continue;
    plans.push({ pr, parent, merged: parent.state === "merged" });
  }
  const depth = (plan: RestackPlan, seen = new Set<number>()): number => {
    const up = plans.find((p) => p.pr.id === plan.parent.id);
    if (!up || seen.has(up.pr.id)) return 0;
    seen.add(up.pr.id);
    return 1 + depth(up, seen);
  };
  return plans.map((plan) => ({ plan, d: depth(plan) })).sort((a, b) => a.d - b.d).map((x) => x.plan);
}

export function restackConflictComment(prUrl: string, onto: string, ontoSha: string, error: string): string {
  return [
    `Could not restack ${prUrl} onto ${onto} at ${ontoSha}. The PR's branch was left as it was.`,
    "",
    error.length > 4000 ? `…${error.slice(-4000)}` : error,
    "",
    `The branch needs rebasing onto ${onto} by hand (or by a requeued run), keeping only this task's own commits.`,
  ].join("\n");
}

export interface RestackDeps {
  listOpen: () => Promise<PullRequest[]>;
  listForTask: (taskId: number) => Promise<PullRequest[]>;
  taskStatus: (taskId: number) => Promise<string>;
  // The default branch of the PR's repo, and its current base on GitHub
  // (null when it can't be read).
  defaultBranch: (repoPath: string) => string;
  prBase: (prUrl: string) => string | null;
  retarget: (prUrl: string, base: string) => boolean;
  // A clean clone of the child's repo to rebase in, and a cleanup for it.
  cloneFor: (pr: PullRequest) => Promise<{ path: string; own: boolean; done: () => void } | null>;
  recordStack: (pr: PullRequest, baseBranch: string, sha: string) => Promise<unknown>;
  comment: (taskId: number, body: string) => Promise<unknown>;
  toRework: (taskId: number) => Promise<unknown>;
}

export interface RestackOutcome {
  prUrl: string;
  result: RestackResult["status"] | "skipped";
  note: string;
}

export async function restackOpenPrs(deps: RestackDeps = defaultDeps()): Promise<RestackOutcome[]> {
  const open = await deps.listOpen();
  const parentIds = [...new Set(open.map((p) => p.stackedOnTaskId).filter((id): id is number => id != null))];
  const parents = new Map<number, PullRequest[]>();
  for (const id of parentIds) parents.set(id, await deps.listForTask(id));
  const outcomes: RestackOutcome[] = [];
  for (const plan of planRestacks(open, (id) => parents.get(id) ?? [])) {
    try {
      outcomes.push(await restackOne(plan, deps));
    } catch (err) {
      outcomes.push({ prUrl: plan.pr.url, result: "failed", note: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

async function restackOne({ pr, parent, merged }: RestackPlan, deps: RestackDeps): Promise<RestackOutcome> {
  const status = await deps.taskStatus(pr.taskId);
  if (!RESTACK_STATUSES.includes(status)) return { prUrl: pr.url, result: "skipped", note: `task is ${status}` };
  const clone = await deps.cloneFor(pr);
  if (!clone) return { prUrl: pr.url, result: "failed", note: "no clone of the repo to restack in" };
  try {
    const onto = merged ? deps.defaultBranch(clone.path) : (parent.branchName as string);
    const oldBase = pr.stackedOnSha;
    if (!oldBase) return { prUrl: pr.url, result: "failed", note: "no parent commit recorded for the PR" };
    // The parent's branch is deleted with the merge and GitHub retargets its
    // stacked PRs to the parent's base. Confirm that before pushing, since a
    // push onto a PR still aimed at a deleted branch would be wasted.
    if (merged && deps.prBase(pr.url) !== onto && !deps.retarget(pr.url, onto)) {
      return { prUrl: pr.url, result: "failed", note: `could not retarget ${pr.url} to ${onto}` };
    }
    const result = restackBranch(clone.path, { branch: pr.branchName as string, onto, oldBase });
    if (result.status === "restacked" || result.status === "current") {
      if (result.ontoSha !== oldBase || merged) await deps.recordStack(pr, onto, result.ontoSha);
      if (clone.own) (merged ? clearStackRecord(clone.path) : updateStackSha(clone.path, result.ontoSha));
      return { prUrl: pr.url, result: result.status, note: `${result.status === "current" ? "already on" : "restacked onto"} ${onto} at ${result.ontoSha}` };
    }
    if (result.status === "conflict") {
      await deps.comment(pr.taskId, restackConflictComment(pr.url, onto, result.ontoSha, result.error));
      await deps.toRework(pr.taskId);
      return { prUrl: pr.url, result: "conflict", note: `conflicts with ${onto} at ${result.ontoSha}, moved to rework` };
    }
    return { prUrl: pr.url, result: "failed", note: result.error };
  } finally {
    clone.done();
  }
}

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

function gh(args: string[]): string | null {
  try {
    return execFileSync("gh", args, { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

// The child's own task clone when it is still on disk (so it stays in step
// with the remote for a later resumed run), otherwise a throwaway clone of
// the workspace checkout pointed at the real remote.
async function cloneFor(pr: PullRequest): Promise<{ path: string; own: boolean; done: () => void } | null> {
  const own = repoWorkdir(pr.taskId, pr.repoSlug);
  if (existsSync(own)) return { path: own, own: true, done: () => {} };
  const project = (await listProjects()).find((p) => p.localPath && basename(p.localPath) === pr.repoSlug);
  if (!project?.localPath) return null;
  const source = join(workspaceRoot(), project.localPath);
  if (!existsSync(source)) return null;
  const dir = mkdtempSync(join(tmpdir(), "foreman-restack-"));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const path = join(dir, pr.repoSlug);
    execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", source, path], { stdio: "pipe" });
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: source, stdio: "pipe" }).toString().trim();
    execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: path, stdio: "pipe" });
    return { path, own: false, done };
  } catch {
    done();
    return null;
  }
}

export function defaultDeps(): RestackDeps {
  return {
    listOpen: listOpenPullRequests,
    listForTask: listPullRequests,
    taskStatus: async (taskId) => (await getTask(taskId)).status,
    defaultBranch: resolveDefaultBranch,
    prBase: (url) => gh(["pr", "view", url, "--json", "baseRefName", "--jq", ".baseRefName"]),
    retarget: (url, base) => gh(["pr", "edit", url, "--base", base]) !== null,
    cloneFor,
    recordStack: (pr, baseBranch, sha) => updatePullRequestStack(pr.taskId, pr.id, { baseBranch, stackedOnSha: sha }),
    comment: (taskId, body) => addComment(taskId, RESTACK_ACTOR, body),
    toRework: (taskId) => setTaskStatus(taskId, "rework"),
  };
}
