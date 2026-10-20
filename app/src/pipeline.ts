// A past task: the post-PR pipeline's doing half.
//
// Everything between "the agent pushed a branch and opened a PR" and "a human
// looks at the result" - poll CI, merge, deploy, healthcheck - is plain code
// with no judgement in it. It used to run inside runTask (as mergeAndDeploy),
// which meant a task held its Claude session, its lease and the one agent
// concurrency slot for the ten-plus minutes that takes. It runs here instead,
// in its own cheap process (foreman-pipeline.service), against the statuses
// pinboard's #157 added.
//
// The poller is deliberately stateless: `GET /pipeline/next` says what stage
// each task is in and how long it has been there, and every move goes back
// through `POST /tasks/:id/pipeline`, which refuses anything the state
// machine does not allow. Restarting this process mid-pipeline loses nothing.
//
// A past task split failure handling in two. A stage that fails in a way an
// agent can plausibly fix (red CI, a conflict a rebase cannot clear, a deploy
// or healthcheck that came back bad) hands the task BACK to `queued` with a
// repairReason and the evidence, and the next dispatch resumes that task's own
// session on its own branch to fix it. A stage that fails in a way no agent
// can fix from a repo checkout - a deploy lock nothing ever released, a task
// that reached the pipeline with no PR recorded at all - still parks in
// `rework` for a human. The dividing line is "would another agent run have
// anything to act on", not "how bad is it".

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homelabRoot, workspaceRoot } from "./paths.js";
import { hostsNeedingSync, parseSyncResponse, type KeyringConfig } from "./keyring-sync.js";
import { basename, join } from "node:path";
import {
  addComment,
  advancePipeline,
  getComments,
  getPipelineNext,
  listPullRequests,
  updatePullRequestState,
  type Actor,
  type PipelineStage,
  type PipelineTask,
  type PullRequest,
  type RepairReason,
} from "./pinboard.js";
import { rebaseOntoMain, repoWorkdir, resolveDefaultBranch, withDeployLock } from "./workdir.js";

// paths.ts is the one derivation - a project's localPath is always
// org/name, resolved under this root.
const WORKSPACE_ROOT = workspaceRoot();
export const HOMELAB_ROOT = homelabRoot();

// Who the poller is on a task's history. `agent` rather than `human` so the
// UI shows these as automation, but it is not an agent in the Claude sense -
// it spawns no session and spends no budget.
export const PIPELINE_ACTOR: Actor = { actorType: "agent", actorName: "foreman-pipeline" };

// How often the loop asks pinboard what is in flight. Shorter than the
// dispatcher's own interval: this poll is a single cheap GET that usually
// comes back empty, and the stages it drives are minutes long, so a coarse
// interval would add real latency to every task's tail.
export const DEFAULT_PIPELINE_INTERVAL_SECONDS = 30;

// I13's CI wait, unchanged in substance - the clock is now the stage's own
// `pipelineStageEnteredAt` rather than a loop-local start time, so it
// survives this process restarting. 30 minutes by default, so a cold build
// on a slow runner is not read as a failure; FOREMAN_CI_TIMEOUT_MINUTES
// overrides it per install.
export const DEFAULT_CI_TIMEOUT_MINUTES = 30;

export function ciTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FOREMAN_CI_TIMEOUT_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 && env.FOREMAN_CI_TIMEOUT_MINUTES !== "" ? raw : DEFAULT_CI_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

const CI_TIMEOUT_MS = ciTimeoutMs();
// `gh run list` can come back empty for a few seconds right after
// a push while GitHub registers the workflow. A past task merged 4 seconds
// after opening its PR because that gap read as "this repo has no CI".
const CI_APPEAR_GRACE_MS = 60 * 1000;
// A deploy that cannot get the repo's deploy lock keeps waiting across polls
// rather than failing, so it needs an outer bound of its own - otherwise a
// lock leaked by a killed process would hold a task in `deploying` forever.
const DEPLOY_STAGE_TIMEOUT_MS = 30 * 60 * 1000;
// how long the merge stage keeps trying to clear a failed merge on
// its own (rebase the task's clone onto main, force-push, merge again on the
// next poll) before it hands the task to an agent. A rebase is free and an
// agent run is not, so it is worth a few cycles; but a merge that keeps
// failing for a reason a rebase cannot touch (branch protection, a required
// review) must not retry forever.
const MERGE_REBASE_WINDOW_MS = 5 * 60 * 1000;
// the healthcheck retry. A service that just restarted can fail
// its own healthcheck for a few seconds and be fine - one failed check is not
// a failed deploy. The stage's own clock is the retry budget (one attempt per
// poll), so this survives the poller restarting.
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
// A deploy that failed only because Docker Hub refused a pull (its rate limit
// is per public IP, so every host behind one address shares it) is not
// something an agent can fix, and the limit lifts on its own. So instead of a
// handback it waits in `deploying` and retries after each of these delays in
// turn: four attempts in all, then the normal deploy_failed handback.
export const DEPLOY_RATE_LIMIT_BACKOFF_MS = [30, 60, 120].map((minutes) => minutes * 60 * 1000);
// Bound on any command output copied onto a task. Well above the activity
// truncation limit (this is real debugging evidence a human will read, and
// what #161 feeds back to an agent), but still bounded so one enormous
// failing step cannot blow out a comment or a later prompt.
const FAILURE_LOG_MAX_CHARS = 8_000;

export function truncateLog(text: string, max = FAILURE_LOG_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…(truncated)\n${trimmed.slice(-max)}` : trimmed;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// execFileSync throws on a non-zero exit and hides the output in properties
// of the error. Every step here wants both halves either way ("did it work,
// and what did it say"), so the throw is turned back into a value once, here.
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CommandResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stderr = String(e.stderr ?? "").trim() || String(e.message ?? "unknown error");
    return { ok: false, stdout: String(e.stdout ?? ""), stderr };
  }
}

// I21 follow-up, now the poller's problem rather than the runner's:
// deploying pinboard restarts the very API this reports back to. The deploy
// script waits for pinboard's own healthcheck first, but there is a real
// window right after where the container is healthy and not yet accepting
// connections - a call landing in that gap throws "fetch failed" and, if it
// were left uncaught, would strand the task in the stage it just finished.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, delayMs = 3_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

export interface CiRunInfo {
  status: string;
  conclusion: string | null;
  url: string;
  databaseId?: number;
  headSha?: string;
}

// What the pipeline knows about a PR besides its CI run, for the "no run yet"
// case. `mergeable` is GitHub's own field (MERGEABLE, CONFLICTING, UNKNOWN
// while it is still computing), null when it could not be read.
// `hasWorkflows` is whether the head commit has a workflow GitHub would run
// for a push or a PR; null when that could not be read, which counts as "yes"
// (waiting too long costs a poll, proceeding wrongly ships untested code).
export interface PrCiContext {
  mergeable: string | null;
  hasWorkflows: boolean | null;
}

const NO_CI_CONTEXT: PrCiContext = { mergeable: null, hasWorkflows: false };

export type CiDecision =
  | { decision: "proceed" }
  | { decision: "wait" }
  | { decision: "fail"; reason: string }
  | { decision: "conflict" }
  | { decision: "no_run"; reason: string };

// Pure (no `gh` call, no clock) so it is unit-testable - mirrors
// deploy-service.sh's own bash loop: still running -> wait (unless the
// timeout has elapsed); a completed failure -> stop; anything else completed
// -> proceed.
//
// A PR that conflicts with its base is never a pass: GitHub runs no
// pull_request workflow for a PR it cannot merge, so "no run" there says
// nothing about the code. With no run for the head commit yet: UNKNOWN
// mergeability waits for GitHub to finish computing it; a repo that has
// workflows waits up to the timeout and then reports `no_run`; only a repo
// with no workflow files proceeds once graceMs has passed (GitHub can take a
// few seconds to register a run, and a past task merged 4 seconds after
// opening its PR because that gap read as "no CI").
export function evaluateCiRun(
  run: CiRunInfo | null,
  elapsedMs: number,
  timeoutMs: number,
  graceMs = 0,
  context: PrCiContext = NO_CI_CONTEXT,
): CiDecision {
  if (context.mergeable === "CONFLICTING") return { decision: "conflict" };
  if (!run) {
    if (context.mergeable === "UNKNOWN" || context.hasWorkflows !== false) {
      if (elapsedMs < timeoutMs) return { decision: "wait" };
      const why = context.mergeable === "UNKNOWN" ? "GitHub still reports the PR's mergeability as unknown" : "the repo has workflows";
      return { decision: "no_run", reason: `no CI run appeared after ${Math.round(timeoutMs / 60000)} minutes, and ${why}` };
    }
    return elapsedMs < graceMs ? { decision: "wait" } : { decision: "proceed" };
  }
  if (run.status !== "completed") {
    if (elapsedMs >= timeoutMs) {
      return { decision: "fail", reason: `CI still ${run.status} after ${Math.round(timeoutMs / 1000)}s (${run.url})` };
    }
    return { decision: "wait" };
  }
  if (run.conclusion === "failure") {
    return { decision: "fail", reason: `CI failed (${run.url})` };
  }
  return { decision: "proceed" };
}

// Whether a workflow file runs on a push or a PR: the `on:` key's inline
// value or indented block names push, pull_request or pull_request_target.
// A plain text scan rather than a YAML parser, which foreman does not carry;
// a false "yes" only means waiting for a run, a false "no" is what to avoid.
export function workflowTriggersOnPushOrPr(yaml: string): boolean {
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^["']?on["']?\s*:(.*)$/.exec(lines[i]);
    if (!match) continue;
    const block = [match[1]];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j]) && !lines[j].startsWith("#")) break;
      block.push(lines[j].replace(/#.*$/, ""));
    }
    return /\b(?:push|pull_request\w*)\b/.test(block.join("\n").replace(/#.*$/gm, ""));
  }
  return false;
}

export function isWorkflowFile(name: string): boolean {
  return /\.ya?ml$/.test(name);
}

// The files git reported as conflicting, from a failed rebase or merge.
export function conflictingFiles(gitOutput: string): string[] {
  const files = new Set<string>();
  for (const match of gitOutput.matchAll(/^CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/gm)) files.add(match[1]);
  return [...files];
}

// How long the task has been in its current stage. The stage's own timestamp
// is the clock for every timeout here, so this process restarting does not
// give a wedged stage a fresh budget. A missing timestamp (only possible for
// a task moved into a stage by hand) reads as "just entered".
export function stageElapsedMs(stageEnteredAt: string | null, now: number): number {
  if (!stageEnteredAt) return 0;
  const entered = new Date(stageEnteredAt).getTime();
  return Number.isNaN(entered) ? 0 : Math.max(0, now - entered);
}

// #61's item 2, and the one judgement call in the whole poller: a diff that
// touches a drizzle migration holds for a human BEFORE merge, because a bad
// migration against a live database is far costlier to unwind than a bad UI
// change. Pinboard only knows the `awaiting_review` stage exists; which diffs
// qualify is decided here.
export function touchesMigration(paths: readonly string[]): boolean {
  return paths.some((path) => /(^|\/)drizzle\/.*\.sql$/.test(path.trim()));
}

export interface AfterCiInput {
  autoDeployAllowed: boolean;
  localPath: string | null;
  repoSlugs: readonly string[];
  // Repos whose diff holds for a human: a migration, or a diff that could not
  // be read at all (unknown reads as "hold" - the cost of a needless human
  // look is a comment, the cost of guessing wrong is a bad migration).
  holdRepos: readonly string[];
}

// Where a task goes once every PR's CI is green. Pure so the whole policy -
// auto-deploy opt-in, the production guard, the migration hold - reads in one
// place and is testable without a GitHub.
export function decideAfterCi(input: AfterCiInput): { to: "awaiting_merge" | "awaiting_review" | "review"; note: string } {
  if (!input.autoDeployAllowed || !input.localPath) {
    return { to: "review", note: "CI is green. Auto-deploy is not enabled for this project, so the PR is left open for a human to merge." };
  }
  // Defense in depth for the fixed decision that production stays off limits
  // to autonomous work, even though no pinboard project should ever be
  // configured that way.
  if (input.repoSlugs.includes("production")) {
    return { to: "review", note: "CI is green, but production is never eligible for an autonomous merge - the PR is left open for a human." };
  }
  if (input.holdRepos.length > 0) {
    return {
      to: "awaiting_review",
      note: `CI is green, but the diff touches a database migration (${input.holdRepos.join(", ")}), so it holds for a human before merge. Approve it in pinboard's review queue to let the merge proceed.`,
    };
  }
  return { to: "awaiting_merge", note: "CI is green - merging." };
}

// where a task goes once its deploy is healthy. An `agent` task
// has nobody waiting to look at it, so it closes itself; `human+agent` (and
// anything unrecognised) still goes to review for a human.
export function decideAfterVerify(executorMode: string | undefined, checked: readonly string[]): { to: "done" | "review"; note: string } {
  const what = checked.length > 0 ? `Deployed and healthy: ${checked.join(", ")}.` : "Deployed.";
  if (executorMode === "agent") {
    return { to: "done", note: `${what} Closed automatically (executor agent).` };
  }
  return { to: "review", note: `${what} Ready for review.` };
}

// a merge that failed is nearly always this task's branch having
// fallen behind main while it sat in CI, which a rebase fixes with no agent
// involved. Within the window the poller rebases and comes back next poll;
// past it, whatever is wrong is not something another rebase will clear, so
// the task goes to an agent with git's own output. Pure so the policy is
// testable without a git or a GitHub.
export function decideMergeFailure(elapsedMs: number, windowMs = MERGE_REBASE_WINDOW_MS): "rebase" | "handback" {
  return elapsedMs < windowMs ? "rebase" : "handback";
}

// same shape for the healthcheck. One failure inside the window is
// a retry (the service may still be coming up); a failure after it is a real
// deploy failure and goes back to an agent.
export function decideHealthcheckFailure(elapsedMs: number, timeoutMs = VERIFY_TIMEOUT_MS): "retry" | "handback" {
  return elapsedMs < timeoutMs ? "retry" : "handback";
}

export interface PipelineRepo {
  repoSlug: string;
  prUrl: string;
  // The PR's own pinboard row, so the merge stage can mark it merged the
  // moment it merges it. Waiting for pull-requests.ts's `gh pr view` sweep
  // (which runs on the dispatch loop, not this one) would leave a merged PR
  // recorded as open for up to a poll - long enough for a deploy_failed
  // handback's resumed run to find it and push its fix onto a branch whose PR
  // is already merged, where nothing would ever land it.
  prId: number;
}

// One task can land changes across several repos (see runner.ts's
// relatedRepoTargets), each with its own PR on the same branch. The pipeline
// payload only carries the most recent PR, so the full set comes from the
// task's own PR list, filtered to this attempt's branch - by branch rather
// than by state, because the pipeline follows a PR through being merged and
// filtering on `open` would lose the repo the moment the merge lands.
export function pipelineRepos(prs: readonly PullRequest[], branch: string | null): PipelineRepo[] {
  const repos: PipelineRepo[] = [];
  const seen = new Set<string>();
  for (const pr of prs) {
    if (branch !== null && pr.branchName !== branch) continue;
    if (seen.has(pr.repoSlug)) continue;
    seen.add(pr.repoSlug);
    repos.push({ repoSlug: pr.repoSlug, prUrl: pr.url, prId: pr.id });
  }
  return repos;
}

// what deploying a repo means is declared, not inferred from a
// README. Same lookup and format as homelab/scripts/deploy-steps.sh, which
// deploy-service.sh uses, so the pipeline and a human's manual deploy can never
// disagree about a repo's target:
//   - homelab/targets/<repo>.json (repos outside the workspace's own org,
//     kept out of the project's own repo), checked first;
//   - <repo>/.homelab/deploy.json (repos in the workspace's own org).
// An empty `steps` list is a deliberate "nothing to deploy" (homelab-kit, an
// npm package; cue, deployed per GPU node) and is not a failure. A missing or
// invalid declaration is: the pipeline parks rather than guessing.
export interface LxcDeployStep {
  type: "lxc";
  host: string;
}
// one app on a shared LXC (sandbox, later production), deployed
// with that host's own `scripts/deploy.sh <app>` and checked with
// `scripts/healthcheck.sh <app>`.
export interface AppDeployStep {
  type: "app";
  host: string;
  app: string;
}
// an npm package in packages/<package> of the repo, published by
// homelab/scripts/npm-publish.sh when its version on the default branch has no
// `<package>-v<version>` tag yet. It runs on the caller, so it has no host.
// `root: true` is a single-package repo instead (manifest at the
// repo root, tag plain `v<version>`); `package` then only names the step.
export interface NpmDeployStep {
  type: "npm";
  package: string;
  root?: true;
}
export type DeployStep = LxcDeployStep | AppDeployStep | NpmDeployStep;
export type HostDeployStep = LxcDeployStep | AppDeployStep;

export function isHostStep(step: DeployStep): step is HostDeployStep {
  return step.type !== "npm";
}

// a human-gated production release, the declaration's top-level
// `release` block. It is deliberately not a step: nothing in this file deploys
// it, so the post-merge pipeline cannot reach production. Only a release
// request from pinboard runs it (releases.ts's runRelease).
export interface ReleaseTarget {
  host: string;
  app: string;
  // Pushing this branch of the app repo triggers `workflow`, which builds and
  // pushes `images` tagged v<version>.
  branch: string;
  workflow: string;
  versionFiles: string[];
  images: string[];
  // The workspace repo and file holding the literal image tags production
  // runs (production/projects/<app>/docker-compose.yml).
  composeRepo: string;
  composeFile: string;
}

const PLAIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;
export type DeployDeclaration = { ok: true; steps: DeployStep[]; release?: ReleaseTarget } | { ok: false; error: string };

function isRelativePath(value: unknown): value is string {
  return typeof value === "string" && RELATIVE_PATH.test(value) && !value.includes("..") && !value.startsWith("/");
}

// Same rules as deploy-steps.sh's python half.
export function parseReleaseTarget(raw: unknown): ReleaseTarget | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "release is not an object";
  const r = raw as Record<string, unknown>;
  for (const field of ["host", "app", "branch", "composeRepo"]) {
    if (typeof r[field] !== "string" || !PLAIN_NAME.test(r[field] as string)) return `release needs a plain name in \`${field}\``;
  }
  for (const field of ["workflow", "composeFile"]) {
    if (!isRelativePath(r[field])) return `release needs a relative path in \`${field}\``;
  }
  for (const field of ["versionFiles", "images"]) {
    const list = r[field];
    if (!Array.isArray(list) || list.length === 0 || !list.every(isRelativePath)) return `release needs a non-empty list of paths in \`${field}\``;
  }
  return {
    host: r.host as string,
    app: r.app as string,
    branch: r.branch as string,
    workflow: r.workflow as string,
    versionFiles: [...(r.versionFiles as string[])],
    images: [...(r.images as string[])],
    composeRepo: r.composeRepo as string,
    composeFile: r.composeFile as string,
  };
}

export function deployStepsFor(repoSlug: string, workspaceRoot: string = HOMELAB_ROOT): DeployDeclaration {
  const candidates = [join(workspaceRoot, "homelab", "targets", `${repoSlug}.json`), join(workspaceRoot, repoSlug, ".homelab", "deploy.json")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return { ok: false, error: `${repoSlug} has no deploy declaration (.homelab/deploy.json in the repo, or homelab/targets/${repoSlug}.json)` };

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path}: not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { version, steps, release } = (doc ?? {}) as { version?: unknown; steps?: unknown; release?: unknown };
  if (version !== 1 || !Array.isArray(steps)) return { ok: false, error: `${path}: expected {"version": 1, "steps": [...]}` };

  const parsed: DeployStep[] = [];
  for (const [i, step] of steps.entries()) {
    const { type, host, app, package: pkg, root } = (step ?? {}) as { type?: unknown; host?: unknown; app?: unknown; package?: unknown; root?: unknown };
    if (type === "npm") {
      if (typeof pkg !== "string" || !PLAIN_NAME.test(pkg)) {
        return { ok: false, error: `${path}: steps[${i}] (npm) needs a plain name in \`package\`` };
      }
      if (root !== undefined && typeof root !== "boolean") {
        return { ok: false, error: `${path}: steps[${i}] (npm) \`root\` must be true or false` };
      }
      parsed.push(root ? { type, package: pkg, root } : { type, package: pkg });
      continue;
    }
    if (type !== "lxc" && type !== "app") {
      return { ok: false, error: `${path}: steps[${i}] has unknown type ${JSON.stringify(type)} (known: lxc, app, npm)` };
    }
    if (typeof host !== "string" || !PLAIN_NAME.test(host)) {
      return { ok: false, error: `${path}: steps[${i}] (${type}) needs a plain hostname in \`host\`` };
    }
    if (type === "lxc") {
      parsed.push({ type, host });
      continue;
    }
    if (typeof app !== "string" || !PLAIN_NAME.test(app)) {
      return { ok: false, error: `${path}: steps[${i}] (app) needs a plain name in \`app\`` };
    }
    // an app on production only ships through its human-gated
    // `release` block, never as a step that runs after a merge.
    if (host === "production") {
      return { ok: false, error: `${path}: steps[${i}] deploys an app to production, which only releases through a \`release\` block` };
    }
    parsed.push({ type, host, app });
  }
  if (release === undefined) return { ok: true, steps: parsed };
  const target = parseReleaseTarget(release);
  if (typeof target === "string") return { ok: false, error: `${path}: ${target}` };
  return { ok: true, steps: parsed, release: target };
}

// The declarations above, and homelab/scripts/deploy-service.sh itself, are
// read from the shared workspace clone, which nothing pulls on its own: it
// moves only when someone happens to pull it. Found at deploy time for #212:
// every repo's clone on foreman was days behind and had no declaration yet,
// so every merge would have parked. Fast-forward a clone only when that is
// plainly safe (on its default branch, clean); otherwise leave it alone and
// return why, and the caller uses whatever is there.
export function refreshWorkspaceClone(repoSlug: string, workspaceRoot: string = HOMELAB_ROOT): string | null {
  const dir = join(workspaceRoot, repoSlug);
  if (!existsSync(join(dir, ".git"))) return null;
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (!branch.ok) return `${repoSlug}: could not read the workspace clone's branch: ${branch.stderr}`;
  const defaultBranch = resolveDefaultBranch(dir);
  if (branch.stdout.trim() !== defaultBranch) return `${repoSlug}: workspace clone is on ${branch.stdout.trim()}, not ${defaultBranch}, so it was not refreshed`;
  const status = run("git", ["status", "--porcelain"], { cwd: dir });
  if (!status.ok || status.stdout.trim() !== "") return `${repoSlug}: workspace clone has local changes, so it was not refreshed`;
  const pull = run("git", ["pull", "--ff-only", "-q"], { cwd: dir });
  return pull.ok ? null : `${repoSlug}: could not fast-forward the workspace clone: ${pull.stderr}`;
}

function refreshForDeploy(repos: readonly { repoSlug: string }[]): void {
  for (const slug of new Set(["homelab", ...repos.map((repo) => repo.repoSlug)])) {
    const warning = refreshWorkspaceClone(slug);
    if (warning) console.error(`pipeline: ${warning}`);
  }
}

// a library (a repo with an `npm` step, today only homelab-kit)
// deploys before its consumers. #335 merged a server-kit bump and pinboard's
// dependency on it together, deployed pinboard first, and its build failed
// with ETARGET because the new version was not published yet. A stable
// partition is enough; everything else keeps the order it came in.
export function orderLibrariesFirst<R>(targets: readonly { repo: R; steps: readonly DeployStep[] }[]): R[] {
  const isLibrary = (t: { steps: readonly DeployStep[] }) => t.steps.some((step) => step.type === "npm");
  return [...targets.filter(isLibrary), ...targets.filter((t) => !isLibrary(t))].map((t) => t.repo);
}

// Splits a task's repos by what their declarations say: something to deploy
// (libraries first, see orderLibrariesFirst), nothing to deploy, or a
// declaration that is missing/broken.
export function classifyDeployTargets<R extends { repoSlug: string }>(
  repos: readonly R[],
  workspaceRoot: string = HOMELAB_ROOT,
): { deployable: R[]; undeclared: string[] } {
  const targets: { repo: R; steps: DeployStep[] }[] = [];
  const undeclared: string[] = [];
  for (const repo of repos) {
    const declaration = deployStepsFor(repo.repoSlug, workspaceRoot);
    if (!declaration.ok) undeclared.push(declaration.error);
    else if (declaration.steps.length > 0) targets.push({ repo, steps: declaration.steps });
  }
  return { deployable: orderLibrariesFirst(targets), undeclared };
}

// `gh --repo` needs the PR's actual GitHub org, not always the workspace's
// main org - a repo in another of the operator's orgs 404s against it. A
// task's own project localPath is always `org/name` (pinboard's schema.ts), so
// its first segment is that org; a task with no localPath at all (only
// possible for a project with no local checkout recorded) falls back to the
// directory name of HOMELAB_ROOT, this workspace's default org.
//
// published repos can move to a public org while their clones (and
// localPaths) stay under the private org's directory, so the localPath's first
// segment is the workspace directory, not necessarily the org. When the
// workspace clone exists, its `origin` remote names the real org; the first
// segment is only the fallback.
export function repoOrgFor(localPath: string | null, root: string = WORKSPACE_ROOT, defaultOrg: string = basename(HOMELAB_ROOT)): string {
  if (localPath) {
    const dir = join(root, localPath);
    if (existsSync(join(dir, ".git"))) {
      const origin = run("git", ["-C", dir, "remote", "get-url", "origin"]);
      const org = origin.ok ? githubOrgFromUrl(origin.stdout.trim()) : null;
      if (org) return org;
    }
  }
  const org = localPath?.split("/")[0];
  return org ? org : defaultOrg;
}

// repos in a public GitHub org get no internal references in
// anything foreman or its agents write to GitHub for them. Public is decided
// per repo by its org (repoOrgFor, so the workspace clone's origin), against
// PUBLIC_GITHUB_ORGS (comma-separated, default `rackmarten`).
export const DEFAULT_PUBLIC_GITHUB_ORGS = "rackmarten";

export function publicGithubOrgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PUBLIC_GITHUB_ORGS ?? DEFAULT_PUBLIC_GITHUB_ORGS;
  return raw.split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
}

export function isPublicOrg(org: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return publicGithubOrgs(env).includes(org.toLowerCase());
}

export function isPublicRepo(localPath: string | null, root: string = WORKSPACE_ROOT, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPublicOrg(repoOrgFor(localPath, root), env);
}

// a PR opened before its repo went public still carries the
// private-repo title suffix, and the default squash subject is that title.
// For a public repo the merge names its own subject without it; a private
// repo keeps gh's default (null).
export function publicSquashSubject(title: string, prUrl: string): string {
  const number = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  const clean = title.replace(/\s*\(pinboard #\d+\)/gi, "").trim();
  return number ? `${clean} (#${number})` : clean;
}

export function squashMergeArgs(prUrl: string, publicTitle: string | null): string[] {
  const args = ["pr", "merge", prUrl, "--squash", "--delete-branch"];
  return publicTitle === null ? args : [...args, "--subject", publicSquashSubject(publicTitle, prUrl)];
}

// "git@github.com:org/name(.git)" or "https://github.com/org/name(.git)" ->
// "org"; null for anything that is not a GitHub repo URL.
export function githubOrgFromUrl(url: string): string | null {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/[^/]+?(?:\.git)?\/?$/.exec(url);
  return match ? match[1] : null;
}

// the org is per repo, not per task. A task whose project is in one org
// can carry a PR in a repo of another org, and asking the project's org for
// that repo's CI 404s. The PR's own URL names the org;
// the task's project localPath is only the fallback for a URL that does not.
export function orgForPr(prUrl: string | null | undefined, fallbackLocalPath: string | null): string {
  const match = /github\.com\/([^/]+)\/[^/]+\/pull\//.exec(prUrl ?? "");
  return match ? match[1] : repoOrgFor(fallbackLocalPath);
}

// ---------------------------------------------------------------------------
// The steps themselves
// ---------------------------------------------------------------------------

// What the branch points at on GitHub right now, i.e. the commit the agent
// just pushed. Throws on a `gh` failure, which handleAwaitingCi already
// treats as "keep waiting" rather than a CI failure.
export function fetchBranchHeadSha(org: string, repoSlug: string, branch: string, exec: Exec = run): string {
  const result = exec("gh", ["api", `repos/${org}/${repoSlug}/commits/${branch}`, "--jq", ".sha"]);
  const sha = result.stdout.trim();
  if (!result.ok || !sha) throw new Error(`could not read the head of ${branch} for ${repoSlug}: ${result.stderr}`);
  return sha;
}

// A run is only read for the commit that was just pushed. Seconds
// after a push GitHub has not registered the new run yet, and the branch's
// newest run is still the previous attempt's red one, which then parked a
// fixed task as "no new commits were pushed". No run for headSha reads as no
// run at all, so evaluateCiRun's grace period applies.
const CI_RUN_LOOKBACK = 10;

function listBranchRuns(org: string, repoSlug: string, branch: string, fields: string, exec: Exec): CommandResult {
  return exec("gh", ["run", "list", "--repo", `${org}/${repoSlug}`, "--branch", branch, "--limit", String(CI_RUN_LOOKBACK), "--json", fields]);
}

export function fetchLatestCiRun(org: string, repoSlug: string, branch: string, headSha: string, exec: Exec = run): CiRunInfo | null {
  const result = listBranchRuns(org, repoSlug, branch, "databaseId,headSha,status,conclusion,url", exec);
  if (!result.ok) throw new Error(`could not check CI status for ${repoSlug}: ${result.stderr}`);
  const runs = JSON.parse(result.stdout) as CiRunInfo[];
  return runs.find((ciRun) => ciRun.headSha === headSha) ?? null;
}

// GitHub's mergeable state for a PR (MERGEABLE, CONFLICTING, UNKNOWN), null
// when gh could not read it. Null does not block: the CI run itself is still
// the gate, and the workflow check below still applies.
export function fetchPrMergeable(prUrl: string, exec: Exec = run): string | null {
  const result = exec("gh", ["pr", "view", prUrl, "--json", "mergeable", "--jq", ".mergeable"]);
  const state = result.stdout.trim();
  return result.ok && state ? state : null;
}

// A commit's workflow files never change, so one read per (repo, sha) is
// enough for the whole CI wait. Unreadable answers are not cached.
const workflowCache = new Map<string, boolean>();

// Whether the head commit has a .github/workflows/*.yml|yaml that triggers on
// a push or a PR. False only when GitHub says the directory does not exist or
// no file in it triggers; null when it could not be read.
export function fetchHasWorkflows(org: string, repoSlug: string, sha: string, exec: Exec = run): boolean | null {
  const key = `${org}/${repoSlug}@${sha}`;
  const cached = workflowCache.get(key);
  if (cached !== undefined) return cached;
  const listing = exec("gh", ["api", `repos/${org}/${repoSlug}/contents/.github/workflows?ref=${sha}`, "--jq", ".[] | select(.type == \"file\") | .path"]);
  let found: boolean;
  if (!listing.ok) {
    if (!/Not Found|HTTP 404/.test(listing.stderr)) return null;
    found = false;
  } else {
    found = false;
    for (const path of listing.stdout.split("\n").map((line) => line.trim()).filter(isWorkflowFile)) {
      const file = exec("gh", ["api", `repos/${org}/${repoSlug}/contents/${path}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
      if (!file.ok) return null;
      if (workflowTriggersOnPushOrPr(file.stdout)) {
        found = true;
        break;
      }
    }
  }
  workflowCache.set(key, found);
  return found;
}

// the failing step's own log, not just "CI failed" - what a human
// reading the task needs, and what #161 hands back to a resumed agent.
//
// `gh run view --log-failed` exits 0 and prints nothing for a run
// whose jobs come from a reusable workflow (a shared org-wide
// security-check, say), which is how a past task got handed back three times with an
// empty log. The fallback reads each failed job's raw log through the API and
// keeps the failing step's own section. `exec` is injectable so the tests can
// stand in for `gh`.
export type Exec = (cmd: string, args: string[]) => CommandResult;

export interface CiFailure {
  runId: number | null;
  headSha: string | null;
  url: string | null;
  // "job / step" for display; failingSteps below is the bare step names, which
  // is what the red-main comparison matches on (a push run and a PR run can
  // name the same job differently).
  failingStepLabels: string[];
  failingSteps: string[];
  log: string;
}

interface CiJob {
  databaseId: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function fetchRunJobs(org: string, repoSlug: string, runId: number, exec: Exec): CiJob[] {
  const result = exec("gh", ["run", "view", String(runId), "--repo", `${org}/${repoSlug}`, "--json", "jobs"]);
  if (!result.ok) return [];
  try {
    // not only `failure` - a timed-out, cancelled or startup-failed
    // job is just as much the reason the run is red.
    return ((JSON.parse(result.stdout) as { jobs?: CiJob[] }).jobs ?? []).filter((job) => job.conclusion !== null && !OK_CONCLUSIONS.has(job.conclusion));
  } catch {
    return [];
  }
}

function failingStepsOf(jobs: CiJob[]): { labels: string[]; names: string[] } {
  const labels: string[] = [];
  const names: string[] = [];
  for (const job of jobs) {
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
    if (steps.length === 0) labels.push(job.name);
    for (const step of steps) {
      labels.push(`${job.name} / ${step.name}`);
      names.push(step.name);
    }
  }
  return { labels, names };
}

// A raw job log is every step back to back, each opening with a
// `##[group]Run ...` header. The useful part is the last such header before
// the first `##[error]` line, through that error line. Without an error
// marker the whole log is returned and truncateLog keeps its tail.
export function extractFailingSection(log: string): string {
  const lines = log.split("\n");
  const errorAt = lines.findIndex((line) => line.includes("##[error]"));
  if (errorAt === -1) return log;
  let startAt = 0;
  for (let i = errorAt; i >= 0; i--) {
    if (lines[i].includes("##[group]Run")) {
      startAt = i;
      break;
    }
  }
  return lines.slice(startAt, errorAt + 1).join("\n");
}

// headSha, when given, picks the same run fetchLatestCiRun judged; without
// it the branch's newest run is read.
export function fetchCiFailure(org: string, repoSlug: string, branch: string, exec: Exec = run, headSha: string | null = null): CiFailure {
  const empty = { runId: null, headSha: null, url: null, failingStepLabels: [], failingSteps: [] };
  const list = listBranchRuns(org, repoSlug, branch, "databaseId,headSha,url", exec);
  if (!list.ok) return { ...empty, log: `(could not fetch CI failure log: ${list.stderr})` };
  const runs = JSON.parse(list.stdout) as { databaseId: number; headSha?: string; url?: string }[];
  const ciRun = headSha ? runs.find((r) => r.headSha === headSha) : runs[0];
  if (!ciRun) return { ...empty, log: `(no CI run found to fetch a failure log from${headSha ? ` for ${headSha}` : ""})` };

  const jobs = fetchRunJobs(org, repoSlug, ciRun.databaseId, exec);
  const steps = failingStepsOf(jobs);
  const base = {
    runId: ciRun.databaseId,
    headSha: ciRun.headSha ?? null,
    url: ciRun.url ?? null,
    failingStepLabels: steps.labels,
    failingSteps: steps.names,
  };
  const prefix = steps.labels.length > 0 ? `Failing steps: ${steps.labels.join(", ")}\n\n` : "";

  const failed = exec("gh", ["run", "view", String(ciRun.databaseId), "--repo", `${org}/${repoSlug}`, "--log-failed"]);
  if (failed.ok && failed.stdout.trim()) return { ...base, log: prefix + truncateLog(failed.stdout) };

  // a section is kept only when the extracted part itself has
  // content - a header over nothing is how an "output:" block came out empty.
  const sections: string[] = [];
  for (const job of jobs) {
    const raw = exec("gh", ["api", `repos/${org}/${repoSlug}/actions/jobs/${job.databaseId}/logs`]);
    const section = raw.ok ? extractFailingSection(raw.stdout).trim() : "";
    if (section) sections.push(`=== ${job.name} ===\n${section}`);
  }
  if (sections.length > 0) return { ...base, log: prefix + truncateLog(sections.join("\n\n")) };

  const where = ciRun.url ?? `https://github.com/${org}/${repoSlug}/actions/runs/${ciRun.databaseId}`;
  const reason = failed.ok ? "" : ` (${failed.stderr.trim()})`;
  const jobLines = jobs.map((job) => `- ${job.name}: ${job.conclusion}`);
  return {
    ...base,
    log: [
      `(no log output could be fetched for run ${ciRun.databaseId}${reason}, open ${where})`,
      ...(jobLines.length > 0 ? ["", "Jobs that did not pass:", ...jobLines] : ["", "No failed job was reported for this run (it may have failed before any job started, e.g. an invalid workflow)."]),
    ].join("\n"),
  };
}

export function fetchCiFailureLog(org: string, repoSlug: string, branch: string, exec: Exec = run): string {
  return fetchCiFailure(org, repoSlug, branch, exec).log;
}

// the latest completed run on the repo's default branch, and the
// steps it failed on - `null` when it passed or could not be read, which
// counts as "main is fine" (the handback goes ahead as before).
export function fetchRedMain(org: string, repoSlug: string, exec: Exec = run): { url: string; failingSteps: string[] } | null {
  const repo = exec("gh", ["repo", "view", `${org}/${repoSlug}`, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  const defaultBranch = (repo.ok && repo.stdout.trim()) || "main";
  const list = exec("gh", [
    "run", "list", "--repo", `${org}/${repoSlug}`, "--branch", defaultBranch, "--status", "completed", "--limit", "1", "--json", "databaseId,conclusion,url",
  ]);
  if (!list.ok) return null;
  let latest: { databaseId: number; conclusion: string | null; url: string } | undefined;
  try {
    [latest] = JSON.parse(list.stdout);
  } catch {
    return null;
  }
  if (!latest || latest.conclusion !== "failure") return null;
  return { url: latest.url, failingSteps: failingStepsOf(fetchRunJobs(org, repoSlug, latest.databaseId, exec)).names };
}

// the marker a ci_failed handback leaves in its comment, so the
// next CI check for this task can tell "CI failed again on a new push" from
// "the same run is being read a second time because nothing was pushed".
// A comment, not repairContext, because pinboard clears repairContext as
// soon as the task leaves `queued`.
export function failedRunMarker(repoSlug: string, runId: number, headSha: string | null): string {
  return `Failed CI run: ${repoSlug} ${runId}${headSha ? ` (head ${headSha})` : ""}`;
}

export function previousFailedRunId(comments: readonly { authorName: string; body: string }[], repoSlug: string): number | null {
  const pattern = new RegExp(`^Failed CI run: ${repoSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)`, "m");
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].authorName !== PIPELINE_ACTOR.actorName) continue;
    const match = pattern.exec(comments[i].body);
    if (match) return Number(match[1]);
  }
  return null;
}

// what a failed CI run turns into. Pure, so the tests can drive it.
// Both park cases keep the task off the agent queue, which also means no
// attempt is spent on them - pinboard only counts an attempt on dispatch.
// the last guard against a ci_failed comment whose "failing step's
// output" is blank - whatever produced the log, an empty one becomes a
// pointer to where the run can be read.
export function withEvidence(failure: CiFailure, fallbackUrl: string): CiFailure {
  if (failure.log.trim()) return failure;
  const where = failure.url ?? fallbackUrl;
  const steps = failure.failingStepLabels.length > 0 ? `\nFailing: ${failure.failingStepLabels.join(", ")}` : "";
  return { ...failure, log: `(no log output was captured, open ${where})${steps}` };
}

export function decideCiFailure(input: {
  repoSlug: string;
  prUrl: string;
  branch: string;
  reason: string;
  failure: CiFailure;
  previousRunId: number | null;
  redMain: { url: string; failingSteps: string[] } | null;
}): StageOutcome {
  const { repoSlug, prUrl, branch, reason, previousRunId, redMain } = input;
  const failure = withEvidence(input.failure, `https://github.com/${orgForPr(prUrl, null)}/${repoSlug}/actions`);
  // The run is the head commit's own, so the same id means the
  // head really has not moved since the last handback.
  if (failure.runId !== null && failure.runId === previousRunId) {
    return park(
      `CI run ${failure.runId} failed again for ${repoSlug}`,
      `CI run ${failure.runId} on ${prUrl} is the same run that failed at the last handback: no new commits were pushed to ${branch}, so another agent run would read the same failure. Left for a human.\n\n${failure.log}`,
    );
  }
  const shared = redMain ? failure.failingSteps.filter((step) => redMain.failingSteps.includes(step)) : [];
  if (redMain && shared.length > 0) {
    return park(
      `main of ${repoSlug} is already red`,
      `main of ${repoSlug} is already failing ${shared.join(", ")} (${redMain.url}); not caused by this task. Left for a human, no attempt spent.\n\n${failure.log}`,
    );
  }
  const marker = failure.runId !== null ? `\n\n${failedRunMarker(repoSlug, failure.runId, failure.headSha)}` : "";
  return handBack(
    "ci_failed",
    `CI failed for ${repoSlug}`,
    [`${reason} on ${prUrl}. Not merged - the fix goes on the same branch.`, "", "The failing step's output:", "", failure.log].join("\n") + marker,
    `${reason} on ${prUrl} (branch ${branch}).${marker}\n\n${failure.log}`,
  );
}

// The PR's changed files, for the migration hold. `null` means the diff could
// not be read at all, which decideAfterCi treats as a hold rather than a pass.
function prChangedFiles(prUrl: string): string[] | null {
  const result = run("gh", ["pr", "diff", prUrl, "--name-only"]);
  if (!result.ok) return null;
  return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

// clears the usual merge failure without an agent - this task's
// branch has fallen behind main while it sat in CI. The rebase happens in the
// task's own clone (still on disk unless the workdir sweep has been through,
// which takes hours), and the force-push is safe because that branch belongs
// to this task alone: --force-with-lease still refuses if anything else has
// pushed to it since this clone last saw it.
function rebaseAndPushBranch(taskId: number, repoSlug: string, branch: string): CommandResult & { unchanged?: boolean } {
  const repoPath = repoWorkdir(taskId, repoSlug);
  if (!existsSync(repoPath)) {
    return { ok: false, stdout: "", stderr: `no clone left at ${repoPath} to rebase - the task's workdir has been swept` };
  }
  const head = () => run("git", ["rev-parse", "HEAD"], { cwd: repoPath }).stdout.trim();
  const before = head();
  const rebased = rebaseOntoMain(repoPath, branch);
  if (!rebased.ok) return { ok: false, stdout: "", stderr: rebased.error };
  // A rebase that changed nothing means the branch was already current with
  // main, so whatever `gh pr merge` refused for is not staleness - stop here
  // rather than retrying. Pushing anyway would also re-trigger CI on every
  // poll for the whole retry window, for a merge that is not going to
  // succeed.
  if (head() === before) {
    return { ok: false, unchanged: true, stdout: "", stderr: "the branch is already rebased onto origin/main, so the merge is failing for some other reason" };
  }
  return run("git", ["push", "--force-with-lease", "origin", branch], { cwd: repoPath });
}

function prIsMerged(prUrl: string): boolean {
  const result = run("gh", ["pr", "view", prUrl, "--json", "state", "--jq", ".state"]);
  return result.ok && result.stdout.trim() === "MERGED";
}

// env tells deploy-service.sh who to report the deploy as in
// pinboard's releases view (DEPLOY_ACTOR, DEPLOY_TASK_ID/DEPLOY_REQUEST_ID).
// `release` deploys the repo's production release target instead
// of its steps; only releases.ts's runRelease passes it.
// Docker Hub's answers to a pull over its rate limit, as docker and compose
// print them: `toomanyrequests: You have reached your unauthenticated pull
// rate limit`, older daemons' `You have reached your pull rate limit`, and
// the bare HTTP status some build steps surface instead.
const RATE_LIMIT_PATTERN = /toomanyrequests|429 Too Many Requests|You have reached your (?:\w+ )?pull rate limit/i;

export function isDockerHubRateLimited(output: string): boolean {
  return RATE_LIMIT_PATTERN.test(output);
}

// The rate-limit retries live in the task's own comments, so a restarted
// poller picks up where it left off: each retry's comment carries this
// marker, and only the ones posted since the task entered `deploying` count.
export function rateLimitMarker(retry: number, nextAt: number): string {
  return `Docker Hub rate limit: retry ${retry} of ${DEPLOY_RATE_LIMIT_BACKOFF_MS.length}, next deploy attempt after ${new Date(nextAt).toISOString()}`;
}

export interface RateLimitState {
  retries: number;
  nextAt: number | null;
}

export function rateLimitState(
  comments: readonly { authorName: string; body: string; createdAt: string }[],
  stageEnteredAt: string | null,
): RateLimitState {
  const since = stageEnteredAt ? Date.parse(stageEnteredAt) : Number.NaN;
  const pattern = /^Docker Hub rate limit: retry (\d+) of \d+, next deploy attempt after (\S+)/m;
  let state: RateLimitState = { retries: 0, nextAt: null };
  for (const comment of comments) {
    if (comment.authorName !== PIPELINE_ACTOR.actorName) continue;
    if (Number.isFinite(since) && Date.parse(comment.createdAt) < since) continue;
    const match = pattern.exec(comment.body);
    const nextAt = match ? Date.parse(match[2]) : Number.NaN;
    if (match && Number.isFinite(nextAt)) state = { retries: Number(match[1]), nextAt };
  }
  return state;
}

// Whether a rate-limited deploy gets another try, and when. Null once the
// backoff schedule is spent: the caller falls back to the normal handback.
export function decideRateLimitRetry(retriesSoFar: number, now: number): { retry: number; nextAt: number } | null {
  const delay = DEPLOY_RATE_LIMIT_BACKOFF_MS[retriesSoFar];
  return delay === undefined ? null : { retry: retriesSoFar + 1, nextAt: now + delay };
}

export function deployService(repoSlug: string, env?: Record<string, string>, opts: { release?: boolean } = {}): CommandResult {
  const script = join(HOMELAB_ROOT, "homelab", "scripts", "deploy-service.sh");
  return run("bash", opts.release ? [script, "--release", repoSlug] : [script, repoSlug], {
    cwd: join(HOMELAB_ROOT, "homelab"),
    env,
  });
}

// The repo's own healthcheck, run the same way deploy-service.sh runs it:
// over SSH as HOMELAB_USER against each LXC its deploy declaration names. This
// is a second, independent check after the deploy script's own - the deploy's
// healthcheck confirms the containers came up, this confirms the service is
// still serving a moment later. #161 turns the single attempt into a retry.
export function healthcheckCommand(step: HostDeployStep): string {
  return step.type === "app" ? `cd /app && ./scripts/healthcheck.sh ${step.app}` : "cd /app && ./scripts/healthcheck.sh";
}

function healthcheckService(repoSlug: string): CommandResult & { skipped?: boolean } {
  const declaration = deployStepsFor(repoSlug);
  // An npm step's publish run is its own check (npm-publish.sh waits for it).
  const steps = declaration.ok ? declaration.steps.filter(isHostStep) : [];
  if (steps.length === 0) return { ok: true, stdout: "", stderr: "", skipped: true };
  const user = process.env.HOMELAB_USER ?? "marek";
  for (const step of steps) {
    const result = run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `${user}@${step.host}`, healthcheckCommand(step)]);
    if (!result.ok) return result;
  }
  return { ok: true, stdout: "", stderr: "" };
}

// ---------------------------------------------------------------------------
// Stage handlers
// ---------------------------------------------------------------------------

// `moved` is the status the task was moved to, or null when it was left in
// its stage for the next poll. Every handler returns one of these rather than
// moving the task itself, so advanceOne below is the single place that talks
// to pinboard about a transition.
export interface StageOutcome {
  moved: string | null;
  note: string;
  comment?: string;
  // Set only when `moved` is `queued`: pinboard refuses a handback that does
  // not say why, and the resumed run reads both fields to know what it is
  // fixing (see runner.ts's repairPromptLines).
  repair?: { reason: RepairReason; context: string };
}

// A failure no further agent run can help with: a human has to look. The
// evidence goes in the comment thread rather than only this process's
// journal, because that is where whoever picks it up will be.
function park(note: string, comment: string): StageOutcome {
  return { moved: "rework", note, comment };
}

// a failure an agent can plausibly fix, handed back to `queued`
// with its evidence. The task keeps its attemptCount (pinboard's
// applyTransition leaves it alone on purpose), so the runner's own attempt cap
// is what ends a repair loop - a task whose CI keeps failing gets its
// remaining attempts and then parks in `rework` like any other.
function handBack(reason: RepairReason, note: string, comment: string, context: string): StageOutcome {
  return { moved: "queued", note, comment, repair: { reason, context: truncateLog(context) } };
}

// who fixes a handed-back failure. Only a fully autonomous
// (`agent`) task goes back to `queued` for another agent run. A `human+agent`
// task has a person on it, and starting a second agent behind them would race
// whatever they are doing, so it parks in `rework` instead - with the same
// reason and evidence attached, which pinboard keeps so that the human's own
// requeue resumes exactly like an autonomous handback would. The failure
// notification fires either way (pinboard derives it from the repairReason).
export function routeHandback(outcome: StageOutcome, executorMode: string | undefined): StageOutcome {
  if (outcome.moved !== "queued" || !outcome.repair) return outcome;
  const trailer = (text: string) => (outcome.comment ? `${outcome.comment}\n\n${text}` : text);
  if (executorMode === "agent") {
    return { ...outcome, comment: trailer("Handed back to an agent to fix.") };
  }
  return {
    ...outcome,
    moved: "rework",
    note: `${outcome.note} (parked: ${executorMode ?? "unknown"} task, no second agent)`,
    comment: trailer(
      `Parked in \`rework\` rather than handed to another agent, because this task is \`${executorMode ?? "unknown"}\` and a second agent would race whoever is on it. Requeue it to resume with this failure as context.`,
    ),
  };
}

async function handleAwaitingCi(entry: PipelineTask, repos: PipelineRepo[], now: number): Promise<StageOutcome> {
  const branch = entry.prBranch;
  if (!branch) return park("no branch recorded", "In `awaiting_ci` with no branch recorded on its PR, so CI cannot be checked. Left for a human.");
  const elapsed = stageElapsedMs(entry.stageEnteredAt, now);

  const holdRepos: string[] = [];
  for (const repo of repos) {
    const org = orgForPr(repo.prUrl, entry.localPath);
    let ciRun: CiRunInfo | null;
    let headSha: string;
    try {
      headSha = fetchBranchHeadSha(org, repo.repoSlug, branch);
      ciRun = fetchLatestCiRun(org, repo.repoSlug, branch, headSha);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A `gh` blip is not a CI failure. Keep waiting and let the stage's own
      // timeout be what ends it, rather than parking a green task because
      // GitHub was briefly unreachable.
      if (elapsed < CI_TIMEOUT_MS) return { moved: null, note: reason };
      return park("CI unreadable", `Could not check CI for ${repo.repoSlug} for ${Math.round(elapsed / 60000)} minutes: ${reason}. Left for a human.`);
    }

    const mergeable = fetchPrMergeable(repo.prUrl);
    // Only worth reading when there is no run to go by.
    const hasWorkflows = !ciRun && mergeable !== "CONFLICTING" ? fetchHasWorkflows(org, repo.repoSlug, headSha) : true;
    const decision = evaluateCiRun(ciRun, elapsed, CI_TIMEOUT_MS, CI_APPEAR_GRACE_MS, { mergeable, hasWorkflows });
    if (decision.decision === "wait") {
      return { moved: null, note: ciRun ? `CI still running for ${repo.repoSlug}` : `waiting for a CI run for ${repo.repoSlug}` };
    }
    if (decision.decision === "conflict") return resolveCiConflict(entry.taskId, repo, branch, elapsed);
    if (decision.decision === "no_run") {
      return park(
        `no CI run for ${repo.repoSlug}`,
        `No CI run appeared for ${headSha} on ${repo.prUrl}; check the PR on GitHub (${decision.reason}). Not treated as a pass. Left for a human.`,
      );
    }
    if (decision.decision === "fail") {
      const failure = fetchCiFailure(org, repo.repoSlug, branch, run, headSha);
      const comments = await getComments(entry.taskId).catch(() => []);
      return decideCiFailure({
        repoSlug: repo.repoSlug,
        prUrl: repo.prUrl,
        branch,
        reason: decision.reason,
        failure,
        previousRunId: previousFailedRunId(comments, repo.repoSlug),
        redMain: fetchRedMain(org, repo.repoSlug),
      });
    }
  }

  // Only once every repo is green, so a task waiting on a slow CI run does not
  // re-read every other repo's diff on each poll.
  for (const repo of repos) {
    const files = prChangedFiles(repo.prUrl);
    if (files === null || touchesMigration(files)) holdRepos.push(repo.repoSlug);
  }

  const decision = decideAfterCi({
    autoDeployAllowed: entry.autoDeployAllowed,
    localPath: entry.localPath,
    repoSlugs: repos.map((r) => r.repoSlug),
    holdRepos,
  });
  return { moved: decision.to, note: "CI green", comment: decision.note };
}

// A PR that conflicts with its base gets no pull_request run at all, so the
// CI wait cannot end green. Same recovery as a merge that failed on a stale
// branch: rebase onto the base and force-push within the merge window (the
// new head then gets its own run), and hand the conflict to an agent when the
// rebase cannot clear it or the window has passed.
function resolveCiConflict(taskId: number, repo: PipelineRepo, branch: string, elapsed: number): StageOutcome {
  let gitOutput = `the PR still conflicts with its base after ${Math.round(elapsed / 60000)} minutes`;
  if (decideMergeFailure(elapsed) === "rebase") {
    const rebased = rebaseAndPushBranch(taskId, repo.repoSlug, branch);
    if (rebased.ok) return { moved: null, note: `rebased ${repo.repoSlug} onto its base after a conflict, waiting for CI` };
    // Already on top of the base: GitHub's mergeable flag is likely still the
    // one from before the last push. Read it again next poll.
    if (rebased.unchanged) return { moved: null, note: `${repo.repoSlug} is already rebased, waiting for GitHub to recompute mergeability` };
    gitOutput = rebased.stderr;
  }
  return handBack("merge_conflict", `PR conflicts with its base on ${repo.repoSlug}`, ciConflictComment(repo.prUrl, gitOutput), `${repo.prUrl} conflicts with its base branch, so GitHub runs no CI for it.\n\n${truncateLog(gitOutput)}`);
}

export function ciConflictComment(prUrl: string, gitOutput: string): string {
  const files = conflictingFiles(gitOutput);
  return [
    `${prUrl} conflicts with its base branch, so GitHub runs no CI for it and it cannot be treated as green.`,
    ...(files.length > 0 ? [`Conflicting files: ${files.join(", ")}.`] : []),
    "What the automatic rebase reported:",
    "",
    truncateLog(gitOutput),
    "",
    "The conflict needs resolving on the same branch.",
  ].join("\n");
}

// The PR's current title when its repo is public, else null (see
// squashMergeArgs). A title gh cannot read leaves gh's default subject, the
// same as before this check existed.
function publicPrTitle(prUrl: string, fallbackLocalPath: string | null): string | null {
  if (!isPublicOrg(orgForPr(prUrl, fallbackLocalPath))) return null;
  const view = run("gh", ["pr", "view", prUrl, "--json", "title", "--jq", ".title"]);
  return view.ok && view.stdout.trim() ? view.stdout.trim() : null;
}

async function handleAwaitingMerge(entry: PipelineTask, repos: PipelineRepo[], now: number): Promise<StageOutcome> {
  const merged: string[] = [];
  const elapsed = stageElapsedMs(entry.stageEnteredAt, now);
  for (const repo of repos) {
    // Idempotent on a re-run: a poller restart between the merge and the
    // transition would otherwise try to merge an already-merged PR and read
    // gh's refusal as a conflict.
    if (prIsMerged(repo.prUrl)) continue;
    const result = run("gh", squashMergeArgs(repo.prUrl, publicPrTitle(repo.prUrl, entry.localPath)));
    if (!result.ok) {
      // the common cause is this branch having fallen behind main
      // while it sat in CI, which costs nothing to fix here. Only a failure a
      // rebase cannot clear is worth waking an agent for.
      if (entry.prBranch && decideMergeFailure(elapsed) === "rebase") {
        const rebased = rebaseAndPushBranch(entry.taskId, repo.repoSlug, entry.prBranch);
        if (rebased.ok) {
          return { moved: null, note: `rebased ${repo.repoSlug} onto main after a failed merge, retrying` };
        }
        return handBack(
          "merge_conflict",
          `merge conflict on ${repo.repoSlug}`,
          [
            `Could not merge ${repo.prUrl}, and rebasing the branch onto origin/main did not clear it:`,
            "",
            truncateLog(rebased.stderr),
            "",
            "The conflict needs resolving on the same branch.",
          ].join("\n"),
          [`gh pr merge failed on ${repo.prUrl}:`, truncateLog(result.stderr), "", "git rebase onto origin/main then failed with:", truncateLog(rebased.stderr)].join("\n"),
        );
      }
      return handBack(
        "merge_conflict",
        `merge failed for ${repo.repoSlug}`,
        [
          `Could not merge ${repo.prUrl} after ${Math.round(elapsed / 60000)} minutes of retrying:`,
          "",
          truncateLog(result.stderr),
          "",
          "The branch needs getting into a mergeable state.",
        ].join("\n"),
        `gh pr merge failed on ${repo.prUrl}:\n${truncateLog(result.stderr)}`,
      );
    }
    merged.push(repo.prUrl);
    // Record the merge on the PR row immediately - see PipelineRepo.prId.
    await withRetry(() => updatePullRequestState(entry.taskId, repo.prId, "merged")).catch((err) =>
      console.error(`pipeline: could not mark ${repo.prUrl} merged in pinboard: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  refreshForDeploy(repos);
  return decideAfterMerge(merged, repos.map((r) => r.repoSlug), classifyDeployTargets(repos));
}

// What follows a merge. Deliberately takes no autoDeployAllowed and no
// previous stage: a merge reached from `review` (approved in pinboard's
// review queue, a past task) deploys exactly like an autonomous one, because
// that approval is the consent a project without auto-deploy withholds at
// decideAfterCi.
export function decideAfterMerge(
  merged: readonly string[],
  repoSlugs: readonly string[],
  targets: { deployable: readonly { repoSlug: string }[]; undeclared: readonly string[] },
): StageOutcome {
  const { deployable, undeclared } = targets;
  const mergedNote = merged.length > 0 ? `Merged ${merged.join(", ")}.` : "Already merged.";
  if (undeclared.length > 0) {
    return park("no deploy declaration", `${mergedNote} Not deploying: ${undeclared.join("; ")}. Add the declaration and deploy by hand.`);
  }
  if (deployable.length === 0) {
    return {
      moved: "review",
      note: "merged, nothing to deploy",
      comment: `${mergedNote} ${repoSlugs.join(", ")} declares no deploy steps, so nothing was deployed - see that repo's AGENTS.md "Close-out" for what shipping means for it.`,
    };
  }
  return { moved: "deploying", note: "merged", comment: `${mergedNote} Deploying ${deployable.map((r) => r.repoSlug).join(", ")}...` };
}

// The secret store's repo is recognised by the keyring.json at its root (see
// keyring-sync.ts), so no repo name is configured anywhere.
export function isSecretStoreRepo(repoSlug: string, workspaceRoot: string = HOMELAB_ROOT): boolean {
  return existsSync(join(workspaceRoot, repoSlug, "keyring.json"));
}

// what a merged secret-store PR means for this run's deploys. Reads
// keyring.json on both sides of the PR's squash commit in the workspace clone
// (refreshForDeploy has just fast-forwarded it).
export function keyringHostsForPr(prUrl: string, repoSlug: string, exec: Exec = run, workspaceRoot: string = HOMELAB_ROOT): string[] | { error: string } {
  const sha = exec("gh", ["pr", "view", prUrl, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
  const oid = sha.stdout.trim();
  if (!sha.ok || !oid) return { error: `could not read the merge commit of ${prUrl}: ${sha.stderr.trim() || "none recorded"}` };
  const read = (rev: string): KeyringConfig | { error: string } => {
    const shown = exec("git", ["-C", join(workspaceRoot, repoSlug), "show", `${rev}:keyring.json`]);
    if (!shown.ok) {
      // A commit without the file (its first one) renders nothing.
      if (/does not exist|exists on disk, but not in/.test(shown.stderr)) return {};
      return { error: `git show ${rev}:keyring.json failed: ${shown.stderr.trim()}` };
    }
    try {
      return JSON.parse(shown.stdout) as KeyringConfig;
    } catch (err) {
      return { error: `${rev}:keyring.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const before = read(`${oid}^`);
  if ("error" in before) return { error: before.error as string };
  const after = read(oid);
  if ("error" in after) return { error: after.error as string };
  return hostsNeedingSync(before, after);
}

// The secret store's agent API, the same call an agent makes by hand.
export function syncKeyringHosts(hosts: readonly string[], repoSlug: string, exec: Exec = run, workspaceRoot: string = HOMELAB_ROOT): { ok: boolean; detail: string } {
  const result = exec("bash", [join(workspaceRoot, repoSlug, "scripts", "agent-api.sh"), "POST", "/api/sync", JSON.stringify({ hosts })]);
  if (!result.ok) return { ok: false, detail: (result.stderr || result.stdout).trim() };
  return parseSyncResponse(result.stdout);
}

export type DeployAttempt = { ran: false; heldBy?: { taskId: number; startedAt: string } | null } | { ran: true; value: CommandResult };

export interface DeploySequenceDeps {
  deploy: (repoSlug: string) => Promise<DeployAttempt>;
  isSecretStore: (repoSlug: string) => boolean;
  keyringHosts: (prUrl: string, repoSlug: string) => string[] | { error: string };
  syncHosts: (hosts: readonly string[], repoSlug: string) => { ok: boolean; detail: string };
}

// The deploy stage's order, injectable so the tests can check it:
// the secret store deploys first, then every host its merged keyring.json
// change affects is synced, and only then does anything else deploy. A failed sync
// parks the task with the failure as repair context instead of letting a
// consumer deploy fail on an empty variable.
export async function runDeploySequence(
  deployable: readonly PipelineRepo[],
  elapsed: number,
  deps: DeploySequenceDeps,
  rateLimit: { retries: number; now: number } = { retries: 0, now: Date.now() },
): Promise<StageOutcome> {
  const store = deployable.filter((r) => deps.isSecretStore(r.repoSlug));
  const ordered = [...store, ...deployable.filter((r) => !store.includes(r))];
  for (const repo of ordered) {
    const held = await deps.deploy(repo.repoSlug);

    if (!held.ran) {
      if (elapsed >= DEPLOY_STAGE_TIMEOUT_MS) {
        const holder = held.heldBy ? ` (held by task ${held.heldBy.taskId} since ${held.heldBy.startedAt})` : "";
        return park(
          "deploy lock never freed",
          `Waited ${Math.round(elapsed / 60000)} minutes for ${repo.repoSlug}'s deploy lock${holder} and gave up. Deploy it manually once it is free.`,
        );
      }
      return { moved: null, note: `waiting for ${repo.repoSlug}'s deploy lock` };
    }

    if (!held.value.ok) {
      const output = truncateLog(held.value.stderr || held.value.stdout);
      const limited = isDockerHubRateLimited(`${held.value.stdout}\n${held.value.stderr}`);
      const retry = limited ? decideRateLimitRetry(rateLimit.retries, rateLimit.now) : null;
      if (retry) {
        return {
          moved: null,
          note: `${repo.repoSlug}'s deploy hit Docker Hub's rate limit, retrying after ${new Date(retry.nextAt).toISOString()}`,
          comment: [
            `Deploying ${repo.repoSlug} failed on Docker Hub's pull rate limit, which no agent can fix, so the task stays in \`deploying\` and the deploy is retried.`,
            "",
            rateLimitMarker(retry.retry, retry.nextAt),
            "",
            output,
          ].join("\n"),
        };
      }
      return handBack(
        "deploy_failed",
        `deploy failed for ${repo.repoSlug}`,
        [
          `Merged to main but deploying ${repo.repoSlug} failed:`,
          "",
          output,
          "",
          ...(limited ? [`It was still rate-limited by Docker Hub after ${DEPLOY_RATE_LIMIT_BACKOFF_MS.length + 1} attempts.`, ""] : []),
          "The change is already on main, so the fix goes on top of it.",
        ].join("\n"),
        `deploy-service.sh ${repo.repoSlug} failed after this task's change was merged to main:\n\n${output}`,
      );
    }

    if (store.includes(repo)) {
      const hosts = deps.keyringHosts(repo.prUrl, repo.repoSlug);
      let failure: string | null = null;
      if ("error" in hosts) {
        failure = `Could not work out which hosts keyring.json's change affects: ${hosts.error}`;
      } else if (hosts.length > 0) {
        const synced = deps.syncHosts(hosts, repo.repoSlug);
        if (!synced.ok) failure = `Syncing ${hosts.join(", ")} through ${repo.repoSlug}'s agent API failed:\n\n${truncateLog(synced.detail)}`;
      }
      if (failure) {
        const rest = ordered.filter((r) => !store.includes(r)).map((r) => r.repoSlug);
        return {
          moved: "rework",
          note: "secret store sync failed",
          comment: [
            `${repo.repoSlug} deployed, but its merged keyring.json change was not synced to the hosts it affects, so nothing else was deployed.`,
            "",
            failure,
            "",
            `Fix it by hand: \`${repo.repoSlug}/scripts/agent-api.sh POST /api/sync '{"hosts":[...]}'\` (or \`${repo.repoSlug}/scripts/sync.sh <host>\`)${rest.length > 0 ? `, then \`deploy-service.sh ${rest.join(" ")}\`` : ""}.`,
          ].join("\n"),
          repair: { reason: "deploy_failed", context: truncateLog(failure) },
        };
      }
    }
  }

  return { moved: "verifying", note: "deployed" };
}

async function handleDeploying(entry: PipelineTask, repos: PipelineRepo[], now: number): Promise<StageOutcome> {
  refreshForDeploy(repos);
  const { deployable, undeclared } = classifyDeployTargets(repos);
  if (undeclared.length > 0) {
    return park("no deploy declaration", `Merged, but not deploying: ${undeclared.join("; ")}. Add the declaration and deploy by hand.`);
  }
  if (deployable.length === 0) return { moved: "verifying", note: "nothing to deploy" };

  // A rate-limited deploy waits out its backoff here, and once it is due the
  // lock-wait clock restarts from then rather than from entering the stage.
  const comments = await getComments(entry.taskId).catch(() => []);
  const limited = rateLimitState(comments, entry.stageEnteredAt);
  if (limited.nextAt !== null && now < limited.nextAt) {
    return { moved: null, note: `Docker Hub rate limit, next deploy attempt after ${new Date(limited.nextAt).toISOString()}` };
  }
  const elapsed = limited.nextAt !== null ? now - limited.nextAt : stageElapsedMs(entry.stageEnteredAt, now);

  return runDeploySequence(deployable, elapsed, {
    // A past task's per-repo deploy lock, inherited unchanged: two
    // deploy-service.sh runs against the same LXC would fight over the same
    // containers. The lock is a file rather than an in-process mutex because
    // a manual `work task run` is a different process from this one.
    deploy: (repoSlug) =>
      withDeployLock(
        repoSlug,
        entry.taskId,
        async () =>
          deployService(repoSlug, {
            DEPLOY_ACTOR: `${PIPELINE_ACTOR.actorType}:${PIPELINE_ACTOR.actorName}`,
            DEPLOY_TASK_ID: String(entry.taskId),
          }),
        {
          // Do not block the whole poll waiting for another deploy: give it one
          // short attempt and come back next tick, so other tasks' stages keep
          // moving while this one queues.
          waitMs: 5_000,
        },
      ),
    isSecretStore: (repoSlug) => isSecretStoreRepo(repoSlug),
    keyringHosts: (prUrl, repoSlug) => keyringHostsForPr(prUrl, repoSlug),
    syncHosts: (hosts, repoSlug) => syncKeyringHosts(hosts, repoSlug),
  }, { retries: limited.retries, now });
}

async function handleVerifying(entry: PipelineTask, repos: PipelineRepo[], now: number): Promise<StageOutcome> {
  const checked: string[] = [];
  const elapsed = stageElapsedMs(entry.stageEnteredAt, now);
  for (const repo of repos) {
    const result = healthcheckService(repo.repoSlug);
    if (result.skipped) continue;
    if (!result.ok) {
      const output = truncateLog(result.stderr || result.stdout);
      // one failed check is not a failed deploy - a service that
      // has just been recreated can legitimately fail its own healthcheck for
      // a few seconds. Retry (one attempt per poll) until the stage's own
      // clock runs out.
      if (decideHealthcheckFailure(elapsed) === "retry") {
        return { moved: null, note: `${repo.repoSlug}'s healthcheck has not passed yet, retrying` };
      }
      return handBack(
        "deploy_failed",
        `healthcheck failed for ${repo.repoSlug}`,
        [
          `Deployed ${repo.repoSlug}, but its healthcheck did not pass in the ${Math.round(VERIFY_TIMEOUT_MS / 60000)} minutes after:`,
          "",
          output,
          "",
          "The change is already on main, so the fix goes on top of it.",
        ].join("\n"),
        `${repo.repoSlug}'s own scripts/healthcheck.sh kept failing for ${Math.round(elapsed / 60000)} minutes after this task's change was deployed:\n\n${output}`,
      );
    }
    checked.push(repo.repoSlug);
  }
  const decision = decideAfterVerify(entry.executorMode, checked);
  return { moved: decision.to, note: "verified", comment: decision.note };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface PipelineOutcome {
  taskId: number;
  stage: PipelineStage;
  moved: string | null;
  note: string;
}

async function advanceOne(entry: PipelineTask, now: number): Promise<PipelineOutcome> {
  // `awaiting_review` is a human hold - nothing here releases it, the review
  // queue's Approve does (pinboard moves it straight to `awaiting_merge`).
  if (entry.stage === "awaiting_review") return { taskId: entry.taskId, stage: entry.stage, moved: null, note: "held for review" };

  const prs = await listPullRequests(entry.taskId);
  const repos = pipelineRepos(prs, entry.prBranch);

  let outcome: StageOutcome;
  if (repos.length === 0) {
    outcome = park("no PR recorded", `In \`${entry.stage}\` with no pull request recorded for this attempt, so there is nothing to drive. Left for a human.`);
  } else if (entry.stage === "awaiting_ci") {
    outcome = await handleAwaitingCi(entry, repos, now);
  } else if (entry.stage === "awaiting_merge") {
    outcome = await handleAwaitingMerge(entry, repos, now);
  } else if (entry.stage === "deploying") {
    outcome = await handleDeploying(entry, repos, now);
  } else {
    outcome = await handleVerifying(entry, repos, now);
  }
  outcome = routeHandback(outcome, entry.executorMode);

  if (outcome.comment) {
    await withRetry(() => addComment(entry.taskId, PIPELINE_ACTOR, outcome.comment as string));
  }
  if (outcome.moved) {
    await withRetry(() => advancePipeline(entry.taskId, PIPELINE_ACTOR, outcome.moved as string, outcome.repair));
  }
  return { taskId: entry.taskId, stage: entry.stage, moved: outcome.moved, note: outcome.note };
}

export interface PipelineResult {
  outcomes: PipelineOutcome[];
}

// One pass over everything in flight. Each task is handled independently: a
// wedged repo or a `gh` failure on one must not stop the rest of the
// pipeline, exactly like the dispatch loop's own per-poller try/catch.
export async function pipelineOnce(now = Date.now()): Promise<PipelineResult> {
  const entries = await getPipelineNext();
  const outcomes: PipelineOutcome[] = [];
  for (const entry of entries) {
    try {
      outcomes.push(await advanceOne(entry, now));
    } catch (err) {
      console.error(`pipeline: task ${entry.taskId} (${entry.stage}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { outcomes };
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

// Same signal contract as the dispatch loop: stop between polls, never
// mid-stage. A stage this process is in the middle of (a deploy, say) is left
// to finish, and because every decision is re-derived from pinboard on the
// next poll, an interrupted pass costs nothing but a repeat.
// afterPoll (the releases probe and Deploy-now requests) runs once
// per interval after the pipeline's own pass, under the same error handling.
export async function runPipelineLoop(intervalSeconds: number, signal?: AbortSignal, afterPoll?: () => Promise<void>): Promise<void> {
  let lastQuietLog = "";
  while (!signal?.aborted) {
    try {
      const result = await pipelineOnce();
      for (const outcome of result.outcomes) {
        if (outcome.moved) {
          console.log(`pipeline: #${outcome.taskId} ${outcome.stage} -> ${outcome.moved} (${outcome.note})`);
          lastQuietLog = "";
        } else {
          // A task legitimately sits in a stage for minutes. Log the reason
          // only when it changes, so a normal CI wait does not write the same
          // line every interval.
          const line = `pipeline: #${outcome.taskId} still ${outcome.stage} - ${outcome.note}`;
          if (line !== lastQuietLog) {
            console.log(line);
            lastQuietLog = line;
          }
        }
      }
    } catch (err) {
      console.error(`pipeline: poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (afterPoll && !signal?.aborted) {
      try {
        await afterPoll();
      } catch (err) {
        console.error(`pipeline: after-poll step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signal?.aborted) return;
    await sleep(intervalSeconds * 1000, signal);
  }
}
