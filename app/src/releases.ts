// foreman's half of pinboard's releases view. Pinboard holds no
// SSH keys or GitHub credentials, so two things run here, inside the pipeline
// loop:
//
//   - the probe: for every project with a deploy declaration, SSH to each
//     step's host, read the commit its checkout is on, compare it with the
//     default branch on GitHub, and PUT the result to pinboard.
//   - Deploy now: claim a queued deploy request, run deploy-service.sh for
//     the project's repo (which reports each step itself), and report back.
//
// Production is not deployable from Deploy now: a request for a repo whose
// steps name the production host is refused rather than run. A past task gives
// production its own human-gated release instead - the declaration's
// `release` block, run only by a release request (runRelease below):
//
//   1. clone the app repo, bump every versionFile by the requested bump and
//      push that commit to the default branch;
//   2. fast-forward the release branch to it, which starts the app's release
//      workflow (tag + build + push images v<version>);
//   3. wait for that workflow run to succeed;
//   4. bump the literal image tags in the production compose file (in its own
//      homelab repo) and push;
//   5. deploy-service.sh --release, which pulls it on the host, runs
//      deploy.sh <app> and polls healthcheck.sh <app>.
//
// The probe reports a release target too: the image tag the host's compose
// file pins, resolved to the commit that tag points at, so pending commits
// read as "not released yet".
//
// An npm step has no host to SSH to. It is reported as host `npm`,
// app <package>: the newest `<package>-v<version>` tag is what is published,
// and commits on the default branch since that tag are pending.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspaceRoot } from "./paths.js";
import {
  type DeployStep,
  type HostDeployStep,
  HOMELAB_ROOT,
  isHostStep,
  type NpmDeployStep,
  type ReleaseTarget,
  deployService,
  deployStepsFor,
  refreshWorkspaceClone,
  repoOrgFor,
  run,
  truncateLog,
  withRetry,
} from "./pipeline.js";
import { type ClaimedDeployRequest, claimDeployRequest, finishDeployRequest, listProjects, putDeployTargets, type Project } from "./pinboard.js";
import { TASK_ROOT, withDeployLock } from "./workdir.js";

export const RELEASES_ACTOR = "agent:foreman-releases";
// A full probe takes about 2 minutes and holds up pipeline stages meanwhile,
// so it runs every 30 minutes; Deploy now re-probes its own project at once.
export const DEFAULT_PROBE_INTERVAL_SECONDS = 1800;
const MAX_PENDING_COMMITS = 30;
// A Deploy-now request is a human waiting on a button, so it waits for a
// busy deploy lock longer than the pipeline's one short attempt does.
const REQUEST_LOCK_WAIT_MS = 10 * 60 * 1000;
const PRODUCTION_HOST = "production";

export interface PendingCommit {
  sha: string;
  subject: string;
}

export interface TargetReport {
  host: string;
  app: string;
  deployedSha: string | null;
  mainSha: string | null;
  pendingCount: number | null;
  pendingCommits: PendingCommit[];
  probeError: string | null;
  // a production release target, and the image tag it runs.
  release: boolean;
  deployedVersion: string | null;
}

// Where a step's code lives on its host: /app for a dedicated LXC, the app's
// own clone for an app on a shared one (production has none, so its sha
// reads as unknown until #229 reports image tags instead).
export function checkoutDir(step: HostDeployStep): string {
  return step.type === "app" ? `/app/projects/${step.app}` : "/app";
}

export function deployedShaCommand(step: HostDeployStep): string {
  const dir = checkoutDir(step);
  return `[ -d ${dir}/.git ] && git -C ${dir} rev-parse HEAD || echo none`;
}

interface CompareResult {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  commits?: { sha: string; message: string }[];
}

// GitHub's compare of deployed...main. "ahead" is the normal case: main has
// commits the host does not. "behind" or "diverged" means the host checkout
// has commits that are not on main - worth flagging, since a pull there will
// not fast-forward.
export function pendingFromCompare(cmp: CompareResult): Pick<TargetReport, "pendingCount" | "pendingCommits" | "probeError"> {
  const ahead = cmp.ahead_by ?? 0;
  const commits = (cmp.commits ?? [])
    .map((c) => ({ sha: c.sha, subject: c.message.split("\n")[0] }))
    .reverse()
    .slice(0, MAX_PENDING_COMMITS);
  if (cmp.status === "identical" || cmp.status === "ahead") return { pendingCount: ahead, pendingCommits: ahead ? commits : [], probeError: null };
  return {
    pendingCount: ahead,
    pendingCommits: commits,
    probeError: `the host's checkout has ${cmp.behind_by ?? "?"} commit(s) that are not on the default branch (${cmp.status})`,
  };
}

function repoSlugOf(project: Project): string | null {
  return project.localPath?.split("/")[1] ?? null;
}

function sshUser(): string {
  return process.env.HOMELAB_USER ?? "marek";
}

function ghJson<T>(path: string, jq: string): { ok: true; value: T } | { ok: false; error: string } {
  const result = run("gh", ["api", path, "--jq", jq]);
  if (!result.ok) return { ok: false, error: result.stderr.split("\n")[0] };
  try {
    return { ok: true, value: JSON.parse(result.stdout) as T };
  } catch (err) {
    return { ok: false, error: `unexpected gh output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type BaseReport = Omit<TargetReport, "deployedSha">;

// The half of a probe shared by steps and release targets: given the commit a
// target runs, how far behind the default branch is it.
function compareWithMain(base: BaseReport, deployed: string, org: string, repo: string, mainSha: string | null): TargetReport {
  if (!mainSha) return { ...base, deployedSha: deployed };
  if (deployed === mainSha) return { ...base, deployedSha: deployed, pendingCount: 0 };
  const cmp = ghJson<CompareResult>(
    `repos/${org}/${repo}/compare/${deployed}...${mainSha}`,
    "{status, ahead_by, behind_by, commits: [.commits[] | {sha, message: .commit.message}]}",
  );
  if (!cmp.ok) return { ...base, deployedSha: deployed, probeError: `could not compare with the default branch: ${cmp.error}` };
  return { ...base, deployedSha: deployed, ...pendingFromCompare(cmp.value) };
}

// The tag prefix an npm step publishes under: `<package>-v` in a monorepo,
// plain `v` for a single-package repo (`root: true`, a past task).
export function npmTagPrefix(step: NpmDeployStep): string {
  return step.root ? "v" : `${step.package}-v`;
}

// The highest version among the `<tagPrefix><version>` tag names.
export function latestPackageTag(tagPrefix: string, refs: readonly string[]): { tag: string; version: string } | null {
  const prefix = `refs/tags/${tagPrefix}`;
  let best: { tag: string; version: string; parts: number[] } | null = null;
  for (const ref of refs) {
    if (!ref.startsWith(prefix)) continue;
    const version = ref.slice(prefix.length);
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const parts = version.split(".").map(Number);
    const diff = best ? parts.map((n, i) => n - best!.parts[i]).find((d) => d !== 0) ?? 0 : 1;
    if (diff > 0) best = { tag: ref.slice("refs/tags/".length), version, parts };
  }
  return best && { tag: best.tag, version: best.version };
}

function probeNpm(step: NpmDeployStep, org: string, repo: string, mainSha: string | null, mainError: string | null): TargetReport {
  const base: TargetReport = {
    host: "npm",
    app: step.package,
    deployedSha: null,
    mainSha,
    pendingCount: null,
    pendingCommits: [],
    probeError: mainError,
    release: false,
    deployedVersion: null,
  };
  const tagPrefix = npmTagPrefix(step);
  const refs = ghJson<string[]>(`repos/${org}/${repo}/git/matching-refs/tags/${tagPrefix}`, "[.[].ref]");
  if (!refs.ok) return { ...base, probeError: `could not list ${step.package} tags: ${refs.error}` };
  const latest = latestPackageTag(tagPrefix, refs.value);
  if (!latest) return { ...base, probeError: `no ${tagPrefix}<version> tag yet, so nothing is published under this convention` };
  const withVersion = { ...base, deployedVersion: latest.version };
  const commit = run("gh", ["api", `repos/${org}/${repo}/commits/${latest.tag}`, "--jq", ".sha"]);
  if (!commit.ok) return { ...withVersion, probeError: `could not resolve tag ${latest.tag}: ${commit.stderr.split("\n")[0]}` };
  return compareWithMain(withVersion, commit.stdout.trim(), org, repo, mainSha);
}

function probeStep(step: DeployStep, org: string, repo: string, mainSha: string | null, mainError: string | null): TargetReport {
  if (!isHostStep(step)) return probeNpm(step, org, repo, mainSha, mainError);
  const base: TargetReport = {
    host: step.host,
    app: step.type === "app" ? step.app : "",
    deployedSha: null,
    mainSha,
    pendingCount: null,
    pendingCommits: [],
    probeError: mainError,
    release: false,
    deployedVersion: null,
  };
  const ssh = run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `${sshUser()}@${step.host}`, deployedShaCommand(step)]);
  if (!ssh.ok) return { ...base, probeError: `could not reach ${step.host}: ${ssh.stderr.split("\n")[0]}` };
  const deployed = ssh.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(deployed)) return { ...base, probeError: `no git checkout at ${checkoutDir(step)} on ${step.host}` };
  return compareWithMain(base, deployed, org, repo, mainSha);
}

// A release target runs whatever image tag the host's compose file pins.
function probeRelease(release: ReleaseTarget, org: string, repo: string, mainSha: string | null, mainError: string | null): TargetReport {
  const base: TargetReport = {
    host: release.host,
    app: release.app,
    deployedSha: null,
    mainSha,
    pendingCount: null,
    pendingCommits: [],
    probeError: mainError,
    release: true,
    deployedVersion: null,
  };
  const ssh = run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `${sshUser()}@${release.host}`, `cat /app/${release.composeFile}`]);
  if (!ssh.ok) return { ...base, probeError: `could not read /app/${release.composeFile} on ${release.host}: ${ssh.stderr.split("\n")[0]}` };
  const tag = imageTag(ssh.stdout, release.images);
  if (!tag.ok) return { ...base, probeError: tag.error };
  const withVersion = { ...base, deployedVersion: tag.tag };
  const commit = run("gh", ["api", `repos/${org}/${repo}/commits/${tag.tag}`, "--jq", ".sha"]);
  if (!commit.ok) return { ...withVersion, probeError: `could not resolve tag ${tag.tag}: ${commit.stderr.split("\n")[0]}` };
  return compareWithMain(withVersion, commit.stdout.trim(), org, repo, mainSha);
}

// Probes one project. Returns null when it has no usable declaration (not
// reported, so a transiently broken declaration does not wipe its rows).
export async function probeProject(project: Project): Promise<TargetReport[] | null> {
  const repo = repoSlugOf(project);
  if (!repo) return null;
  // Repos in the workspace's own org carry their declaration in their own clone.
  const warning = refreshWorkspaceClone(repo);
  if (warning) console.error(`releases: ${warning}`);
  const declaration = deployStepsFor(repo);
  if (!declaration.ok) return null;
  if (declaration.steps.length === 0 && !declaration.release) {
    await putDeployTargets(project.id, []);
    return [];
  }
  const org = repoOrgFor(project.localPath);
  const main = run("gh", ["api", `repos/${org}/${repo}/commits/HEAD`, "--jq", ".sha"]);
  const mainSha = main.ok ? main.stdout.trim() : null;
  const mainError = main.ok ? null : `could not read the default branch: ${main.stderr.split("\n")[0]}`;
  const targets = declaration.steps.map((step) => probeStep(step, org, repo, mainSha, mainError));
  if (declaration.release) targets.push(probeRelease(declaration.release, org, repo, mainSha, mainError));
  await putDeployTargets(project.id, targets);
  return targets;
}

export async function probeAll(): Promise<{ probed: number; failed: number }> {
  refreshWorkspaceClone("homelab", HOMELAB_ROOT);
  let probed = 0;
  let failed = 0;
  for (const project of await listProjects()) {
    try {
      if (await probeProject(project)) probed++;
    } catch (err) {
      failed++;
      console.error(`releases: probing ${project.slug} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { probed, failed };
}

// Claims and runs at most one Deploy-now request. Returns what happened, or
// null when nothing was queued.
export async function runNextDeployRequest(): Promise<string | null> {
  const request = await claimDeployRequest();
  if (!request) return null;
  const repo = request.localPath?.split("/")[1];
  const kind = request.kind === "release" ? "release" : "deploy";
  const finish = async (ok: boolean, output: string, version?: string): Promise<string> => {
    // withRetry: deploying pinboard itself restarts the API this reports to.
    await withRetry(() => finishDeployRequest(request.id, ok, output, version));
    return `${kind} request #${request.id} (${request.slug})${version ? ` ${version}` : ""} ${ok ? "succeeded" : "failed"}`;
  };
  if (!repo) return finish(false, `${request.slug} has no localPath`);

  refreshWorkspaceClone("homelab", HOMELAB_ROOT);
  refreshWorkspaceClone(repo);
  const declaration = deployStepsFor(repo);
  if (!declaration.ok) return finish(false, declaration.error);

  if (kind === "release") {
    if (!declaration.release) return finish(false, `${repo} declares no production release (a \`release\` block in its deploy declaration).`);
    const result = await runRelease(request, repo, repoOrgFor(request.localPath), declaration.release);
    const message = await finish(result.ok, truncateLog(result.log.join("\n")), result.version);
    await reprobe(request.projectId);
    return message;
  }

  if (declaration.steps.some((step) => isHostStep(step) && step.host === PRODUCTION_HOST)) {
    return finish(false, `${repo} deploys to production, which only releases through its human-gated release, not Deploy now.`);
  }

  // The lock records a task id; a request has none, so 0 stands for "a
  // Deploy-now request" in the holder message another deploy would print.
  const held = await withDeployLock(
    repo,
    0,
    async () => deployService(repo, { DEPLOY_ACTOR: RELEASES_ACTOR, DEPLOY_REQUEST_ID: String(request.id) }),
    { waitMs: REQUEST_LOCK_WAIT_MS },
  );
  let message: string;
  if (!held.ran) {
    const holder = held.heldBy ? ` (held by task ${held.heldBy.taskId})` : "";
    message = await finish(false, `${repo}'s deploy lock stayed busy for ${REQUEST_LOCK_WAIT_MS / 60000} minutes${holder}.`);
  } else {
    const output = truncateLog([held.value.stdout, held.value.stderr].filter(Boolean).join("\n"));
    message = await finish(held.value.ok, output);
  }

  await reprobe(request.projectId);
  return message;
}

// Show a request's result on the releases view now rather than at the next probe.
async function reprobe(projectId: number): Promise<void> {
  const project = (await listProjects()).find((p) => p.id === projectId);
  if (project) await probeProject(project).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// the production release
// ---------------------------------------------------------------------------

export type ReleaseBump = "patch" | "minor" | "major";

export function bumpVersion(version: string, bump: ReleaseBump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`version ${JSON.stringify(version)} is not plain major.minor.patch`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function packageVersion(text: string, file: string): string {
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error(`${file} has no top-level "version"`);
  return version;
}

// Rewrites a package.json's top-level version in place, keeping the rest of
// the file byte for byte (a JSON round trip would reformat it). The top-level
// "version" comes before any nested one in every package.json here; the
// re-parse makes sure that held.
export function setPackageVersion(text: string, file: string, version: string): string {
  const current = packageVersion(text, file);
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = text.replace(new RegExp(`("version"\\s*:\\s*")${escaped}(")`), `$1${version}$2`);
  if (packageVersion(next, file) !== version) throw new Error(`could not rewrite the top-level version in ${file}`);
  return next;
}

function imageLine(image: string): RegExp {
  const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\s*image:\\s*["']?${escaped}:)([A-Za-z0-9._-]+)(["']?\\s*)$`, "m");
}

// The one tag every declared image is pinned to. Images released together
// must agree; a compose file where they do not is reported, not guessed at.
export function imageTag(compose: string, images: string[]): { ok: true; tag: string } | { ok: false; error: string } {
  const tags = new Set<string>();
  for (const image of images) {
    const m = imageLine(image).exec(compose);
    if (!m) return { ok: false, error: `no pinned \`image: ${image}:<tag>\` line in the compose file` };
    tags.add(m[2]);
  }
  if (tags.size !== 1) return { ok: false, error: `the declared images are pinned to different tags (${[...tags].join(", ")})` };
  return { ok: true, tag: [...tags][0] };
}

export function setImageTags(compose: string, images: string[], tag: string): string {
  let next = compose;
  for (const image of images) {
    if (!imageLine(image).test(next)) throw new Error(`no pinned \`image: ${image}:<tag>\` line in the compose file`);
    next = next.replace(imageLine(image), `$1${tag}$3`);
  }
  return next;
}

export interface WorkflowRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
}

// The release workflow run for the commit just pushed, if GitHub has one yet.
export function runForCommit(runs: readonly WorkflowRun[], sha: string): WorkflowRun | null {
  return runs.find((r) => r.headSha === sha) ?? null;
}

export const RELEASE_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const RELEASE_POLL_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReleaseResult {
  ok: boolean;
  version?: string;
  log: string[];
}

// Runs one production release end to end. Every step is logged into the
// request's output, and a failure says what has already been pushed, because
// the steps are not atomic: a bump pushed to the default branch stays there
// even if the build later fails.
export async function runRelease(request: ClaimedDeployRequest, repo: string, org: string, release: ReleaseTarget): Promise<ReleaseResult> {
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    console.log(`releases: #${request.id} ${line}`);
  };
  const fail = (line: string): ReleaseResult => {
    say(`FAILED: ${line}`);
    return { ok: false, version, log };
  };
  const git = (args: string[], cwd: string) => run("git", args, { cwd });
  let version: string | undefined;

  const workdir = join(TASK_ROOT, ".releases", `request-${request.id}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  const appDir = join(workdir, repo);
  const composeDir = join(workdir, release.composeRepo);

  // 1. Version bump on the default branch.
  say(`cloning ${org}/${repo}`);
  const clone = run("git", ["clone", "--quiet", `git@github.com:${org}/${repo}.git`, appDir]);
  if (!clone.ok) return fail(`clone: ${clone.stderr}`);
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], appDir);
  const defaultBranch = head.ok ? head.stdout.trim().replace(/^origin\//, "") : "main";
  const hasBranch = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${release.branch}`], appDir).ok;
  if (hasBranch && !git(["merge-base", "--is-ancestor", `origin/${release.branch}`, "HEAD"], appDir).ok) {
    return fail(`${release.branch} has commits that are not on ${defaultBranch}, so it cannot be fast-forwarded. Merge them back into ${defaultBranch} first.`);
  }

  const bump = request.bump ?? "patch";
  try {
    const versions = release.versionFiles.map((file) => packageVersion(readFileSync(join(appDir, file), "utf8"), file));
    if (new Set(versions).size !== 1) return fail(`the version files disagree (${release.versionFiles.map((f, i) => `${f} ${versions[i]}`).join(", ")})`);
    version = `v${bumpVersion(versions[0], bump)}`;
    say(`${bump} bump: v${versions[0]} -> ${version}`);
    for (const file of release.versionFiles) {
      const path = join(appDir, file);
      writeFileSync(path, setPackageVersion(readFileSync(path, "utf8"), file, version.slice(1)));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const tagTaken = git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${version}`], appDir);
  if (tagTaken.ok) return fail(`tag ${version} already exists on ${org}/${repo}`);

  const commit = git(["commit", "--quiet", "-m", `Update: release ${version} (pinboard release request #${request.id})`, "--", ...release.versionFiles], appDir);
  if (!commit.ok) return fail(`commit: ${commit.stderr}`);
  const sha = git(["rev-parse", "HEAD"], appDir).stdout.trim();
  const pushMain = git(["push", "--quiet", "origin", `HEAD:${defaultBranch}`], appDir);
  if (!pushMain.ok) return fail(`push to ${defaultBranch} (nothing was changed): ${pushMain.stderr}`);
  say(`pushed ${sha.slice(0, 7)} to ${defaultBranch}`);

  // 2. Release branch -> the build.
  const pushBranch = git(["push", "--quiet", "origin", `HEAD:${release.branch}`], appDir);
  if (!pushBranch.ok) {
    return fail(`push to ${release.branch}: ${pushBranch.stderr}. The ${version} bump is already on ${defaultBranch}; fast-forward ${release.branch} to ${sha.slice(0, 7)} by hand, or the next release will bump past it.`);
  }
  say(`fast-forwarded ${release.branch}, waiting for ${release.workflow}`);

  // 3. Wait for the images.
  const deadline = Date.now() + RELEASE_WORKFLOW_TIMEOUT_MS;
  let found: WorkflowRun | null = null;
  for (;;) {
    const list = run("gh", [
      "run", "list", "--repo", `${org}/${repo}`, "--workflow", release.workflow, "--branch", release.branch,
      "--limit", "10", "--json", "databaseId,status,conclusion,headSha,url",
    ]);
    if (list.ok) {
      try {
        found = runForCommit(JSON.parse(list.stdout) as WorkflowRun[], sha);
      } catch {
        found = null;
      }
    }
    if (found?.status === "completed") break;
    if (Date.now() > deadline) {
      return fail(`${release.workflow} for ${sha.slice(0, 7)} did not finish within ${RELEASE_WORKFLOW_TIMEOUT_MS / 60000} minutes${found ? ` (${found.url})` : " (no run seen)"}. Production was not touched.`);
    }
    await sleep(RELEASE_POLL_MS);
  }
  if (found.conclusion !== "success") return fail(`${release.workflow} concluded ${found.conclusion} (${found.url}). Production was not touched.`);
  say(`${release.workflow} succeeded (${found.url})`);

  // 4. Pin the new tag for production.
  const composeClone = run("git", ["clone", "--quiet", `git@github.com:${repoOrgFor(relative(workspaceRoot(), join(HOMELAB_ROOT, release.composeRepo)))}/${release.composeRepo}.git`, composeDir]);
  if (!composeClone.ok) return fail(`clone ${release.composeRepo}: ${composeClone.stderr}. ${version} is already tagged and built from ${defaultBranch}; bump ${release.composeFile} by hand.`);
  try {
    const path = join(composeDir, release.composeFile);
    writeFileSync(path, setImageTags(readFileSync(path, "utf8"), release.images, version));
  } catch (err) {
    return fail(`${release.composeFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const composeCommit = git(["commit", "--quiet", "-m", `Update: ${release.app} ${version} (release request #${request.id}, ${org}/${repo}@${sha.slice(0, 7)})`, "--", release.composeFile], composeDir);
  if (!composeCommit.ok) return fail(`commit ${release.composeFile}: ${composeCommit.stderr}`);
  const pushCompose = git(["push", "--quiet", "origin", "HEAD"], composeDir);
  if (!pushCompose.ok) return fail(`push ${release.composeRepo}: ${pushCompose.stderr}. Images ${version} are built; production still runs the old tag.`);
  say(`pinned ${version} in ${release.composeRepo}/${release.composeFile}`);

  // 5. Deploy it.
  const held = await withDeployLock(
    repo,
    0,
    async () => deployService(repo, { DEPLOY_ACTOR: RELEASES_ACTOR, DEPLOY_REQUEST_ID: String(request.id), DEPLOY_SHA: sha }, { release: true }),
    { waitMs: REQUEST_LOCK_WAIT_MS },
  );
  if (!held.ran) return fail(`${repo}'s deploy lock stayed busy; ${version} is pinned but not deployed. Run deploy-service.sh --release ${repo}.`);
  say([held.value.stdout, held.value.stderr].filter(Boolean).join("\n").trim());
  if (!held.value.ok) return fail(`deploy on ${release.host} failed; ${version} is pinned in ${release.composeRepo} but may not be running.`);
  say(`${version} is live on ${release.host}`);
  rmSync(workdir, { recursive: true, force: true });
  return { ok: true, version, log };
}
