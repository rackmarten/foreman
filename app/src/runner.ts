// I4a: single-agent execution, branch and PR only (PLAN.md). Spawns
// `claude -p` in a fresh git worktree for one task, enforcing a lease,
// a hard timeout and a per-task cost ceiling, then - only if the session
// actually left commits - pushes the branch and opens a PR itself. The
// agent is never given push or `gh` access (see agent-settings.ts): at
// worst a bad session leaves bad commits on a throwaway branch nobody
// merges.
//
// Deliberately wraps the CLI's own session management (--worktree,
// --output-format json, --max-budget-usd, --json-schema, --permission-
// prompts none) rather than reimplementing it - see PLAN.md's I0 finding
// on this.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { claudeConfigPath, conventionsFile, workspaceRoot } from "./paths.js";
import { basename, join } from "node:path";
import {
  addComment,
  addPullRequest,
  advancePipeline,
  claimTaskWithLease,
  clearControl,
  getComments,
  getRootGrant,
  getPlanGate,
  reportSessionLimit,
  requeueWithAttemptCount,
  getPlanNext,
  getTask,
  getTaskChatThread,
  getChatMessages,
  listAgents,
  listLicenses,
  listProjects,
  listPullRequests,
  listRoutingRules,
  listTasks,
  recordActivity,
  releaseLease,
  renewLease,
  setAttemptCount,
  setSessionState,
  setTaskStatus,
  submitHandoff,
  getTaskRelations,
  type RootGrant,
  type Actor,
  type Agent,
  type Comment,
  type License,
  type PlanCandidate,
  type RepairReason,
  type RoutingRule,
  type Project,
  type Task,
  type TaskAsk,
  type TaskDetail,
  type TaskRelation,
} from "./pinboard.js";
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS, DEFAULT_MODEL, modelArgs } from "./agent-settings.js";
import { resolveAgentForTask, type ResolvedAgent } from "./routing.js";
import { buildEightBallPrompt, createEightBallClient } from "./eightball.js";
import { DISK_CHECK, EIGHT_BALL_CHECK, eightBallProject, health, seatCheck } from "./health.js";
import { claudeBin, inheritedEnv, resolveSpawnEnv, type SpawnEnv } from "./spawn-env.js";
import {
  TASK_ROOT,
  ensureTaskClone,
  isSweepable,
  pruneTrustedWorkdirs,
  rebaseOntoMain,
  removeTaskWorkdir,
  repoWorkdir,
  resolveDefaultBranch,
  taskBranch,
  taskWorkdir,
} from "./workdir.js";
import { classifyAttemptFailure } from "./session-limit.js";
import {
  classifyInfraError,
  describeInfraCause,
  DISK_COOLDOWN_KEY,
  freeBytesAt,
  InfraCooldowns,
  infraCooldownMs,
  minFreeBytes,
  preflightDecision,
  seatCooldownKey,
  updateClaude,
} from "./infra.js";
import { isPublicRepo, repoOrgFor, withRetry } from "./pipeline.js";
import { formatLeakComment, LEAK_PATTERNS_FILE, LeakBlockedError, leakGateForPush } from "./leak-gate.js";
import { pendingQuestion } from "./ask.js";
import { ROOT_ACCESS_LABEL, ROOT_SET_KEYS, rootWaitActive } from "./root.js";

// see work.ts's WORKSPACE_ROOT for why this moved up one level -
// a project's localPath is now always org/name (e.g. "my-org/pinboard"),
// not a bare name.
const WORKSPACE_ROOT = workspaceRoot();

// I4a only runs tasks at or below "EXECUTE SMALL TASKS" - see
// idea-task-management.md's "Autonomy Levels". Anything higher is out of
// scope until a later increment raises the ceiling deliberately.
export const MAX_AUTONOMY_LEVEL = 3;

// I7: how often the dispatcher checks pinboard for a runnable task, both
// while idle and between one task finishing and the next poll.
export const DEFAULT_DISPATCH_INTERVAL_SECONDS = 60;

// I4c: how often a live attempt checks pinboard for an operator-requested
// stop/kill (see routes.ts's /tasks/:id/control). Independent of the lease
// renewal interval, which is far coarser (leaseSeconds/2).
const CONTROL_POLL_INTERVAL_MS = 5_000;
// "stop" sends SIGINT first and gives the session this long to exit on its
// own (in the hope it writes a real handoff) before escalating to SIGTERM
// then SIGKILL the same way a hard timeout does. Not verified against real
// `claude -p` behavior under SIGINT - this is a best-effort attempt at a
// clean exit, not a guarantee the JSON result still parses.
const GRACEFUL_STOP_GRACE_MS = 30_000;

// a retained workdir/session survives past its task reaching
// done/rejected only until the next sweep notices; this bounds how long one
// survives regardless of status at all, for a task that's simply abandoned
// in review/rework and never revisited. The sweep itself runs far less often
// than the dispatch loop's own interval - a stale workdir costing a few
// hours of disk space is a non-issue, so there's no need to check every tick.
// a per-task clone is bigger than the worktree this replaced
// (it carries its own node_modules), but foreman has the disk for it and the
// value of resuming an abandoned task's checkout is unchanged.
const WORKDIR_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const WORKDIR_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface RunOptions {
  timeoutMs: number;
  budgetUsd: number;
  attempts: number;
  leaseSeconds: number;
  agentName: string;
  // I12a: true when the caller passed `--agent=` explicitly (work.ts sets
  // this). When false, agentName is just the fallback for resolveAgentForTask
  // - runTask resolves the real agent from the I12a routing rules instead of
  // using it directly. Kept default false so existing DEFAULT_RUN_OPTIONS
  // callers (tests, anything not going through work.ts's CLI flags) still
  // get routing rather than being silently pinned to "foreman-runner".
  agentExplicit: boolean;
  // true when the caller passed `--budget-usd=` explicitly. When
  // false, budgetUsd is only a fallback - runTask takes the real cap from
  // pinboard's gate, which sizes it from this task's own cost estimate. Same
  // shape and same reasoning as agentExplicit above: an operator's explicit
  // number must win, but the default must not quietly pin every task to one
  // constant, which is what made a past task unfinishable at any attempt count.
  budgetExplicit: boolean;
  // I6: an explicit operator opt-in to run anyway while the governor is in
  // "danger" state (see checkGovernor below). Never bypasses "critical".
  override: boolean;
  // which license the dispatch loop was asking on behalf of when
  // it started this task. Used for routing's fallback only (see
  // resolveAgentForTask) - the budget gate is always asked for the license
  // the *resolved* agent actually belongs to, which is the same thing when a
  // rule didn't send the task to another seat, and the correct one when it
  // did. Undefined on the direct `work task run` path, which has no seat in
  // mind until routing answers.
  preferLicenseId?: number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  timeoutMs: 30 * 60 * 1000,
  budgetUsd: 2,
  attempts: 3,
  leaseSeconds: 600,
  agentName: "foreman-runner",
  agentExplicit: false,
  budgetExplicit: false,
  override: false,
};

interface HandoffFields {
  // markdown TL;DR, at most 5 lines, plus a "Needs you:" line when
  // something is left for a human. Leads the PR body and the handoff comment.
  summary: string;
  // short steps a reviewer can follow to check the change.
  howToVerify: string;
  completed: string;
  changed: string;
  verified: string;
  problems: string;
  discovered: string;
  next: string;
  estimatedNextEffort: number | null;
  // Optional: why a session that made no commits needed none. See
  // decideNoCommitOutcome.
  outcome?: "already_done" | "rejected" | null;
}

const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    howToVerify: { type: "string" },
    completed: { type: "string" },
    changed: { type: "string" },
    verified: { type: "string" },
    problems: { type: "string" },
    discovered: { type: "string" },
    next: { type: "string" },
    estimatedNextEffort: { type: ["integer", "null"], enum: [1, 2, 3, 5, 8, 13, null] },
    outcome: { type: ["string", "null"], enum: ["already_done", "rejected", null] },
  },
  required: ["summary", "howToVerify", "completed", "changed", "verified", "problems", "discovered", "next"],
};

interface ClaudeResult {
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  permission_denials: unknown;
}

// workdirName/branch/sessionId are carried on every outcome, ok or
// not, so runTask can persist them for a later resume regardless of how the
// attempt ended - `retained: false` marks the two paths (hard timeout,
// operator kill/non-compliant stop) that already cleaned the workdir up
// themselves, so runTask knows to clear session state instead.
// `costUsd` rides along on a failure so runTask can tell a run
// that died at its budget cap from one that died for any other reason. Left
// optional because a run that never produced a result line has no cost to
// report, and an unknown cost must not be read as "spent the cap".
type AttemptOutcome =
  | { ok: false; error: string; terminal?: boolean; retained: false; costUsd?: number }
  | {
      ok: false;
      error: string;
      terminal?: boolean;
      retained: true;
      workdirName: string;
      branch: string;
      sessionId?: string;
      costUsd?: number;
    }
  | {
      ok: true;
      retained: true;
      branch: string;
      workdirName: string;
      sessionId?: string;
      hasCommits: boolean;
      relatedTargets: RepoTarget[];
      totalCostUsd: number;
      durationMs: number;
      numTurns: number;
      permissionDenials: unknown;
      handoff: HandoffFields;
    };

function ensureGhAuthenticated(): void {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
  } catch {
    throw new Error("gh is not authenticated on this machine - required to open a PR once the agent finishes");
  }
}

// I22: depends_on is a real scheduler gate (pickNextRunnableTask won't
// return a task with an open depends_on relation), so it never reaches
// here still blocked. child is advisory only - it may live in another
// project/repo entirely (e.g. a homelab-kit helper a pinboard task wants to
// reuse), so the agent decides whether to do it, wait, or proceed anyway.
async function subtaskContext(task: Task): Promise<string[]> {
  const relations = await getTaskRelations(task.id).catch(() => [] as TaskRelation[]);
  const children = relations.filter(
    (r): r is TaskRelation & { otherTask: NonNullable<TaskRelation["otherTask"]> } =>
      r.direction === "from" && r.relationType === "child" && r.otherTask !== null,
  );
  if (!children.length) return [];
  return [
    "",
    "This task has subtasks already filed in pinboard (possibly in a different project/repo). " +
      "Use your judgment on whether they need to be done first, or whether this task can " +
      "proceed independently of them:",
    ...children.map((r) => `  - #${r.otherTask.id} [${r.otherTask.status}] ${r.otherTask.title}`),
  ];
}

// I22: a human requeueing a task after review typically leaves a comment
// with rework instructions rather than editing the description - without
// this, that feedback was invisible to the next attempt (only title +
// description reached buildPrompt).
async function commentContext(task: Task): Promise<string[]> {
  const comments = await getComments(task.id).catch(() => [] as Comment[]);
  if (!comments.length) return [];
  return [
    "",
    "Comments on this task, oldest first (a human may have left rework notes here after a " +
      "prior attempt - read them before starting):",
    ...comments.map((c) => `  [${c.createdAt}] ${c.authorName} (${c.authorType}): ${c.body}`),
  ];
}

// a past task saw the agent stop mid-task to ask whether it may
// edit a related repo, which either blocked progress or produced a partial
// implementation - the fix is telling it upfront, in the prompt, that
// related repos are pre-authorized. Effective repo set = project's own
// relatedProjectIds + this task's own relatedProjectIds (see pinboard's
// schema.ts comment on the columns), resolved to localPaths and deduped
// against the task's own repo (already covered by the worktree itself).
// `repoPath` is this task's own clone of the repo - the directory
// the agent works in and every later git/gh step (branchHasCommits,
// pushAndOpenPr) runs against. `sourceRepo` is the workspace checkout it was
// cloned from, kept only as the clone source. Under the worktree scheme these
// were the same directory, because a worktree's branch lives in the checkout
// that created it; a clone shares nothing, so the two have to be told apart.
export interface RepoTarget {
  project: Project;
  repoPath: string;
  sourceRepo: string;
}

// `root` exists so tests can point the whole scheme at a temporary directory;
// production always uses workdir.ts's TASK_ROOT.
export function repoTargetFor(
  taskId: number,
  project: Project,
  root: string = TASK_ROOT,
  workspaceRoot: string = WORKSPACE_ROOT,
): RepoTarget {
  const sourceRepo = join(workspaceRoot, project.localPath as string);
  return { project, repoPath: repoWorkdir(taskId, basename(project.localPath as string), root), sourceRepo };
}

export function relatedRepoTargets(task: Task, project: Project, allProjects: Project[], root: string = TASK_ROOT): RepoTarget[] {
  const ids = Array.from(new Set([...project.relatedProjectIds, ...task.relatedProjectIds]));
  return ids
    .map((id) => allProjects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined && p.id !== project.id && p.localPath !== null)
    .map((p) => repoTargetFor(task.id, p, root));
}

// `work task add-related-repo` run from inside a task's own agent
// session clones the newly related repo right away, so the agent has
// somewhere to commit it. That CLI can run as the other seat's Linux user
// (sudo -u, env reset), whose $HOME is not the dispatcher's, so it can't
// derive WORKSPACE_ROOT itself - the runner records it in the task workdir
// and the CLI reads it back from there.
const WORKSPACE_ROOT_MARKER = "workspace-root";

export function recordWorkspaceRoot(taskId: number, root: string = TASK_ROOT, workspaceRoot: string = WORKSPACE_ROOT): void {
  writeFileSync(join(taskWorkdir(taskId, root), WORKSPACE_ROOT_MARKER), `${workspaceRoot}\n`);
}

export function recordedWorkspaceRoot(taskId: number, root: string = TASK_ROOT): string {
  if (process.env.WORK_WORKSPACE_ROOT) return process.env.WORK_WORKSPACE_ROOT;
  try {
    return readFileSync(join(taskWorkdir(taskId, root), WORKSPACE_ROOT_MARKER), "utf8").trim() || WORKSPACE_ROOT;
  } catch {
    return WORKSPACE_ROOT;
  }
}

// Returns the new clone's path, or null when the task has no workdir under
// `root` (workstation use: only the relation gets recorded) or the project
// has no repo. Same clone, same branch as a pre-declared related repo gets in
// runOneAttempt; idempotent, so an already-cloned repo is left as it is.
export function cloneRelatedRepoMidRun(taskId: number, related: Project, root: string = TASK_ROOT): string | null {
  if (!related.localPath || !existsSync(taskWorkdir(taskId, root))) return null;
  const target = repoTargetFor(taskId, related, root, recordedWorkspaceRoot(taskId, root));
  ensureTaskClones(taskId, [target], taskBranch(taskId), root);
  return target.repoPath;
}

// A past task follow-up: a related repo used to be pointed at its plain
// sibling checkout (on `main`), so a session that committed there committed
// straight to main - no branch, no PR, discovered only when a human went
// looking for an MR that didn't exist. It now gets its own worktree on the
// same branch as this task's own repo (see ensureRelatedWorktrees), so
// runTask can push and open a PR for it exactly like the primary repo.
export function relatedRepoLines(task: Task, project: Project, allProjects: Project[]): string[] {
  const related = relatedRepoTargets(task, project, allProjects);
  if (!related.length) return ["", ...addRelatedRepoLines(task)];
  return [
    "",
    "This task's project has related repos pre-declared in pinboard - you are allowed to read " +
      "AND write directly in them, not just view them, without stopping to ask permission first. " +
      "Use the same judgment on scope you'd use in this task's own repo. Each one below is this " +
      "task's own clone of that repo, already checked out on this same task's branch - commit " +
      "there (not in the workspace checkout under ~/projects) and foreman will push and open a " +
      "PR for it, same as this task's own repo:",
    ...related.map((t) => `  - ${t.repoPath} (pinboard project '${t.project.slug}')`),
    "",
    ...addRelatedRepoLines(task),
  ];
}

// a repo related mid-run gets its clone from the CLI call itself,
// on this task's branch, and is pushed and opened as a PR after the session
// like any other related repo - the agent never clones or branches anything.
function addRelatedRepoLines(task: Task): string[] {
  return [
    "If you discover mid-task that you need to touch a repo not listed here, add the relation " +
      `yourself and proceed rather than stopping to ask: \`work task add-related-repo ${task.id} ` +
      "<project-slug-or-id>`. It prints the path of this task's own clone of that repo, already on " +
      "this task's branch - work and commit there, and foreman will push it and open its PR like any other.",
  ];
}

// the repos in this run (its own and the pre-declared related
// ones) that live in a public GitHub org, as `org/name`.
function publicReposInRun(task: Task, project: Project, allProjects: Project[]): string[] {
  const projects = [project, ...relatedRepoTargets(task, project, allProjects).map((t) => t.project)];
  return projects
    .filter((p) => p.localPath && isPublicRepo(p.localPath))
    .map((p) => `${repoOrgFor(p.localPath)}/${basename(p.localPath as string)}`);
}

// nothing written to a public repo may point back at private
// infrastructure. Empty when no repo in the run is public.
export function publicRepoRulesLines(publicRepos: readonly string[], patternsFile: string = LEAK_PATTERNS_FILE): string[] {
  if (!publicRepos.length) return [];
  return [
    "",
    "Public repository rules - these repos are public on GitHub:",
    ...publicRepos.map((r) => `  - ${r}`),
    "In those repos, commit messages, PR titles/bodies, CHANGELOG entries, code comments and docs " +
      "must not contain task numbers (`#<n>`) or pinboard links, private service or host names, CTIDs or LAN " +
      "addresses of real hosts, private domains, or links to private repos. Describe the change " +
      "itself instead. Your first commit's subject becomes the PR title and your handoff `summary` " +
      "and `howToVerify` become the PR body, so keep those clean too. Handoffs (other fields) and " +
      "pinboard comments are private and keep their normal detail.",
    `Before the push, foreman runs a leak check over those commits, the added lines and the PR text; ` +
      `a hit sends the task back to rework. The patterns are in ${patternsFile} - read it with the ` +
      "Read tool and check your text against it before committing.",
  ];
}

// what a resumed session is being woken to fix. The pipeline hands
// a task back to `queued` with one of three reasons and the evidence it
// collected (the failing CI step's log, git's own conflict output, the deploy
// script's or healthcheck's stderr), and without this the run would read as an
// ordinary retry of a task it believes it already finished - which is how task
// #130's original inline CI retry went wrong before it was given the log.
//
// Pure and exported so the wording is unit-testable without spawning anything.
export function repairPromptLines(
  reason: RepairReason,
  context: string | null,
  taskId: number,
): string[] {
  // Each reason says what already happened to the change, because that is
  // what decides where the fix goes: a red PR is still open and takes more
  // commits on the same branch, a merged-then-failed deploy needs a NEW
  // change on top of main rather than an edit to work that already landed.
  const whatHappened: Record<RepairReason, string> = {
    ci_failed:
      "Your change was pushed and its pull request opened, but CI failed on it. The PR is still " +
      "open on your branch - fix the failure and commit; the same PR picks up the new commits.",
    merge_conflict:
      "Your change passed CI, but it could not be merged: rebasing your branch onto the current " +
      "origin/main hit a conflict that needs a human-level decision. Your branch has been left " +
      "exactly as it was. Resolve it against origin/main and commit the result.",
    deploy_failed:
      "Your change passed CI and was MERGED to main, but deploying it (or the service's own " +
      "healthcheck afterwards) failed. What you wrote is already on main, so fix it with a new " +
      "commit on your branch on top of current main - do not try to revert or re-land the " +
      "original change.",
  };
  return [
    "",
    `## You are being resumed to repair this task (${reason})`,
    "",
    whatHappened[reason],
    "",
    "Fix only what the evidence below points at. Do not redo, re-scope or re-review the rest of " +
      "the task - it already passed once, and a repair run that rewrites working code costs an " +
      "attempt for nothing. If the evidence points at something you cannot fix from here (an LXC " +
      "that is down, a credential that is missing, a flaky external service), say so in your " +
      "handoff (on its summary's \"Needs you:\" line) and stop rather than working around it - or, " +
      `if it needs a decision only a human can make, ask as the autonomy policy below says (\`work task ask ${taskId}\`).`,
    "",
    "Evidence collected by the pipeline when the stage failed:",
    "",
    "```",
    (context ?? "(none recorded - check the task's comments for what the pipeline reported)").trim(),
    "```",
  ];
}

// a root-access task is told which CTIDs it may touch through
// `work root` and when that ends. Every other task gets nothing here, and
// `work root` refuses for it on this side as well as on the host.
export function rootAccessLines(taskId: number, labels: string[], grant: RootGrant | null): string[] {
  if (!labels.includes(ROOT_ACCESS_LABEL)) return [];
  if (!grant?.active) {
    return [
      "",
      `This task is labelled ${ROOT_ACCESS_LABEL}, but it has no active root grant, so \`work root\` will refuse. ` +
        "Do what you can without root and say in your handoff that the root part still needs a grant.",
    ];
  }
  return [
    "",
    `Root access: this run holds a root grant for CTID(s) ${grant.ctids.join(", ")} on the Proxmox host, ` +
      `expiring at ${grant.expiresAt ?? "an unknown time"}. Use it only through \`work root\`:`,
    "  work root status <ctid> | start <ctid> | shutdown <ctid> | reboot <ctid>",
    "  work root exec <ctid> '<shell command>'   (runs as root inside the container via pct exec)",
    "  work root exec --detach <ctid> '<shell command>'   then   work root wait <ctid> <job-id>",
    `  work root set <ctid> <key> <value>        (key: ${ROOT_SET_KEYS.join(", ")})`,
    `Every call is logged on the host and as a comment on task ${taskId}. Commands touching .env or ` +
      "/app/secrets are refused. Run long commands non-interactively (e.g. DEBIAN_FRONTEND=noninteractive, -y) " +
      "since there is no terminal. Anything that may take more than a minute or two (apt upgrades, a reboot " +
      "wait, large downloads) must use `exec --detach`: it keeps running if the connection drops, and " +
      "`work root wait` blocks until it ends (up to ~29 minutes per call, pass the Bash tool a 1800000ms " +
      "timeout) and costs nothing while it waits. Never background a root command yourself and never end " +
      "your session while a job is still running - call `work root wait` again until it reports the exit " +
      "code. If a call says the grant expired, stop the root work and record where you got to in your " +
      "handoff instead of retrying.",
  ];
}

async function rootContext(task: Task): Promise<string[]> {
  const labels =
    "labels" in task ? (task as TaskDetail).labels : await getTask(task.id).then((t) => t.labels).catch(() => []);
  const names = labels.map((l) => l.name);
  if (!names.includes(ROOT_ACCESS_LABEL)) return [];
  const grant = await getRootGrant(task.id).catch(() => null);
  return rootAccessLines(task.id, names, grant);
}

// runners decide reversible choices themselves and
// only stop for the kinds of decision a human has to own. Pure so the wording
// is unit-testable.
export function autonomyPolicy(taskId: number): string {
  return [
    "Autonomy policy - decide, don't ask, unless the decision is one a human has to own:",
    "- Reversible, in-scope choices (naming, structure, which of two reasonable approaches, " +
      "defaults, test layout): pick the option you would recommend, carry on, and record it with " +
      `\`work task assume ${taskId} "<decision>" --why="<one line>"\`. It returns at once; the ` +
      "operator can veto it later.",
    `- Only use \`work task ask ${taskId}\` for: irreversible or destructive actions, anything ` +
      "production-impacting, secrets or credentials, a change of scope, spending money, or doing " +
      "something that contradicts the task as written. Ask with 2-4 options, each with a rationale " +
      "covering compatibility, expandability, and cost/risk, and exactly one recommended: " +
      `\`work task ask ${taskId} "<question>" --context="<what you found>" ` +
      '--option="<label>|<rationale>" --option="<label>|<rationale>" --recommended=<n>\`.',
    "- `work task ask` blocks briefly and returns the operator's reply, or says no reply has " +
      "arrived yet - call it again with the same arguments to keep waiting. Don't proceed past a " +
      "question you had to ask; if nothing arrives, end the session and say so in your handoff.",
  ].join("\n");
}

export function handoffSummaryPolicy(): string {
  return [
    "Your final handoff's `summary` field is a TL;DR a human scans first (it leads the PR body): " +
      "at most 5 short lines of markdown saying what changed and whether it works. If anything is " +
      'left for a human (a deploy, a manual check, an open question, a denied tool), end it with ' +
      'one line starting "Needs you:". `howToVerify` is a few short steps a reviewer can follow ' +
      "to check the change. The other fields carry the full detail.",
    "If you end without commits because the task needs none, set `outcome`: `already_done` when " +
      "everything it asks for is already in place (say in `verified` how you checked), or " +
      "`rejected` when the task itself says to reject it in this case (put the reason in " +
      "`completed`). Otherwise leave `outcome` null.",
  ].join("\n");
}

// agent sessions talk to the host's Docker daemon (docker.sock is
// mounted), so a bind mount resolves on the host, where only WORK_TASK_ROOT is
// mounted at the same path. A past task ran pinboard's compose from a copy in
// /tmp: the host made an empty directory for ./scripts/backup.sh, the backup
// service exited 0 straight away, and its restart policy looped it until the
// Grafana "Container restart loop" alert fired.
export function dockerPolicy(taskId: number): string {
  return (
    "Docker here is the host's daemon, so bind mounts resolve on the host and only this task's " +
    "directory exists at the same path there. Run `docker compose` only from inside it, never a " +
    "copy under /tmp or elsewhere (a missing bind source becomes an empty host directory and a " +
    `service with a restart policy crash-loops), use \`-p task-${taskId}\` as the project name, and ` +
    "take the stack down again before you finish. A full test deploy belongs on a dedicated test " +
    "host, not this host."
  );
}

// every ask the operator has already dealt with, so a session
// resumed after needs_input (or retried after a veto) starts from the answers
// instead of asking again. Pure so the wording is unit-testable.
export function askHistoryLines(asks: readonly TaskAsk[]): string[] {
  const done = asks.filter((a) => a.status !== "open");
  if (done.length === 0) return [];
  const lines = ["", "Questions and assumptions on this task the operator has already answered - follow them:"];
  for (const a of done) {
    const chosen = a.answerOption !== null ? a.options[a.answerOption]?.label : undefined;
    const answer = [chosen ? `option "${chosen}"` : "", a.answerText ?? ""].filter(Boolean).join(" - ");
    if (a.kind === "assumption") {
      const verdict = a.status === "vetoed" ? "VETOED" : "accepted";
      lines.push(`  - You assumed: ${a.question}`, `    Operator ${verdict}${answer ? `: ${answer}` : ""}`);
    } else {
      lines.push(`  - Q: ${a.question}`, `    A: ${answer || "(answered with no text)"}`);
    }
  }
  return lines;
}

async function askContext(task: Task): Promise<string[]> {
  const asks = "asks" in task ? (task as TaskDetail).asks : await getTask(task.id).then((t) => t.asks).catch(() => undefined);
  return askHistoryLines(asks ?? []);
}

async function buildPrompt(task: Task, project: Project, allProjects: Project[]): Promise<string> {
  const subtaskLines = await subtaskContext(task);
  const commentLines = await commentContext(task);
  const relatedRepoLinesResult = relatedRepoLines(task, project, allProjects);
  const rootLines = await rootContext(task);
  const askLines = await askContext(task);
  // A repair run is still the same task with the same description - the
  // repair block is added to that context rather than replacing it, since the
  // fix has to satisfy the original requirement too.
  // buildPrompt drops empty strings below (that is how an empty description
  // disappears), so the repair block is joined here and passed as one line -
  // otherwise its blank lines, and with them its markdown, would be stripped.
  const repairBlock = task.repairReason
    ? repairPromptLines(task.repairReason, task.repairContext, task.id).join("\n")
    : "";
  return [
    `You are working unattended on pinboard task ${task.id}: ${task.title}`,
    "",
    // I21: this session's cwd is a single repo, not the homelab workspace
    // root - Claude's own project-file discovery walks up from cwd, so
    // homelab/AGENTS.md (a sibling repo) is otherwise invisible here even
    // though an interactive session run from the workspace root sees it.
    // Confirmed as the likely cause of a past task's runaway/empty-output
    // attempts: without it, this session has no idea about
    // increment sizing, the pinboard/CHANGELOG convention, or "ask early
    // instead of thrashing".
    // only when that file exists, so an install without the
    // homelab workspace doesn't send every run after a missing file.
    ...(existsSync(conventionsFile())
      ? [
          `Before anything else, use the Read tool (not Bash/cat) to read ` +
            `${conventionsFile()} - it has this workspace's conventions ` +
            "(increment sizing, where project knowledge goes, commit style, credit conservation) " +
            "that this repo's own checkout won't otherwise surface to you. Bash commands reading " +
            "outside this task's own workdir get denied by a sandbox boundary the Read tool isn't " +
            "subject to.",
          "",
        ]
      : []),
    task.description ?? "",
    repairBlock,
    ...commentLines,
    ...subtaskLines,
    ...relatedRepoLinesResult,
    ...publicRepoRulesLines(publicReposInRun(task, project, allProjects)),
    ...rootLines,
    ...askLines,
    "",
    // the working directory is this task's own clone of the repo,
    // not a worktree inside the shared workspace checkout - so git commands
    // run here directly, with no `cd ..` to a parent repo (a past task hit the
    // worktree-isolation guard twice on exactly that pattern).
    "Work inside this directory - it is a clone of the repo, made for this task alone, already " +
      "on its own branch" +
      (relatedRepoTargets(task, project, allProjects).length ? ", plus the related repos listed above" : "") +
      ". Run git commands here rather than in any parent directory. When you are done, `git " +
      "add` and `git commit` your " +
      "changes - do not push and do not open a pull request, that happens outside this " +
      "session. If you cannot complete the task, explain why in your handoff instead of " +
      "leaving a half-finished change committed.",
    "",
    dockerPolicy(task.id),
    "",
    autonomyPolicy(task.id),
    "",
    handoffSummaryPolicy(),
    "",
    // I21 follow-up: --permission-prompts none means a denied tool/command
    // is denied for the rest of THIS session no matter what - asking
    // mid-session can't unblock it. The point of surfacing it is so the
    // operator can widen agent-settings.ts's allowlist (or install a
    // missing tool) for the NEXT attempt/task, not to get an answer you can
    // act on right now.
    "A tool or command may come back denied with \"no approval surface\" - that's expected " +
      "here (this session can't show you a permission prompt), and the denial is final for " +
      "this session, retrying it will not help. If you can complete the same step another way " +
      "(e.g. the Read tool instead of a denied Bash command), just do that and move on - no " +
      "need to interrupt for something you can route around. If the denial genuinely blocks " +
      `progress, record it with \`work task assume ${task.id} "<what was denied>" --why="<what ` +
      'tool/command/access would let you do this properly>"\`, carry on with the rest, and name it ' +
      'on the "Needs you:" line of your summary so the operator can adjust the allowlist before the ' +
      "next attempt - do not just silently give up on that part of the task.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// a task's whole workdir goes at once - there is no shared repo
// left holding a worktree registration or a stranded branch to unpick, which
// is what cleanupWorktree/cleanupAllWorktrees existed to do (and what task
// #113's "a branch named ... already exists" failures came from).
function cleanupWorkdir(taskId: number, root: string = TASK_ROOT): void {
  try {
    removeTaskWorkdir(taskId, root);
  } catch (err) {
    console.error(`could not remove workdir for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const CLAUDE_CONFIG_PATH = claudeConfigPath();

// Claude Code ignores a repo's .claude/settings.json
// permissions.allow entries until that workspace is marked trusted in
// ~/.claude.json, and a git worktree's trust key resolves to its main
// repo's path (not the worktree subdirectory) - but a headless `claude -p`
// spawn has no trust dialog to click through, so every attempt silently
// lost its allowlist and hung with no "result" line. Patch
// trust in directly instead, once per repo path; idempotent so a repo
// already trusted (or trusted by a prior attempt) is a no-op.
export function ensureWorkspaceTrusted(repoPath: string, configPath: string = CLAUDE_CONFIG_PATH): void {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`could not read ${configPath} to trust ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const projects = (config.projects ??= {}) as Record<string, Record<string, unknown>>;
  const existing = projects[repoPath];
  if (existing?.hasTrustDialogAccepted === true) return;
  projects[repoPath] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    hasUnseenTeamArtifacts: false,
    ...existing,
    hasTrustDialogAccepted: true,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Every repo this task may write to gets its own clone under the task's
// workdir, all on the same branch name, so pushAndOpenPr/mergeAndDeploy can
// treat them uniformly once the session is done. Idempotent per repo, so a
// resumed attempt keeps the clones (and their commits) it already has.
function ensureTaskClones(taskId: number, targets: RepoTarget[], branch: string, root: string = TASK_ROOT): void {
  for (const target of targets) {
    ensureTaskClone({
      taskId,
      repoSlug: basename(target.project.localPath as string),
      sourceRepo: target.sourceRepo,
      branch,
      root,
    });
  }
}

// SIGKILL terminates the process, but its file descriptors (the workdir's
// own files included) aren't guaranteed released the instant `kill()`
// returns - give it a short bounded window to actually exit before
// `cleanupWorkdir` starts removing the same files out from under it.
async function waitForExit(exited: Promise<void>, maxMs = 2_000): Promise<void> {
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, maxMs))]);
}

type PreparedAttempt = { mode: "fresh" } | { mode: "resume"; sessionId: string; branch: string };

// decides whether the next attempt can resume the previous
// session's own workdir, and puts that workdir (and every related repo's
// clone in it) in a rebased-onto-origin/main state if so. Handles both
// retention cases the same way: a branch that was never merged rebases as a
// no-op/fast-forward; a branch that was already merged (mergeAndDeploy runs
// before a task ever reaches "review") rebases to find its own commits
// already in main, landing the clone at main's tip - exactly the right base
// to continue from either way. Any git failure here (most commonly a real
// rebase conflict, in either this repo or a related one) falls back to a
// fresh attempt for every repo rather than failing the whole run or resuming
// some repos but not others, the same "don't surface a stale-session problem
// as a hard error" precedent chat.ts already uses for
// chatThreads.claudeSessionId.
//
// "fresh" now means the whole task workdir is deleted and recloned
// rather than worktrees being removed repo by repo, so a related repo
// declared after the retained session started simply gets cloned by
// ensureTaskClones on the way in.
// A past task made a session resumable only by the license that created it,
// because each seat ran as its own Linux user and a session id only exists in
// that user's `~/.claude` (#166/#169 burned their attempt caps resuming into
// the other seat's home). Since a past task every seat runs as foreman's own
// user, so every session lives in the same `~/.claude` and any license can
// resume any other's. claudeSessionLicenseId stays recorded for accounting.
// A session retained by a pre-#477 run as another Linux user is the one case
// this gets wrong; claude then fails the resume and the attempt retries fresh.
export function isSessionResumableBy(_task: Task, _licenseId: number | null): boolean {
  return true;
}

export async function prepareAttempt(
  task: Task,
  project: Project,
  allProjects: Project[],
  actor: Actor,
  licenseId: number | null = null,
  root: string = TASK_ROOT,
): Promise<PreparedAttempt> {
  if (!task.claudeSessionId) return { mode: "fresh" };

  if (!isSessionResumableBy(task, licenseId)) {
    const owner = task.claudeSessionLicenseId ?? null;
    await addComment(
      task.id,
      actor,
      `The retained session belongs to a different license (${owner === null ? "owner unknown" : `license ${owner}`}, this run is ${licenseId === null ? "unlicensed" : `license ${licenseId}`}) and is not resumable here - starting a fresh attempt instead.`,
    ).catch(() => {});
    return { mode: "fresh" };
  }

  const targets = [repoTargetFor(task.id, project, root), ...relatedRepoTargets(task, project, allProjects, root)];
  const primary = targets[0];
  if (!existsSync(primary.repoPath)) return { mode: "fresh" };

  const branch = taskBranch(task.id);
  const failure = targets
    .filter((t) => existsSync(t.repoPath))
    .map((t) => rebaseOntoMain(t.repoPath, branch))
    .find((r): r is { ok: false; error: string } => !r.ok);

  if (failure) {
    cleanupWorkdir(task.id, root);
    await addComment(
      task.id,
      actor,
      `Could not rebase the retained session's workdir onto main, starting a fresh attempt instead: ${failure.error}`,
    ).catch(() => {});
    return { mode: "fresh" };
  }

  return { mode: "resume", sessionId: task.claudeSessionId, branch };
}

// the related-repo set as it stands after the session, not as it
// was when the attempt started. A failed re-read keeps the starting set rather
// than failing an attempt whose work is already done.
export async function relatedTargetsAfterSession(
  task: Task,
  project: Project,
  allProjects: Project[],
  before: RepoTarget[],
  fetchTask: (id: number) => Promise<Task> = getTask,
  root: string = TASK_ROOT,
): Promise<RepoTarget[]> {
  const current = await fetchTask(task.id).catch(() => null);
  return current ? relatedRepoTargets(current, project, allProjects, root) : before;
}

// I9: the hard timeout below is measured in "active" time, not wall clock -
// it pauses while the task has an open, unanswered question in its session
// chat thread, so an overnight dispatch run waiting on the operator to wake
// up doesn't burn its whole timeout doing nothing. Pure and unit-tested
// (runner.test.ts) independent of the real polling that feeds it.
export interface TimeoutTrackerState {
  activeElapsedMs: number;
}

export function advanceTimeoutTracker(state: TimeoutTrackerState, deltaMs: number, paused: boolean): TimeoutTrackerState {
  return { activeElapsedMs: paused ? state.activeElapsedMs : state.activeElapsedMs + deltaMs };
}

export function hasTimedOut(state: TimeoutTrackerState, timeoutMs: number): boolean {
  return state.activeElapsedMs >= timeoutMs;
}

// A task's session thread has an unanswered question when it exists, is
// still open, and the last message posted was the agent's own (awaitingAgent
// is false in that state - see schema.ts's chatThreads comment on why this
// field means something session-relative once a thread has a taskId).
async function isAwaitingHumanReply(taskId: number): Promise<boolean> {
  const thread = await getTaskChatThread(taskId);
  return thread !== null && thread.status === "open" && !thread.awaitingAgent;
}

// I19: condensed per-line activity extracted from `claude -p --output-format
// stream-json --verbose`'s NDJSON - one line per complete assistant/tool
// message (not per token, since --include-partial-messages is deliberately
// not passed), which is fine granularity for "what is it doing right now"
// without flooding pinboard with a write per streamed token. Truncated so a
// large tool output/input can't bloat the activity event's jsonb payload.
const ACTIVITY_FIELD_MAX_CHARS = 800;

function truncateForActivity(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > ACTIVITY_FIELD_MAX_CHARS ? `${s.slice(0, ACTIVITY_FIELD_MAX_CHARS)}… (truncated)` : s;
}

interface StreamActivity {
  kind: "text" | "tool_use" | "tool_result";
  detail: Record<string, unknown>;
}

// Only "assistant" (text/tool_use) and "user" (tool_result) stream-json
// lines carry anything worth surfacing live - "system" (session init) and
// "result" (handled separately, below) are skipped.
export function summarizeStreamLine(line: Record<string, unknown>): StreamActivity[] {
  const message = line.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
  const out: StreamActivity[] = [];

  if (line.type === "assistant") {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "text", detail: { text: truncateForActivity(block.text) } });
      } else if (block.type === "tool_use") {
        out.push({ kind: "tool_use", detail: { name: block.name, input: truncateForActivity(block.input) } });
      }
    }
  } else if (line.type === "user") {
    for (const block of content) {
      if (block.type === "tool_result") {
        out.push({
          kind: "tool_result",
          detail: { isError: !!block.is_error, content: truncateForActivity(block.content) },
        });
      }
    }
  }
  return out;
}

// compares against `origin/main`, not a local `main`. A task clone
// does have a local main, but it is whatever the workspace checkout's own main
// was at clone time - which can be days behind the real one, since nothing
// fetches that checkout on a schedule. `origin/main` is fetched by
// ensureTaskClone and rebaseOntoMain, so it is the only reference here that is
// actually current.
function branchHasCommits(repoPath: string, branch: string): boolean {
  try {
    const defaultBranch = resolveDefaultBranch(repoPath);
    const base = execFileSync("git", ["merge-base", `origin/${defaultBranch}`, branch], { cwd: repoPath }).toString().trim();
    const head = execFileSync("git", ["rev-parse", branch], { cwd: repoPath }).toString().trim();
    return base !== head;
  } catch {
    return false;
  }
}

async function runOneAttempt(
  task: Task,
  project: Project,
  allProjects: Project[],
  attempt: number,
  opts: RunOptions,
  agentName: string,
  model: string,
  spawnEnv: SpawnEnv,
  resume?: { sessionId: string; branch: string },
): Promise<AttemptOutcome> {
  // one branch and one workdir per task (not per attempt), so a
  // later attempt resumes the same clone - the same property a past task relied
  // on the fixed worktree name for.
  const branch = resume?.branch ?? taskBranch(task.id);
  const primaryTarget = repoTargetFor(task.id, project);
  const relatedTargets = relatedRepoTargets(task, project, allProjects);
  const targets = [primaryTarget, ...relatedTargets];
  const repoPaths = targets.map((t) => t.repoPath);
  // this used to throw straight out of runOneAttempt on a git
  // failure (e.g. a stale worktree/branch left by an interrupted earlier
  // attempt) - runTask's caller has no catch around this call, so the whole
  // task was left stuck on "executing" forever with no failure comment ever
  // posted. Fold any setup failure into a normal failed-attempt outcome
  // instead, so the existing retry/rework handling in runTask's `!outcome.ok`
  // branch takes over exactly as it does for a failed claude run.
  try {
    // A fresh attempt starts from a clean workdir: anything left by an
    // earlier attempt (or a rebase-conflict fallback in this same run) goes,
    // rather than being reused half-way.
    if (!resume) cleanupWorkdir(task.id);
    ensureTaskClones(task.id, targets, branch);
    recordWorkspaceRoot(task.id);
    for (const path of repoPaths) ensureWorkspaceTrusted(path);
  } catch (err) {
    return { ok: false, error: `could not prepare the task workdir: ${err instanceof Error ? err.message : String(err)}`, retained: false };
  }

  const args = [
    "-p",
    await buildPrompt(task, project, allProjects),
    ...(resume ? ["--resume", resume.sessionId] : []),
    // the write sandbox follows cwd, which is now this task's own
    // clone rather than a `claude --worktree` worktree inside the shared
    // workspace checkout. A related repo's clone is a sibling directory, not
    // under cwd, so it needs an explicit grant - `--add-dir` is that grant,
    // and it keeps everything outside the task's own workdir denied exactly
    // as before.
    ...relatedTargets.flatMap((t) => ["--add-dir", t.repoPath]),
    // a repo related mid-run is cloned into this same directory
    // after the session has started, so the grant has to cover it up front.
    "--add-dir",
    join(taskWorkdir(task.id), "repos"),
    "--output-format",
    "stream-json",
    "--verbose",
    ...modelArgs(model),
    "--max-budget-usd",
    String(opts.budgetUsd),
    // I21 follow-up: a past task's run hit 6 denials, 4 of them not because
    // DEFAULT_ALLOWED_TOOLS lacked a matching entry but because the default
    // permission mode requires per-action approval for anything outside a
    // narrow built-in set (npx, node_modules/.bin/*, python3 -c) regardless
    // of --allowedTools - there is no approval surface in a headless run, so
    // --permission-prompts none just auto-denied all of it. Confirmed by a
    // live smoke test: switching to bypassPermissions let npx/python3/cp
    // through immediately (DEFAULT_ALLOWED_TOOLS unchanged, still effectively
    // inert now - kept anyway for documentation) while
    // DEFAULT_DISALLOWED_TOOLS's git push/gh block held exactly as before -
    // disallowedTools is a hard override even under bypassPermissions, so
    // this doesn't touch the actual safety boundary (the agent never gets
    // push/PR rights either way; foreman does that itself after inspecting
    // the worktree's commits). --permission-prompts none is kept as
    // belt-and-suspenders in case anything still tries to prompt.
    // NOTE: this does NOT lift the separate "read outside this worktree"
    // classifier block (buildPrompt's Read-tool instruction above is the
    // real fix for that one) - confirmed by the same smoke test, that denial
    // persisted unchanged under bypassPermissions.
    "--permission-mode",
    "bypassPermissions",
    "--permission-prompts",
    "none",
    "--allowedTools",
    DEFAULT_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DEFAULT_DISALLOWED_TOOLS.join(","),
    "--json-schema",
    JSON.stringify(HANDOFF_SCHEMA),
    // same Bash timeouts as the spawn env below, kept from when
    // another seat's spawn went through sudo, whose env_reset dropped them.
    "--settings",
    JSON.stringify({ env: { BASH_DEFAULT_TIMEOUT_MS: "1800000", BASH_MAX_TIMEOUT_MS: "1800000" } }),
  ];

  // Both a fresh and a resumed session run with cwd at this task's own clone
  // (prepareAttempt has already rebased it onto origin/main when resuming);
  // nothing creates a worktree any more.
  // every seat runs as foreman's own user; spawnEnv only carries
  // the license's OAuth token (see spawn-env.ts). process.env is inherited
  // whole, so global.env reaches the agent.
  const child = spawn(claudeBin(), args, {
    cwd: primaryTarget.repoPath,
    env: {
      ...inheritedEnv(),
      ...spawnEnv,
      WORK_ACTOR_TYPE: "agent",
      WORK_ACTOR_NAME: agentName,
      // `work root` reads its task id from here (or from the cwd,
      // when sudo's env_reset has dropped it on another seat's spawn).
      WORK_TASK_ID: String(task.id),
      // lets a `work root wait` block for up to 29 minutes in one
      // Bash call instead of the default 2 (a turn per poll is what costs).
      BASH_DEFAULT_TIMEOUT_MS: "1800000",
      BASH_MAX_TIMEOUT_MS: "1800000",
    },
  });

  // same fix as chat.ts's spawnChatTurn, found here while verifying
  // that one. The prompt is an argument, so nothing is ever written to stdin,
  // but leaving the pipe open makes `claude` wait on it and print "Warning: no
  // stdin data received in 3s, proceeding without it" - which then becomes the
  // whole reported failure whenever a run ends badly for an unrelated reason.
  // A past task's attempts on 2026-09-17 each reported exactly that after
  // spending $2.02 against a $2 --max-budget-usd cap: the run was out of
  // budget, and the only thing visible to the operator was a warning about
  // stdin.
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let finalResult: ClaudeResult | null = null;
  let lineBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (parsed.type === "result") {
        finalResult = parsed as unknown as ClaudeResult;
        continue;
      }
      for (const activity of summarizeStreamLine(parsed)) {
        recordActivity(task.id, { actorType: "agent", actorName: agentName }, { attempt, ...activity }).catch((err) =>
          console.error(`activity record failed for task ${task.id}: ${String(err)}`),
        );
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  // Timeout and operator stop/kill (I4c) share one poll loop (I9 folded the
  // two together, since both already needed the same 5s cadence): each tick
  // checks for a control request first, then whether the task's active-time
  // budget (paused while a session-chat question is outstanding - see
  // advanceTimeoutTracker) has run out. 5s granularity means the timeout can
  // fire up to one tick late - negligible against a 30-minute default and
  // the same granularity the control check already had.
  let lastTickAt = Date.now();
  let timeoutState: TimeoutTrackerState = { activeElapsedMs: 0 };

  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout" | "stop" | "kill">((resolve) => {
      const interval = setInterval(() => {
        void (async () => {
          const now = Date.now();
          const deltaMs = now - lastTickAt;
          lastTickAt = now;

          let current: Task;
          try {
            current = await getTask(task.id);
          } catch (err) {
            console.error(`control poll failed for task ${task.id}: ${String(err)}`);
            return;
          }
          if (current.controlAction === "stop" || current.controlAction === "kill") {
            clearInterval(interval);
            resolve(current.controlAction);
            return;
          }

          // a `work root wait` blocking on a slow root job (an OS
          // upgrade) is waiting on the container, not working, so it pauses the
          // clock the same way an open question does.
          const paused =
            rootWaitActive(task.id) || (await isAwaitingHumanReply(task.id).catch(() => false));
          timeoutState = advanceTimeoutTracker(timeoutState, deltaMs, paused);
          if (hasTimedOut(timeoutState, opts.timeoutMs)) {
            clearInterval(interval);
            resolve("timeout");
            return;
          }
        })();
      }, CONTROL_POLL_INTERVAL_MS);
      exited.then(() => clearInterval(interval));
    }),
  ]);

  if (outcome === "timeout") {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    child.kill("SIGKILL");
    await waitForExit(exited);
    cleanupWorkdir(task.id);
    return { ok: false, retained: false, error: `hard timeout (${opts.timeoutMs}ms) exceeded, session killed` };
  }

  // Once the operator has requested a stop/kill, every failure path below
  // must stop the attempt loop (terminal: true) rather than retrying - the
  // operator asked for this run to end, not for another attempt to start
  // right back up. "kill" never gets a chance to produce valid output; a
  // "stop" that exits cleanly on its own SIGINT is given a real chance to
  // still fall through to the normal parse path below, in case it managed
  // to write a genuine handoff before exiting - that's the whole point of
  // asking nicely instead of just killing it.
  let controlled: "stop" | "kill" | null = null;

  if (outcome === "stop" || outcome === "kill") {
    controlled = outcome;
    // Only a "stop" that exits on its own within the grace period gets a
    // chance to fall through to the parse path below - a "kill", and a
    // "stop" that had to be escalated, both return a terminal failure here.
    let compliedGracefully = false;

    if (outcome === "kill") {
      child.kill("SIGKILL");
    } else {
      child.kill("SIGINT");
      compliedGracefully = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), GRACEFUL_STOP_GRACE_MS)),
      ]);
      if (!compliedGracefully) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        child.kill("SIGKILL");
      }
    }
    await clearControl(task.id).catch((err) => console.error(`could not clear control flag for task ${task.id}: ${String(err)}`));

    if (!compliedGracefully) {
      await waitForExit(exited);
      cleanupWorkdir(task.id);
      return {
        ok: false,
        retained: false,
        terminal: true,
        error: outcome === "kill" ? "operator requested kill - session terminated" : "operator requested graceful stop - session did not exit in time, force-terminated",
      };
    }
    // Exited on its own after SIGINT - fall through and try to parse its
    // output like a normal completion.
  }

  if (!finalResult) {
    // no parsed result means no session_id to capture either - but
    // the workdir itself may still be sitting there (a crash after real
    // work), so it's still worth retaining for a resume attempt to inspect/
    // continue from, same as the is_error and success paths below.
    return {
      ok: false,
      retained: true,
      workdirName: basename(taskWorkdir(task.id)),
      branch,
      terminal: controlled !== null,
      error: `no result line found in stream-json output: ${(stderr || stdout).slice(0, 500)}`,
    };
  }
  const result: ClaudeResult = finalResult;

  if (result.is_error) {
    // result.result is often empty on a real failure (budget/tool/internal
    // error, not a clean refusal like the session-limit message) - fall
    // back to whatever cost info the JSON does carry plus a stderr excerpt,
    // rather than just "no result text" with nothing to diagnose from.
    const costHint = typeof result.total_cost_usd === "number" ? ` (cost so far: $${result.total_cost_usd})` : "";
    const detail = result.result || stderr.slice(-500) || "no result text and no stderr captured";
    return {
      ok: false,
      retained: true,
      workdirName: basename(taskWorkdir(task.id)),
      branch,
      sessionId: result.session_id || undefined,
      terminal: controlled !== null,
      error: `session ended with is_error: ${detail}${costHint}`,
      costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    };
  }

  let handoff: HandoffFields;
  try {
    handoff = { summary: "", howToVerify: "", ...JSON.parse(result.result) };
  } catch {
    handoff = {
      summary: "",
      howToVerify: "",
      completed: result.result,
      changed: "",
      verified: "",
      problems: "",
      discovered: "",
      next: "",
      estimatedNextEffort: null,
    };
  }

  // re-read the relations, so a repo added mid-run via
  // `work task add-related-repo` is pushed and gets its PR too.
  const finalRelatedTargets = await relatedTargetsAfterSession(task, project, allProjects, relatedTargets);
  const hasCommits = [primaryTarget, ...finalRelatedTargets].some((t) => branchHasCommits(t.repoPath, branch));

  return {
    ok: true,
    retained: true,
    branch,
    workdirName: basename(taskWorkdir(task.id)),
    sessionId: result.session_id || undefined,
    hasCommits,
    relatedTargets: finalRelatedTargets,
    totalCostUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
    numTurns: result.num_turns,
    permissionDenials: result.permission_denials,
    handoff,
  };
}

// `isResume` covers a resumed attempt pushing more commits onto a
// branch that already went through prepareAttempt's rebase - the rebase
// rewrites commit hashes, so the push needs --force-with-lease. A branch that
// still has an open PR from before (its CI failed last time, so it was never
// merged) just gets the new commits, rather than a duplicate `gh pr create`
// erroring on an existing head branch.
//
// `isResume` alone missed a second case that also rewrites an
// existing branch - a repair handback whose retained session could not
// resume (a foreign-license session, or an in-place rebase that failed)
// falls back to a *fresh* clone of the branch's own remote tip, but the
// repair prompt then tells the agent to resolve the conflict against
// origin/main, which is itself a rebase. Found live: a past task's repair
// commit sat in its retained workdir for eleven hours after a plain `git
// push` was rejected non-fast-forward against the branch's still-open PR,
// because a fresh attempt is only a brand-new branch when there is no
// repairReason - a fresh attempt *on* a repair handback is always rewriting
// a branch the remote already has.
export function pushNeedsForce(isResume: boolean, repairReason: RepairReason | null): boolean {
  return isResume || repairReason !== null;
}

// a multi-repo task has one PR per repo on the same branch name,
// so matching on the branch alone handed every related repo the first repo's
// PR (and never opened their own).
export function findExistingPr<P extends { branchName: string | null; repoSlug: string; state: string }>(
  prs: readonly P[],
  branch: string,
  repoSlug: string,
): P | undefined {
  return prs.find((pr) => pr.branchName === branch && pr.repoSlug === repoSlug && pr.state === "open");
}

// the remote branch's tip, or null when it does not exist yet. Read
// before and after the push so "Pushed additional commits" is only claimed
// when the push actually moved something.
export function remoteBranchSha(repoPath: string, branch: string): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repoPath, stdio: "pipe" }).toString().trim();
    return out ? out.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

// pushNeedsForce only knows about the rewrites foreman itself
// causes. Found live: a past task's fresh attempt rebased its branch onto main
// inside the session, so the plain push was rejected non-fast-forward and a
// finished change went to rework. The remote is what decides it now: a branch
// the remote has at a commit that is not an ancestor of HEAD was rewritten,
// and gets an explicit lease on the sha read before the push, so the push
// still refuses if anything moved the branch after that read. A remote tip
// this clone has never seen is someone else's work, so it gets a plain push
// that git refuses rather than a lease that would overwrite it. The
// isResume/repairReason cases keep their implicit lease (on the tracking ref
// workdir.ts refreshes), unchanged.
export type RemoteTipState = "ancestor" | "rewritten" | "unknown";

export function pushForceArgs(
  branch: string,
  needsForce: boolean,
  remoteSha: string | null,
  tipState: RemoteTipState | null,
): string[] {
  if (needsForce) return ["--force-with-lease"];
  if (remoteSha === null || tipState !== "rewritten") return [];
  return [`--force-with-lease=${branch}:${remoteSha}`];
}

export function remoteTipState(repoPath: string, sha: string): RemoteTipState {
  const git = (...args: string[]) => {
    try {
      execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };
  if (!git("cat-file", "-e", `${sha}^{commit}`)) return "unknown";
  return git("merge-base", "--is-ancestor", sha, "HEAD") ? "ancestor" : "rewritten";
}

// `before` is the remote tip read by the caller before pushing.
export function pushTaskBranch(repoPath: string, branch: string, needsForce: boolean, before: string | null): void {
  const tipState = before === null ? null : remoteTipState(repoPath, before);
  execFileSync("git", ["push", "-u", ...pushForceArgs(branch, needsForce, before, tipState), "origin", branch], {
    cwd: repoPath,
    stdio: "pipe",
  });
}

// the files the branch touches, for the PR body's short
// "## Changed". Empty on any git failure - the full detail is still there.
function changedFiles(repoPath: string, base: string, branch: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", `origin/${base}...${branch}`], { cwd: repoPath })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const PR_CHANGED_FILES_CAP = 15;

// summary first, then a short Changed and How to verify, with the
// agent's full handoff collapsed underneath. Pure so it can be snapshot-tested.
// a public repo's body drops the pinboard line and the agent
// detail - the handoff is private and stays in pinboard.
export function formatPrBody(
  task: Pick<Task, "id">,
  project: Pick<Project, "name">,
  handoff: HandoffFields,
  files: readonly string[],
  isPublic = false,
): string {
  const fileLines = files.slice(0, PR_CHANGED_FILES_CAP).map((f) => `- \`${f}\``);
  if (files.length > PR_CHANGED_FILES_CAP) fileLines.push(`- ...and ${files.length - PR_CHANGED_FILES_CAP} more`);
  const detail = (["Completed", "Changed", "Verified", "Problems", "Discovered"] as const)
    .map((label) => [label, handoff[label.toLowerCase() as "completed"]] as const)
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `### ${label}\n${value.trim()}`);
  if (isPublic) {
    return [
      handoff.summary.trim() || handoff.completed.trim(),
      "",
      "## Changed",
      fileLines.length ? fileLines.join("\n") : "(no file list available)",
      "",
      "## How to verify",
      handoff.howToVerify.trim() || "(not provided)",
    ].join("\n");
  }
  return [
    handoff.summary.trim() || handoff.completed.trim(),
    "",
    `Closes pinboard #${task.id} (${project.name}).`,
    "",
    "## Changed",
    fileLines.length ? fileLines.join("\n") : "(see Agent detail below)",
    "",
    "## How to verify",
    handoff.howToVerify.trim() || "(see Verified under Agent detail below)",
    "",
    "<details><summary>Agent detail</summary>",
    "",
    detail.join("\n\n"),
    "",
    "</details>",
  ].join("\n");
}

// a public repo's PR title is the branch's first commit subject
// (agent-written, and leak-checked with the rest), since the task title is
// pinboard text the agent cannot reword. A private repo keeps the task title
// with its pinboard suffix.
export function formatPrTitle(task: Pick<Task, "id" | "title">, isPublic: boolean, firstCommitSubject: string | null): string {
  if (!isPublic) return `${task.title} (pinboard #${task.id})`;
  return firstCommitSubject?.trim() || task.title;
}

function firstCommitSubject(repoPath: string, base: string): string | null {
  try {
    const out = execFileSync("git", ["log", "--reverse", "--format=%s", `origin/${base}..HEAD`], { cwd: repoPath }).toString();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

// the pinboard calls around a push/PR retry for about a minute.
// #541 finished and pushed, then went to rework on "fetch failed" because
// pinboard was mid-deploy when listPullRequests ran, and a pinboard deploy's
// unavailable gap can outlast withRetry's default 4 x 3s. git push and
// gh pr create are not pinboard calls: git push keeps its own lease handling,
// gh pr create has its own transient-error retry (createPrWithRetry, below).
export const PR_PINBOARD_RETRY = { attempts: 10, delayMs: 6_000 } as const;

function withPinboardRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, PR_PINBOARD_RETRY.attempts, PR_PINBOARD_RETRY.delayMs);
}

// #639 finished and pushed, then went to rework because one
// `gh pr create` hit "GraphQL: Something went wrong while executing your
// query" on an otherwise healthy GitHub. Only these transient failures are
// retried; validation errors, "a pull request already exists" and auth fail
// at once as before.
export const GH_PR_CREATE_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

const TRANSIENT_GH_PATTERNS: readonly RegExp[] = [
  /something went wrong/i,
  /\bHTTP 5\d\d\b/i,
  /\b50[234]\b/,
  /bad gateway|service unavailable|gateway time-?out/i,
  /timed? ?out|timeout/i,
  /ECONNRESET|ETIMEDOUT|connection reset/i,
];

// Reads stderr when there is one: execFileSync's message repeats the whole
// command line, PR body included, which could match a pattern by accident.
export function isTransientGhError(err: unknown): boolean {
  const e = err as { stderr?: Buffer | string; message?: string; code?: string } | null;
  if (e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET") return true;
  const stderr = e?.stderr?.toString().trim();
  const text = stderr || (e?.message ?? String(err));
  if (/already exists/i.test(text)) return false;
  return TRANSIENT_GH_PATTERNS.some((re) => re.test(text));
}

// `create` runs `gh pr create` and returns the URL; `findOpen`
// returns an open PR's URL for the branch or null. A transient error does not
// prove nothing was created, so each retry first checks for the PR.
export async function createPrWithRetry(deps: {
  create: () => string;
  findOpen: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}): Promise<string> {
  const delays = deps.delaysMs ?? GH_PR_CREATE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return deps.create();
    } catch (err) {
      if (attempt >= delays.length || !isTransientGhError(err)) throw err;
      await sleep(delays[attempt]);
      const found = deps.findOpen();
      if (found) return found;
    }
  }
}

function findOpenPrUrl(repoPath: string, branch: string, base: string): string | null {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"],
      { cwd: repoPath },
    ).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

async function pushAndOpenPr(
  repoPath: string,
  branch: string,
  task: Task,
  project: Project,
  handoff: HandoffFields,
  needsForce: boolean,
): Promise<{ url: string; isNew: boolean; pushed: boolean }> {
  // title and body are built before the push so a public repo's
  // leak gate can check them along with the commits and diff.
  const base = resolveDefaultBranch(repoPath);
  const isPublic = isPublicRepo(project.localPath);
  const title = formatPrTitle(task, isPublic, isPublic ? firstCommitSubject(repoPath, base) : null);
  const body = formatPrBody(task, project, handoff, changedFiles(repoPath, base, branch), isPublic);
  const gate = leakGateForPush(repoPath, base, isPublic, title, body);
  if (gate.blocked) throw new LeakBlockedError(basename(project.localPath as string), gate);

  const before = remoteBranchSha(repoPath, branch);
  pushTaskBranch(repoPath, branch, needsForce, before);

  // the lookup is unconditional, not resume-only. A repair handback
  // whose workdir has been swept runs as a *fresh* attempt on a branch that
  // already exists on the remote with an open PR (ensureTaskClone checks that
  // branch out rather than cutting a new one) - `gh pr create` would then fail
  // on the duplicate head branch after the commits had already been pushed,
  // failing the attempt over work that actually landed. A task with no open PR
  // on this branch still gets one created below, which is every other case.
  const pushed = remoteBranchSha(repoPath, branch) !== before;
  const existing = findExistingPr(await withPinboardRetry(() => listPullRequests(task.id)), branch, basename(project.localPath as string));
  if (existing) return { url: existing.url, isNew: false, pushed };

  const url = await createPrWithRetry({
    create: () =>
      execFileSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base],
        { cwd: repoPath },
      )
        .toString()
        .trim(),
    findOpen: () => findOpenPrUrl(repoPath, branch, base),
  });
  return { url, isNew: true, pushed };
}

// submitHandoff (below) writes the structured handoff to its own table, which
// only surfaces in the task's "Live activity" panel - posting it as a comment
// too means a human checking what an attempt did can read it in the comment
// thread instead of scrolling activity, same as the 8ball executor path already does
// by commenting its result alongside its own submitHandoff call.
export function formatHandoffComment(handoff: Omit<HandoffFields, "summary" | "howToVerify"> & { summary?: string }): string {
  const sections: Array<[string, string]> = [
    ["TL;DR", handoff.summary ?? ""],
    ["Completed", handoff.completed],
    ["Changed", handoff.changed],
    ["Verified", handoff.verified],
    ["Problems", handoff.problems],
    ["Discovered", handoff.discovered],
    ["Next", handoff.next],
  ];
  return sections
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `## ${label}\n${value}`)
    .join("\n\n");
}

// the comment posted when a session parks on an unanswered
// question, quoting it so the operator sees what to answer.
export function formatNeedsInputComment(question: string): string {
  const quoted = question.split("\n").map((l) => `> ${l}`).join("\n");
  return `Session ended without commits while waiting on this question (attempt not counted):\n\n${quoted}\n\nAnswer it in the task's chat thread and requeue.`;
}

// labels marking a task whose real work happens somewhere other
// than its repo (a host through `work root`, say), so a session that commits
// nothing can still be a success.
export const NO_REPO_CHANGE_LABELS: readonly string[] = [ROOT_ACCESS_LABEL, "no-repo-change"];

// where a session that made no commits goes. On a normal coding
// task that is a failed attempt (rework), and it has to stay one - a silent
// no-op must never look like success. An ops task (see NO_REPO_CHANGE_LABELS)
// legitimately changes nothing in its repo, so there the handoff is trusted:
// with Completed and Verified both filled in it goes to review with a success
// message instead of being parked in rework. Review rather than done, because
// nothing in the repo (no PR, no CI, no deploy) backs the claim up - a human
// reads the handoff and closes it.
// A session can also say outright that no commit was needed: `outcome`
// `already_done` (the work was already on main, or an alert had already
// cleared) closes the task as done, and `rejected` (a task that says to reject
// it when it does not apply, like an npm consumer bump) closes it as rejected.
// These used to land in rework and stall the flow until a human closed them.
// The claim still needs evidence: Verified for already_done, Completed (the
// reason) for rejected; without it the task goes to rework as before.
export function decideNoCommitOutcome(
  labels: readonly string[],
  handoff: Pick<HandoffFields, "completed" | "verified" | "outcome">,
): { to: "rework" | "review" | "done" | "rejected"; comment: string } {
  if (handoff.outcome === "already_done" && handoff.verified.trim()) {
    return { to: "done", comment: "Session made no commits because the task was already done; the handoff's Verified section shows how that was checked. Closed as done." };
  }
  if (handoff.outcome === "rejected" && handoff.completed.trim()) {
    return { to: "rejected", comment: "Session made no commits and rejected the task; the reason is in the handoff above." };
  }
  const opsLabel = labels.find((l) => NO_REPO_CHANGE_LABELS.includes(l));
  if (!opsLabel) {
    return { to: "rework", comment: "Session completed but made no commits - nothing to open a PR for. Left for human review." };
  }
  const missing = (["completed", "verified"] as const).filter((k) => !handoff[k].trim());
  if (missing.length > 0) {
    return {
      to: "rework",
      comment: `Session made no commits, which is expected for a \`${opsLabel}\` task, but its handoff has no ${missing.join(" or ")} section, so there is nothing to show the work was done. Left for human review.`,
    };
  }
  return {
    to: "review",
    comment: `Session made no commits, which is expected for a \`${opsLabel}\` task - the work happened outside the repo. The handoff reports it completed and verified (see above); ready for a human to confirm and close.`,
  };
}

// The attempt loop's own safety net (`attempt >= opts.attempts`) only holds
// if opts.attempts is an actual number - a bad caller passing NaN here
// (silently produced by a CLI parsing mistake once already, see work.ts's
// numberFlag) makes that comparison always false and the loop never stops.
// Guard the whole RunOptions here too, not just at the CLI layer, since
// runTask is the one place this invariant actually has to hold.
// Named explicitly rather than derived by skipping the keys that aren't
// numbers. The skip-list version walked every key and excluded three by name,
// so `budgetExplicit` (added later, by a past task) fell through to the numeric
// check and threw on its own default - `RunOptions.budgetExplicit must be a
// positive number, got false`. That killed every dispatched run and every
// `work task run`, silently, for as long as it took to notice a task that
// never started. An allow-list cannot rot the same way: a new option is
// ignored here until someone adds it deliberately.
const NUMERIC_RUN_OPTIONS = ["timeoutMs", "budgetUsd", "attempts", "leaseSeconds"] as const;

export function validateRunOptions(opts: RunOptions): void {
  for (const key of NUMERIC_RUN_OPTIONS) {
    const value = opts[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`RunOptions.${key} must be a positive number, got ${JSON.stringify(value)}`);
    }
  }
}

// the budget gate moved to pinboard. foreman used to hold its
// own copy of the rules (checkGovernor's healthy/over_rate/danger/critical
// states, derived from the operator's % readings) and decide for itself.
// pinboard's #139 replaced that with a $ model, and keeping a second
// implementation here would only let the two drift until the Plan screen and
// the dispatcher disagreed about what was allowed to run - and the one the
// operator can actually see would not be the one deciding. See
// getPlanGate/getPlanNext in pinboard.ts.

// I12b: the non-code executor path (see eightball.ts). Single attempt, no
// worktree/lease-renewal/attempt-cap loop - EightBallClient already retries
// its own submit-and-poll a couple of times, and there's no worktree to
// clean up on a hard timeout to justify the same machinery runOneAttempt
// needs. A failure (including EIGHT_BALL_URL/API_KEY not configured) just
// posts why and leaves the task in "rework" for a human, same end state as
// the claude -p path's own failure handling.
async function runEightBallTask(
  taskId: number,
  task: TaskDetail,
  actor: Actor,
  resolvedAgent: ResolvedAgent,
  opts: RunOptions,
): Promise<void> {
  const claim = await claimTaskWithLease(taskId, actor, opts.leaseSeconds);
  if (!claim.leased) {
    await handleClaimRefusal(taskId, actor, claim, task.attemptCount, task.status !== "queued");
    return;
  }

  try {
    await setAttemptCount(taskId, task.attemptCount + 1);
    await addComment(taskId, actor, `Running via the LLM gateway (agent '${resolvedAgent.name}')...`);

    const client = createEightBallClient(actor.actorName);
    let result;
    try {
      result = await client.infer({ capability: "text", prompt: buildEightBallPrompt(task) });
    } catch (err) {
      await health.observe(EIGHT_BALL_CHECK, false, eightBallProject(), `task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    await health.observe(EIGHT_BALL_CHECK, true, eightBallProject());

    await submitHandoff(taskId, {
      ...actor,
      agentName: actor.actorName,
      completed: result.content,
      costUsd: "0",
    });
    await addComment(taskId, actor, result.content);
    await setTaskStatus(taskId, "review");
    console.log(`Task ${taskId}: LLM gateway run succeeded.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addComment(taskId, actor, `LLM gateway run failed: ${message}`);
    await setTaskStatus(taskId, "rework");
    console.log(`Task ${taskId}: LLM gateway run failed, marked for rework.`);
  } finally {
    await releaseLease(taskId).catch(() => {});
  }
}

// the dispatcher's per-seat (and disk) cooldowns. Module-level so
// runTask can start one and dispatchOnce can honour it; in-memory, so a
// restart of foreman-dispatch clears them.
export const infraCooldowns = new InfraCooldowns();

// a 409 from claimTaskWithLease is either "another live run holds
// the lease" (leaseExpiresAt set - that run is progressing the task, nothing
// to do) or a per-project/per-license concurrency refusal (no leaseExpiresAt -
// just "try again shortly"; a lapsed root grant also lands here). When this run has already moved the task off the
// queue (a retry after attempt 1, or a task not in "queued"), returning on a
// capacity refusal would strand it in "executing" with no lease, which
// /plan/next never offers again. So requeue it, keeping only the attempts
// actually spent, and say why. Returns whether it requeued.
export async function handleClaimRefusal(
  taskId: number,
  actor: Actor,
  claim: { reason: string; leaseExpiresAt?: string },
  attemptsSpent: number,
  offQueue: boolean,
): Promise<boolean> {
  console.error(`Task ${taskId}: ${claim.reason}`);
  process.exitCode = 1;
  if (claim.leaseExpiresAt || !offQueue) return false;
  await requeueWithAttemptCount(taskId, attemptsSpent);
  await addComment(
    taskId,
    actor,
    `Could not claim the next attempt: ${claim.reason}. Not a failure of the task; no attempt spent. Requeued so dispatch retries it once that clears (e.g. the concurrency slot frees).`,
  );
  console.log(`Task ${taskId}: capacity refusal mid-run, requeued with attemptCount ${attemptsSpent}.`);
  return true;
}

// pure attempt accounting. An infra failure is refunded; any other
// failure keeps the attempt it already spent when it started.
export function attemptAfterFailure(attempt: number, kind: "infra" | "retryable"): number {
  return kind === "infra" ? attempt - 1 : attempt;
}

export async function runTask(taskId: number, opts: RunOptions = DEFAULT_RUN_OPTIONS): Promise<void> {
  validateRunOptions(opts);

  const task = await getTask(taskId);

  if (task.executorMode !== "agent" && task.executorMode !== "human+agent") {
    throw new Error(`task ${taskId} executorMode is '${task.executorMode}', not 'agent' or 'human+agent'`);
  }
  if (task.autonomyLevel === null || task.autonomyLevel > MAX_AUTONOMY_LEVEL) {
    throw new Error(
      `task ${taskId} autonomyLevel is ${task.autonomyLevel} - I4a only runs tasks at or below ${MAX_AUTONOMY_LEVEL}`,
    );
  }
  if (task.status !== "queued" && task.status !== "executing") {
    throw new Error(`task ${taskId} status is '${task.status}', expected 'queued'`);
  }

  // I12a: an explicit `--agent=` pins the agent as before; otherwise resolve
  // one from the routing rules (task type/label -> agent), falling back to
  // opts.agentName ("foreman-runner") when no rule matches - zero rules
  // configured is a no-op, same behavior as before I12a.
  const [agents, rules, licenses] = await Promise.all([
    listAgents(),
    opts.agentExplicit ? Promise.resolve([]) : listRoutingRules(),
    listLicenses(),
  ]);
  const resolvedAgent: ResolvedAgent | null = opts.agentExplicit
    ? (() => {
        const explicit = agents.find((a) => a.name === opts.agentName && a.enabled);
        // The explicit `--agent=` path bypasses resolveAgentForTask's own
        // autonomy-floor filter entirely (an operator naming an agent by
        // hand is a deliberate override), so runner.ts's own post-hoc check
        // just below remains the only thing enforcing it here - same as
        // before a past task, kept as defense in depth.
        return {
          name: opts.agentName,
          model: explicit?.model ?? null,
          autonomyLevel: explicit?.autonomyLevel ?? null,
          executor: explicit?.executor ?? "cli",
          licenseId: explicit?.licenseId ?? null,
        };
      })()
    : resolveAgentForTask(task, rules, agents, opts.agentName, opts.preferLicenseId);

  if (resolvedAgent === null) {
    throw new Error(
      `task ${taskId} autonomyLevel is ${task.autonomyLevel} - no enabled agent (routed or fallback '${opts.agentName}') has autonomyLevel >= that floor`,
    );
  }

  if (resolvedAgent.autonomyLevel !== null && task.autonomyLevel > resolvedAgent.autonomyLevel) {
    throw new Error(
      `task ${taskId} autonomyLevel is ${task.autonomyLevel} - agent '${resolvedAgent.name}' only runs tasks at or below ${resolvedAgent.autonomyLevel}`,
    );
  }

  const actor: Actor = { actorType: "agent", actorName: resolvedAgent.name };
  const license = resolvedAgent.licenseId !== null ? licenses.find((l) => l.id === resolvedAgent.licenseId) : undefined;
  const spawnAuth = resolveSpawnEnv(license);

  // I12b: an "8ball" agent skips the whole claude -p/worktree/PR pipeline -
  // free local models, no repo/git/gh involved, no Claude budget consumed
  // (so the I6 governor, which is entirely about Claude's own $/window, is
  // deliberately not consulted here - it would otherwise block free work
  // during a Claude budget crunch for no real reason).
  if (resolvedAgent.executor === "8ball") {
    await runEightBallTask(taskId, task, actor, resolvedAgent, opts);
    return;
  }

  // a seat whose token env var is missing never falls back to
  // another seat's login; park the task with the reason instead.
  if (!spawnAuth.ok) {
    await addComment(taskId, actor, spawnAuth.reason).catch(() => {});
    await setTaskStatus(taskId, "rework");
    console.error(`Task ${taskId}: ${spawnAuth.reason}`);
    process.exitCode = 1;
    return;
  }
  const spawnEnv = spawnAuth.env;

  ensureGhAuthenticated();
  const model = resolvedAgent.model ?? DEFAULT_MODEL;

  // Ask pinboard whether this specific task may start, rather than deciding
  // here. `--override` skips the budget gates only; a repo conflict or a full
  // concurrency limit still refuses, since those stop two agents writing the
  // same checkout rather than protecting a budget.
  const gate = await getPlanGate(taskId, resolvedAgent.licenseId ?? undefined, opts.override);
  if (!gate.ok) {
    const wait = gate.waitUntil ? ` (session window resets at ${gate.waitUntil})` : "";
    console.error(`Task ${taskId}: ${gate.reason ?? "refused by the plan"}${wait}`);
    process.exitCode = 1;
    return;
  }

  // the run's budget comes from the gate, which sizes it from this
  // task's own cost estimate, instead of DEFAULT_RUN_OPTIONS' flat $2. An
  // explicit `--budget-usd` from the operator still wins - that flag exists
  // precisely to override the automatic figure for one run.
  // `?? opts.budgetUsd` is deliberate deploy insurance, not defensive noise:
  // these two services deploy separately, so foreman can legitimately be
  // running this code against a pinboard that predates the gate's budgetUsd
  // field. Without the fallback that window passes `--max-budget-usd
  // undefined` to claude and every run dies on it.
  const gateBudgetUsd = typeof gate.budgetUsd === "number" ? gate.budgetUsd : opts.budgetUsd;
  const effectiveOpts: RunOptions = opts.budgetExplicit ? opts : { ...opts, budgetUsd: gateBudgetUsd };
  if (!opts.budgetExplicit && gateBudgetUsd !== opts.budgetUsd) {
    console.log(`Task ${taskId}: run budget $${gateBudgetUsd.toFixed(2)} (from the plan's estimate for this task).`);
  }

  const projects = await listProjects();
  const project = projects.find((p) => p.id === task.projectId);
  if (!project?.localPath) throw new Error(`project for task ${taskId} has no localPath set`);

  let attempt = task.attemptCount;
  let claimedOnce = false;
  let cliUpdateTried = false;

  for (;;) {
    if (attempt >= opts.attempts) {
      // this cap now also covers a run that succeeded but whose
      // CI kept failing on retry (see the ciFailed branch below) - the
      // wording covers both since either way the task needs a human now.
      await addComment(taskId, actor, `Attempt cap (${opts.attempts}) reached without landing a passing, mergeable change. Left for human input.`);
      await setTaskStatus(taskId, "rework");
      console.log(`Task ${taskId}: attempt cap reached, marked for rework.`);
      return;
    }

    const claim = await claimTaskWithLease(taskId, actor, opts.leaseSeconds);
    if (!claim.leased) {
      await handleClaimRefusal(taskId, actor, claim, attempt, claimedOnce || task.status !== "queued");
      return;
    }
    claimedOnce = true;

    attempt += 1;
    await setAttemptCount(taskId, attempt);
    await addComment(taskId, actor, `Attempt ${attempt}/${opts.attempts} starting.`);

    const renewTimer = setInterval(() => {
      renewLease(taskId, opts.leaseSeconds).catch((err) => console.error(`lease renewal failed: ${String(err)}`));
    }, (opts.leaseSeconds * 1000) / 2);

    // try to resume the previous attempt's own session before
    // falling back to a fresh worktree - covers both this loop's own
    // automatic retry and a fresh runTask() call after a human requeues the
    // task from review/rework.
    const prepared = await prepareAttempt(task, project, projects, actor, resolvedAgent.licenseId ?? null);
    const resume = prepared.mode === "resume" ? prepared : undefined;

    let outcome: AttemptOutcome;
    try {
      outcome = await runOneAttempt(task, project, projects, attempt, effectiveOpts, actor.actorName, model, spawnEnv, resume);
    } finally {
      clearInterval(renewTimer);
      await releaseLease(taskId).catch(() => {});
    }

    // Persist (or clear) what a later attempt would need to resume this one -
    // done for every outcome, ok or not, since even a failed attempt with a
    // captured session_id is worth resuming into next time.
    if (outcome.retained) {
      // A fresh attempt's own workdir/branch is brand new, even when its
      // sessionId is absent (crashed before a result line) - keeping the
      // *old* session id here would pair it with a workdir that session
      // never touched. Only a resumed attempt without a fresh sessionId
      // (unusual, but no reason to assume the old one died) should carry the
      // prior id forward.
      // pinboard's column is still called activeWorktreeName (no
      // migration for a rename that changes nothing) - what it holds now is
      // the task workdir's directory name, and it stays the flag the sweep
      // filters on via listTasks({hasActiveWorktree: true}).
      task.claudeSessionId = outcome.sessionId ?? (resume ? task.claudeSessionId : null);
      // the owner travels with the id, always. A fresh session id
      // belongs to the seat that just produced it; a carried-forward one
      // keeps the seat it was resumed under, which is this one or
      // prepareAttempt would not have resumed it.
      task.claudeSessionLicenseId = task.claudeSessionId === null ? null : resolvedAgent.licenseId ?? null;
      task.activeWorktreeName = outcome.workdirName;
    } else {
      task.claudeSessionId = null;
      task.claudeSessionLicenseId = null;
      task.activeWorktreeName = null;
    }
    await setSessionState(taskId, {
      claudeSessionId: task.claudeSessionId,
      claudeSessionLicenseId: task.claudeSessionLicenseId,
      activeWorktreeName: task.activeWorktreeName,
    }).catch(
      (err) => console.error(`could not persist session state for task ${taskId}: ${String(err)}`),
    );

    const infraCause = outcome.ok || outcome.terminal ? null : classifyInfraError(outcome.error);
    // claude ran (or failed for its own reasons), so this seat's
    // login and CLI are fine; auth/cli_outdated alert below instead.
    if (infraCause === null) await health.observe(seatCheck(resolvedAgent.licenseId), true, "foreman");
    if (!outcome.ok) {
      if (infraCause) {
        // never spend an attempt on the machine or the seat, and
        // post one comment for the whole event rather than "failed" + "requeued".
        attempt = attemptAfterFailure(attempt, "infra");
        let updateNote = "";
        if (infraCause === "cli_outdated" && !cliUpdateTried) {
          cliUpdateTried = true;
          const update = updateClaude();
          console.log(
            `Task ${taskId}: claude CLI outdated, ran 'claude update' (${update.before ?? "?"} -> ${update.after ?? "?"}${update.error ? `, error: ${update.error}` : ""}).`,
          );
          if (update.changed) {
            await addComment(
              taskId,
              actor,
              `Attempt ${attempt + 1} hit an outdated claude CLI; updated it (${update.before} -> ${update.after}) and retrying without spending an attempt.`,
            );
            continue;
          }
          updateNote = update.error ? ` 'claude update' failed: ${update.error}.` : ` 'claude update' did not change the version (${update.before ?? "unknown"}).`;
        }
        const key = infraCause === "disk_full" ? DISK_COOLDOWN_KEY : seatCooldownKey(resolvedAgent.licenseId);
        const until = infraCooldowns.start(key, infraCause, infraCooldownMs());
        await health.observe(
          infraCause === "disk_full" ? DISK_CHECK : seatCheck(resolvedAgent.licenseId),
          false,
          "foreman",
          `${describeInfraCause(infraCause)}.${updateNote} Dispatch to it paused until ${until.toISOString()}. First hit on task ${taskId}.`,
        );
        await requeueWithAttemptCount(taskId, attempt);
        await addComment(
          taskId,
          actor,
          `Infrastructure failure, not a failure of the task: ${describeInfraCause(infraCause)}.${updateNote} Attempt ${attempt + 1} refunded and the task requeued; ${infraCause === "disk_full" ? "dispatch" : "this seat"} is paused until ${until.toISOString()}.\n\n${outcome.error.slice(0, 500)}`,
        );
        console.log(`Task ${taskId}: infra failure (${infraCause}), requeued without spending an attempt; ${key} cooling down until ${until.toISOString()}.`);
        return;
      }

      await addComment(taskId, actor, `Attempt ${attempt} failed: ${outcome.error}`);
      if (outcome.terminal) {
        await setTaskStatus(taskId, "rework");
        console.log(`Task ${taskId}: attempt ${attempt} ended by operator control request, marked for rework.`);
        return;
      }

      // an attempt is only spent on a failure a retry could
      // plausibly fix. Before this, every non-terminal failure fell through
      // to `continue` and the attempt cap did the rest - which is how task
      // #117 spent three attempts on a $0 session-limit wall and then marked
      // itself for rework, and how #115 repeated the same thing unaided.
      const failure = classifyAttemptFailure({
        error: outcome.error,
        costUsd: outcome.costUsd ?? null,
        capUsd: effectiveOpts.budgetUsd,
      });

      if (failure.kind === "session_limit") {
        // Refund the attempt: this one told us nothing about the task, only
        // about the clock. Without the refund a task can exhaust its cap
        // against a wall it never had a chance to clear.
        attempt -= 1;
        // Report before requeueing, so the dispatcher that picks this task
        // up next already knows to wait rather than immediately restarting
        // it into the same wall.
        await reportSessionLimit({
          resetsAt: failure.resetsAt,
          licenseId: resolvedAgent.licenseId ?? undefined,
          taskId,
          rawError: failure.raw,
        }).catch((err) =>
          console.error(`Task ${taskId}: could not report the session limit to pinboard: ${String(err)}`),
        );
        // One patch, not two - see requeueWithAttemptCount on why splitting
        // these would turn the refund into a full attempt reset.
        await requeueWithAttemptCount(taskId, attempt);
        await addComment(
          taskId,
          actor,
          `Hit the session limit, which resets at ${failure.resetsAt.toISOString()}. Attempt ${attempt + 1} refunded and the task requeued - it will be picked up automatically once the window resets. This is not a failure of the task itself.`,
        );
        console.log(`Task ${taskId}: session limit until ${failure.resetsAt.toISOString()}, requeued without spending an attempt.`);
        return;
      }

      // an unusable session id is the one failure class the runner
      // can fix by itself - drop it and go again cold. The attempt is
      // refunded for the same reason a session limit's is: it told us nothing
      // about the task, only about the session store. This cannot loop,
      // because the retry that follows has no session id left to resume and
      // so cannot produce this error again; the `resume` guard makes that
      // explicit rather than relying on it, so a "no conversation found"
      // arriving from a *cold* start is treated as an ordinary retryable
      // failure and still spends its attempt.
      //
      // The clear has to be written back explicitly: the retained-state
      // persist above has already carried the stale id forward (this attempt
      // resumed, and produced no session id of its own), which is precisely
      // how #166 and #169 hit the identical wall three times each.
      if (failure.kind === "stale_session" && resume) {
        attempt -= 1;
        task.claudeSessionId = null;
        task.claudeSessionLicenseId = null;
        await setSessionState(taskId, {
          claudeSessionId: null,
          claudeSessionLicenseId: null,
          activeWorktreeName: task.activeWorktreeName,
        }).catch((err) => console.error(`could not clear the stale session for task ${taskId}: ${String(err)}`));
        await addComment(
          taskId,
          actor,
          `The resumed session id was not found in this seat's session store, so it has been dropped and attempt ${attempt + 1} refunded - the next attempt starts cold. This is not a failure of the task itself.`,
        );
        console.log(`Task ${taskId}: stale session id dropped, retrying from a cold start without spending an attempt.`);
        continue;
      }

      if (failure.kind === "budget_exhausted") {
        // Never silently escalate spend across attempts: each attempt gets a
        // fresh cap, so retrying a task that already spent one just buys the
        // same wall again at full price.
        await setTaskStatus(taskId, "rework");
        await addComment(
          taskId,
          actor,
          `Ran out of budget at $${failure.costUsd.toFixed(4)} against a $${failure.capUsd.toFixed(2)} cap. Not retrying: every attempt gets a fresh cap, so a task that needs more than this cannot finish however many attempts it is given. Raise this task's estimate (or re-run with --budget-usd) if it genuinely needs more.`,
        );
        console.log(`Task ${taskId}: budget exhausted at $${failure.costUsd}, marked for rework.`);
        return;
      }

      continue;
    }

    const handoff = await submitHandoff(taskId, {
      ...actor,
      agentName: actor.actorName,
      completed: outcome.handoff.completed,
      changed: outcome.handoff.changed,
      verified: outcome.handoff.verified,
      problems: outcome.handoff.problems,
      discovered: outcome.handoff.discovered,
      next: outcome.handoff.next,
      summary: outcome.handoff.summary || undefined,
      estimatedNextEffort: outcome.handoff.estimatedNextEffort ?? undefined,
      costUsd: String(outcome.totalCostUsd),
      durationMs: outcome.durationMs,
      numTurns: outcome.numTurns,
      permissionDenials: outcome.permissionDenials,
    });
    await addComment(taskId, actor, formatHandoffComment(outcome.handoff));

    if (!outcome.hasCommits) {
      // a session that ended on a question nobody answered is
      // waiting on the operator, not a failed attempt - park it in
      // needs_input and hand the attempt back.
      const thread = await getTaskChatThread(taskId);
      const question = thread ? pendingQuestion(thread, await getChatMessages(thread.id)) : null;
      if (question !== null) {
        await setAttemptCount(taskId, attempt - 1);
        await addComment(taskId, actor, formatNeedsInputComment(question));
        await advancePipeline(taskId, actor, "needs_input");
        console.log(`Task ${taskId}: attempt ${attempt} ended on an unanswered question, marked needs_input.`);
        return;
      }
      const decision = decideNoCommitOutcome(
        task.labels.map((l) => l.name),
        outcome.handoff,
      );
      await addComment(taskId, actor, decision.comment);
      await setTaskStatus(taskId, decision.to);
      console.log(`Task ${taskId}: attempt ${attempt} completed with no changes, marked for ${decision.to}.`);
      return;
    }

    // A past task follow-up: a related repo (see relatedRepoTargets) commits
    // on this same branch in its own worktree, so it gets pushed and opened
    // as its own PR/merge/deploy here too, exactly like this task's own
    // repo - one task can now land changes across several repos instead of
    // silently stranding the related-repo commits uncommitted on main (the
    // a past task bug this whole worktree-per-repo scheme exists to close).
    const repoTargets = [repoTargetFor(taskId, project), ...outcome.relatedTargets].filter((t) =>
      branchHasCommits(t.repoPath, outcome.branch),
    );
    // the session ends here. Everything after the PR - waiting for
    // CI, merging, deploying, the healthcheck - is plain work with no
    // judgement in it, and it used to run inline (mergeAndDeploy), holding
    // this task's Claude session, its lease and the one agent concurrency
    // slot for the ten-plus minutes it takes. It is driven off the task's own
    // status now by foreman-pipeline.service instead (see pipeline.ts), which
    // is why nothing below waits for any of it.
    // this used to have no catch of its own, so a push/PR failure
    // here (found live: a stale --force-with-lease rejection, see
    // workdir.ts's refreshRemoteBranch) threw straight out of runTask after
    // the handoff comment had already been posted - the task was left
    // claiming a completed, correct fix with no PR, no rework status and no
    // comment explaining why, visible only in this dispatcher's own systemd
    // journal. The fix itself is real either way; what was missing is a
    // human-visible trail leading back to it.
    try {
      for (const target of repoTargets) {
        const pr = await pushAndOpenPr(
          target.repoPath,
          outcome.branch,
          task,
          target.project,
          outcome.handoff,
          pushNeedsForce(resume !== undefined, task.repairReason),
        );
        if (pr.isNew) {
          await withPinboardRetry(() => addComment(taskId, actor, `Opened ${pr.url} for review.`));
          await withPinboardRetry(() =>
            addPullRequest(taskId, {
              url: pr.url,
              repoSlug: basename(target.project.localPath as string),
              branchName: outcome.branch,
              attemptNumber: task.attemptCount,
            }),
          );
        } else if (pr.pushed) {
          await withPinboardRetry(() => addComment(taskId, actor, `Pushed additional commits to the existing PR: ${pr.url}`));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof LeakBlockedError) {
        await addComment(taskId, actor, formatLeakComment(err.repoSlug, err.result)).catch(() => {});
        await setTaskStatus(taskId, "rework");
        console.log(`Task ${taskId}: attempt ${attempt} succeeded but the leak check blocked the push, marked for rework: ${message}`);
        return;
      }
      await addComment(
        taskId,
        actor,
        `The fix above is committed in this task's retained workdir, but pushing it and opening its PR failed: ${message}\n\nNothing was lost - the commits are still there for the next attempt to pick up and retry.`,
      ).catch(() => {});
      await setTaskStatus(taskId, "rework");
      console.log(`Task ${taskId}: attempt ${attempt} succeeded but push/PR failed, marked for rework: ${message}`);
      return;
    }

    // withRetry because this is the call that decides whether the pipeline
    // ever picks the task up: losing it would strand a task on `handoff` with
    // an open PR and nothing watching it (exactly what a past task hit against a
    // pinboard that was mid-restart). Nothing polls for that, so it is worth
    // a few retries here.
    await withRetry(() => advancePipeline(taskId, actor, "awaiting_ci"));
    console.log(
      `Task ${taskId}: attempt ${attempt} succeeded, handoff #${handoff.id}, PRs: ${repoTargets.map((t) => basename(t.project.localPath as string)).join(", ")} - handed to the pipeline.`,
    );
    return;
  }
}

// rankRunnableTasks/pickNextRunnableTask/findNextRunnableTask and
// the depends_on check that went with them all moved into pinboard's plan.ts.
// They encoded the queue's ordering and eligibility rules, which the Plan
// screen has to know too - two copies would eventually disagree, and the copy
// the operator can see is not the one that decides. `GET /plan/next` is now
// the single answer to "what should run next", already gated on budget,
// concurrency and repo conflicts.

export interface DispatchResult {
  ran: boolean;
  // the plan can hand back more than one startable task when the
  // concurrency limit allows it, so this is a list rather than a single id.
  taskIds: number[];
  // Set when the plan says the right move is to sleep rather than re-poll -
  // the session window's budget is spent but the window hasn't expired yet.
  // with more than one license polled per cycle this is the
  // *earliest* of their waits - sleeping past the first seat that frees up
  // would idle it for no reason.
  waitUntil: string | null;
  reason: string | null;
}

// tasks currently running in the background, keyed by id - see
// dispatchOnce. Module-level rather than threaded through call sites since
// there is exactly one dispatch loop per foreman process (work.ts's `work
// dispatch`), the same assumption sweepTaskWorkdirs' lastWorkdirSweepAt
// already makes.
// the value carries the license the run belongs to as well as the
// promise, because concurrency is a per-seat limit - counting every in-flight
// task against whichever license the loop happens to be asking for would let
// one busy seat starve the other out of its own capacity.
interface InFlightRun {
  run: Promise<void>;
  // undefined only on the pre-#150 single-pass fallback, where there are no
  // seats to tell apart in the first place.
  licenseId: number | undefined;
}

const inFlightTasks = new Map<number, InFlightRun>();

// A past task capped this at a 5h window so a bad timestamp couldn't park
// dispatch indefinitely. It is now much shorter: pinboard's session window is
// an estimate, and the operator can reset it from the Plan screen when it is
// wrong. A loop asleep until the estimated reset would ignore that for hours.
// Re-polling only asks pinboard's /plan/next, never Claude, so it costs nothing.
const MAX_WAIT_SLEEP_MS = 5 * 60 * 1000;

// The last refusal reason logged, so an unchanged one isn't repeated on every
// poll - see runDispatchLoop.
let lastDispatchReason: string | null = null;

// One poll-and-maybe-start cycle.
//
// starting a task does not block this function until it finishes -
// a task blocked on an unanswered question, or just one still mid-run, used to
// hold the loop's only `await runTask()` hostage so no other queued task could
// even be considered until it resolved. Firing runTask here and tracking it in
// inFlightTasks instead lets the next tick start a different task.
//
// which task(s) to start is pinboard's decision now, not foreman's.
// `GET /plan/next` returns them already gated on the period budget, the open
// 5h session window, the concurrency limit and the repo-conflict rule, so this
// function no longer ranks anything or evaluates a budget - it starts what it
// is given and reports what it was told when given nothing.
//
// inFlightTasks still matters despite pinboard doing the gating: a task's
// status only flips to "executing" once its claim lands, which happens inside
// runTask, so between starting one here and that claim landing pinboard would
// still offer the same task (and would not count it against concurrency).
// Filtering by what is already in flight, and capping at the plan's own
// concurrency figure, closes that window.
// How many more tasks this seat may start right now. Two caps apply and
// either can bind: the global one stops the system running too many paid
// agents at once whoever owns them; the seat one stops one seat taking the
// whole allowance. Both count foreman's own in-flight runs rather than
// pinboard's claimed ones, because a task started here doesn't become
// "executing" until its claim lands inside runTask.
//
// A past task made the seat term real - before it, pinboard reported the same
// global figure for every license, so it could never bind. Replaced task
// #130's selectStartable, which sliced the candidate list to this number
// *before* anything knew which seat owned each candidate - see dispatchOnce
// on why that starved a seat.
export function dispatchCapacity(
  seatConcurrency: number,
  globalConcurrency: number,
  totalInFlight: number,
  seatInFlight: number,
): number {
  return Math.max(0, Math.min(globalConcurrency - totalInFlight, seatConcurrency - seatInFlight));
}

// How long to wait before the next poll. Normally just the configured
// interval; when the plan handed back a `waitUntil` (the session window's
// budget is spent but the window hasn't expired), sleep until that instead of
// re-earning the same refusal every interval. Never shorter than the normal
// interval, and capped at MAX_WAIT_SLEEP_MS so an operator's manual session
// reset in pinboard is picked up within minutes. Pure so the boundaries are testable without a clock.
export function computeSleepMs(waitUntil: string | null, intervalSeconds: number, now = Date.now()): number {
  const interval = intervalSeconds * 1000;
  if (!waitUntil) return interval;
  const waitMs = new Date(waitUntil).getTime() - now;
  if (!Number.isFinite(waitMs) || waitMs <= 0) return interval;
  return Math.min(Math.max(waitMs, interval), MAX_WAIT_SLEEP_MS);
}

// the earliest of several licenses' waits, since sleeping until the
// latest would idle whichever seat frees up first.
//
// a null is a seat that is *not* waiting (its queue was merely
// empty, or its concurrency full), so it must keep the loop on the normal
// interval. Ignoring nulls let one seat's 5h window park the whole loop: on
// 2026-09-22 peter's seat asked to wait 46min, marek's had nothing yet, and
// #206 queued minutes later sat untouched on marek's free seat until
// peter's window reset.
export function earliestWait(waits: readonly (string | null)[]): string | null {
  if (waits.some((w) => w === null)) return null;
  const times = waits
    .filter((w): w is string => w !== null)
    .map((w) => [w, new Date(w).getTime()] as const)
    .filter(([, ms]) => Number.isFinite(ms));
  if (times.length === 0) return null;
  return times.reduce((min, cur) => (cur[1] < min[1] ? cur : min))[0];
}

let lastPreflightState: "ok" | "refused" | null = null;

// refuse to claim anything when the disk holding the task
// workdirs is too full to clone into - a claimed task would only fail its
// workdir preparation. Sweeps once first, since stale workdirs are the
// usual reason the disk filled up. Logs only when the outcome changes, so a
// healthy dispatcher logs one preflight line after start and stays quiet.
async function diskPreflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cooling = infraCooldowns.active(DISK_COOLDOWN_KEY);
  if (cooling) return { ok: false, reason: `disk cooldown until ${cooling.until.toISOString()} (${cooling.cause})` };
  const minBytes = minFreeBytes();
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const free = freeBytesAt(TASK_ROOT);
  let decision = preflightDecision(free, minBytes);
  let after: number | undefined;
  if (decision === "sweep") {
    const { swept } = await sweepTaskWorkdirs(Date.now(), true);
    after = freeBytesAt(TASK_ROOT);
    console.log(`dispatch: preflight: ${gb(free)} GB free on ${TASK_ROOT}, below ${gb(minBytes)} GB - swept ${swept} workdir(s), now ${gb(after)} GB`);
    decision = preflightDecision(free, minBytes, after);
  }
  const state = decision === "ok" ? "ok" : "refused";
  if (state !== lastPreflightState || decision !== "ok") {
    console.log(`dispatch: preflight ${state}: ${gb(after ?? free)} GB free on ${TASK_ROOT} (min ${gb(minBytes)} GB)${decision === "ok" ? "" : ", not claiming"}`);
  }
  lastPreflightState = state;
  if (decision === "ok") {
    await health.observe(DISK_CHECK, true, "foreman");
    return { ok: true };
  }
  const until = infraCooldowns.start(DISK_COOLDOWN_KEY, "disk below FOREMAN_MIN_FREE_GB", infraCooldownMs());
  await health.observe(DISK_CHECK, false, "foreman", `${gb(after ?? free)} GB free on ${TASK_ROOT}, below ${gb(minBytes)} GB after a sweep; not claiming until ${until.toISOString()}`);
  console.log(`dispatch: disk cooldown until ${until.toISOString()}`);
  return { ok: false, reason: `disk below ${gb(minBytes)} GB free, cooling down until ${until.toISOString()}` };
}

// `start` is runTask in production; the dispatcher tests pass a stub so a
// cycle can be checked without spawning a real run.
export async function dispatchOnce(
  opts: RunOptions = DEFAULT_RUN_OPTIONS,
  start: (taskId: number, opts: RunOptions) => Promise<void> = runTask,
): Promise<DispatchResult> {
  const preflight = await diskPreflight();
  if (!preflight.ok) return { ran: false, taskIds: [], waitUntil: null, reason: preflight.reason };

  // one poll per enabled license, not one poll full stop. Each
  // seat has its own budget period and session window, so a single /plan/next
  // call answered for pinboard's default license - which is what happened
  // before this task - both gated the wrong budget and meant a second seat
  // could never start anything of its own.
  const licenses = (await listLicenses()).filter((l) => l.enabled);
  // An empty list can only mean a pinboard older than #150; keep the loop
  // working by asking once with no seat in mind, exactly as it used to.
  const seats: (number | undefined)[] = licenses.length > 0 ? licenses.map((l) => l.id) : [undefined];

  // Fetched once per cycle rather than once per seat - routing has to be
  // resolved here (not just inside runTask) so a task a rule sends to another
  // seat's agent isn't counted against this seat's budget and capacity.
  const [agents, rules] = await Promise.all([listAgents(), listRoutingRules()]);

  const started: number[] = [];
  const waits: (string | null)[] = [];
  const reasons: string[] = [];

  for (const licenseId of seats) {
    const cooling = infraCooldowns.active(seatCooldownKey(licenseId));
    if (cooling) {
      reasons.push(`${seatName(licenses, licenseId)}: infra cooldown until ${cooling.until.toISOString()} (${cooling.cause})`);
      // a cooling seat is waiting too, just not on pinboard's
      // session window. Without this the loop could sleep through the end of
      // its cooldown behind another seat's longer 5h wait.
      waits.push(cooling.until.toISOString());
      continue;
    }
    // Independent per seat, the same reason pollPullRequests isolates each PR:
    // one seat whose poll throws (pinboard hiccup, a task that vanished
    // mid-cycle) must not take the seats ordered behind it down with it for a
    // whole cycle.
    try {
      const plan = await getPlanNext(licenseId, opts.override);
      const seatInFlight = [...inFlightTasks.values()].filter((r) => r.licenseId === licenseId).length;
      const capacity = dispatchCapacity(plan.concurrency, plan.concurrencyGlobal, inFlightTasks.size, seatInFlight);

      let startedHere = 0;
      // Ownership is resolved before capacity is spent, not after. Capping the
      // candidate list first would let the top of a shared, deterministically
      // ordered queue - tasks a routing rule sends to the *other* seat - eat
      // this seat's whole window every cycle, starving it of its own work
      // indefinitely rather than for one tick.
      for (const candidate of plan.tasks) {
        if (startedHere >= capacity) break;
        if (inFlightTasks.has(candidate.taskId)) continue;
        // Routed to another seat's agent (or to no eligible agent at all): not
        // this seat's work. The seat that owns it offers it on its own pass.
        if (!(await ownsCandidate(candidate.taskId, licenseId, rules, agents, opts))) continue;

        const run = start(candidate.taskId, { ...opts, preferLicenseId: licenseId })
          .catch((err) => {
            console.error(`dispatch: task ${candidate.taskId} failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            inFlightTasks.delete(candidate.taskId);
          });
        inFlightTasks.set(candidate.taskId, { run, licenseId });
        started.push(candidate.taskId);
        startedHere += 1;
      }

      if (startedHere === 0) {
        waits.push(plan.waitUntil);
        if (plan.reason) reasons.push(licenses.length > 1 ? `${seatName(licenses, licenseId)}: ${plan.reason}` : plan.reason);
      }
    } catch (err) {
      // a failed poll says nothing about a session window, so this
      // seat keeps the loop on the normal interval rather than leaving it to
      // sleep behind whichever other seat is waiting.
      waits.push(null);
      console.error(
        `dispatch: ${seatName(licenses, licenseId)} could not be polled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (started.length === 0) {
    return { ran: false, taskIds: [], waitUntil: earliestWait(waits), reason: reasons.join("; ") || null };
  }

  return { ran: true, taskIds: started, waitUntil: null, reason: null };
}

function seatName(licenses: readonly License[], licenseId: number | undefined): string {
  return licenses.find((l) => l.id === licenseId)?.name ?? `license ${licenseId}`;
}

// Whether this seat is the one that would actually run this candidate. Needs
// the task itself (its type and labels) because the plan candidate
// deliberately carries only what the forecast needs.
//
// An undefined seat is the pre-#150 pinboard fallback - a single unscoped
// pass, where there is no other seat to leave anything for, so everything the
// plan offered is this pass's to start.
async function ownsCandidate(
  taskId: number,
  licenseId: number | undefined,
  rules: RoutingRule[],
  agents: Agent[],
  opts: RunOptions,
): Promise<boolean> {
  if (licenseId === undefined) return true;
  let task: TaskDetail;
  try {
    task = await getTask(taskId);
  } catch (err) {
    console.error(`dispatch: could not read task ${taskId} to route it: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  return resolveAgentForTask(task, rules, agents, opts.agentName, licenseId)?.licenseId === licenseId;
}

// nothing in foreman is triggered when a human approves/rejects a
// task in pinboard (that's a pinboard-only status PATCH with no filesystem
// access to clean anything up), so retained workdirs are reclaimed here
// instead, on a poll.
let lastWorkdirSweepAt = 0;

// a task that has finished (done/rejected), or that has simply
// sat retained past WORKDIR_RETENTION_MS regardless of status, gets its
// workdir removed and its session state cleared. Cheap enough to call every
// dispatch tick - it no-ops until the sweep interval has elapsed.
//
// one recursive delete of /app/tasks/task-<id> replaces the old
// per-repo `git worktree remove` plus `git branch -D` dance, which is also
// what made a past task's bug possible (the primary worktree was swept and
// activeWorktreeName cleared, permanently orphaning every related repo's
// worktree because nothing could find the task again). Nothing lives outside
// the task's own directory now, so there is nothing left to orphan.
export async function sweepTaskWorkdirs(now = Date.now(), force = false): Promise<{ swept: number }> {
  if (!force && now - lastWorkdirSweepAt < WORKDIR_SWEEP_INTERVAL_MS) return { swept: 0 };
  lastWorkdirSweepAt = now;

  const candidates = await listTasks({ hasActiveWorktree: true });
  let swept = 0;
  for (const task of candidates) {
    const prs = task.status === "review" ? await listPullRequests(task.id).catch(() => undefined) : undefined;
    if (!isSweepable(task, now, WORKDIR_RETENTION_MS, prs)) continue;
    cleanupWorkdir(task.id);
    await setSessionState(task.id, { claudeSessionId: null, claudeSessionLicenseId: null, activeWorktreeName: null }).catch((err) =>
      console.error(`could not clear session state for task ${task.id}: ${String(err)}`),
    );
    swept += 1;
  }

  // A past task's trust entries are written per workspace path, which is now
  // one path per task per repo - drop the ones whose directory this sweep (or
  // an earlier one) just removed.
  pruneTrustedWorkdirs(CLAUDE_CONFIG_PATH);
  return { swept };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// used to run one task at a time to completion before polling
// again, reasoning that the governor's default concurrency limits (I6) are
// all 1 anyway - true for two tasks that are both actually executing, but
// not for a task parked waiting on an unanswered question (see governor.ts's
// getExecutingSnapshot, which excludes that case from the count on purpose).
// dispatchOnce now starts a task without waiting for it to finish, so this
// loop keeps polling and can start a different queued task in the meantime;
// pinboard's own concurrency checks at claim time are the real limit, not
// this loop's own pacing. `signal` lets the CLI ask the loop to stop cleanly
// between polls (see work.ts's SIGINT/SIGTERM handling) without cutting off
// any task that's already running in the background.
export async function runDispatchLoop(
  intervalSeconds: number,
  opts: RunOptions = DEFAULT_RUN_OPTIONS,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    let waitUntil: string | null = null;
    try {
      const result = await dispatchOnce(opts);
      if (result.ran) {
        console.log(`dispatch: started ${result.taskIds.map((id) => `#${id}`).join(", ")}`);
      } else {
        waitUntil = result.waitUntil;
        // Only log a refusal when it changes, so a quiet loop doesn't write the
        // same line every interval for hours - "nothing runnable in the queue"
        // is the normal resting state here, not an incident.
        if (result.reason && result.reason !== lastDispatchReason) {
          console.log(`dispatch: nothing started - ${result.reason}`);
        }
      }
      lastDispatchReason = result.ran ? null : result.reason;
    } catch (err) {
      console.error(`dispatch: poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (signal?.aborted) return;
    // the I8 chat poller used to run here, sharing this loop. It
    // moved to its own `work chat watch` process (foreman-chat.service) for
    // two reasons, both observed live: a chat turn parked on an unanswered
    // permission request blocked task dispatch for as long as the operator
    // took to answer (up to permission-server.ts's 30-minute wait), since
    // this `await` sat in front of the next dispatchOnce; and restarting
    // this service - which every deploy does - SIGTERMed whatever `claude`
    // child a live chat turn had running, losing the turn and posting a
    // parse error into the thread as the agent's reply.
    if (signal?.aborted) return;
    // the PR state sync moved to the pipeline loop (work.ts).
    // same independent-try/catch sharing as the pollers above -
    // internally rate-limited to WORKDIR_SWEEP_INTERVAL_MS, so this is a
    // cheap no-op on most ticks.
    try {
      const sweepResult = await sweepTaskWorkdirs();
      if (sweepResult.swept > 0) console.log(`dispatch: swept ${sweepResult.swept} task workdir(s)`);
    } catch (err) {
      console.error(`dispatch: workdir sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (signal?.aborted) return;
    // sleep until the session window resets rather than re-polling
    // into the same refusal - see computeSleepMs.
    const sleepMs = computeSleepMs(waitUntil, intervalSeconds);
    if (sleepMs > intervalSeconds * 1000) {
      console.log(`dispatch: sleeping ${(sleepMs / 60000).toFixed(0)}min until the session window resets`);
    }
    await sleep(sleepMs, signal);
  }
}
