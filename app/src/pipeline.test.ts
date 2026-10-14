import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideAfterCi,
  decideAfterVerify,
  decideHealthcheckFailure,
  decideMergeFailure,
  evaluateCiRun,
  classifyDeployTargets,
  orderLibrariesFirst,
  healthcheckCommand,
  refreshWorkspaceClone,
  deployStepsFor,
  pipelineRepos,
  repoOrgFor,
  isPublicRepo,
  publicGithubOrgs,
  squashMergeArgs,
  githubOrgFromUrl,
  stageElapsedMs,
  touchesMigration,
  truncateLog,
  withRetry,
  routeHandback,
  decideCiFailure,
  extractFailingSection,
  failedRunMarker,
  fetchCiFailure,
  fetchBranchHeadSha,
  fetchLatestCiRun,
  orgForPr,
  decideAfterMerge,
  fetchRedMain,
  previousFailedRunId,
  isDockerHubRateLimited,
  rateLimitMarker,
  rateLimitState,
  decideRateLimitRetry,
  runDeploySequence,
  DEPLOY_RATE_LIMIT_BACKOFF_MS,
  type DeploySequenceDeps,
  type CiFailure,
  type Exec,
} from "./pipeline.js";
import type { PullRequest } from "./pinboard.js";

// I13, now the poller's: evaluateCiRun drives whether the pipeline waits in
// `awaiting_ci`, moves on, or parks - mirrors deploy-service.sh's own bash
// CI-wait loop.
test("evaluateCiRun proceeds when no run is found at all and no grace period is configured", () => {
  assert.equal(evaluateCiRun(null, 0, 60_000).decision, "proceed");
});

test("evaluateCiRun waits for a run to appear within the grace period", () => {
  assert.equal(evaluateCiRun(null, 0, 60_000, 30_000).decision, "wait");
});

test("evaluateCiRun proceeds once no run has appeared after the grace period elapses", () => {
  assert.equal(evaluateCiRun(null, 30_000, 60_000, 30_000).decision, "proceed");
});

test("evaluateCiRun waits while a run is still in progress and under the timeout", () => {
  const run = { status: "in_progress", conclusion: null, url: "https://example.com/run/1" };
  assert.equal(evaluateCiRun(run, 1_000, 60_000).decision, "wait");
});

test("evaluateCiRun fails once an in-progress run exceeds the timeout", () => {
  const run = { status: "in_progress", conclusion: null, url: "https://example.com/run/1" };
  const result = evaluateCiRun(run, 60_000, 60_000);
  assert.equal(result.decision, "fail");
  assert.match((result as { reason: string }).reason, /still in_progress/);
});

test("evaluateCiRun fails on a completed failure regardless of elapsed time", () => {
  const run = { status: "completed", conclusion: "failure", url: "https://example.com/run/1" };
  const result = evaluateCiRun(run, 0, 60_000);
  assert.equal(result.decision, "fail");
  assert.match((result as { reason: string }).reason, /CI failed/);
});

test("evaluateCiRun proceeds on a completed non-failure conclusion", () => {
  const run = { status: "completed", conclusion: "success", url: "https://example.com/run/1" };
  assert.equal(evaluateCiRun(run, 0, 60_000).decision, "proceed");
});

// the stage's own timestamp is the clock for every timeout, so a
// poller restart does not hand a wedged stage a fresh budget.
test("stageElapsedMs measures from the stage's own timestamp", () => {
  const now = Date.parse("2026-09-17T12:10:00.000Z");
  assert.equal(stageElapsedMs("2026-09-17T12:00:00.000Z", now), 10 * 60 * 1000);
});

test("stageElapsedMs treats a missing or unparseable timestamp as just entered", () => {
  assert.equal(stageElapsedMs(null, Date.now()), 0);
  assert.equal(stageElapsedMs("not a date", Date.now()), 0);
});

test("stageElapsedMs never returns a negative elapsed time for a clock skew", () => {
  const now = Date.parse("2026-09-17T12:00:00.000Z");
  assert.equal(stageElapsedMs("2026-09-17T12:05:00.000Z", now), 0);
});

// #61's item 2: a diff touching a drizzle migration holds for a human before
// merge, because a bad migration against a live database is far costlier to
// unwind than a bad UI change.
test("touchesMigration recognises a drizzle migration anywhere in the repo", () => {
  assert.equal(touchesMigration(["app/drizzle/0007_add_pipeline_columns.sql"]), true);
  assert.equal(touchesMigration(["drizzle/0001_init.sql"]), true);
});

test("touchesMigration ignores drizzle's own metadata and ordinary sql", () => {
  assert.equal(touchesMigration(["app/drizzle/meta/_journal.json", "app/src/routes.ts"]), false);
  assert.equal(touchesMigration(["scripts/seed.sql"]), false);
  assert.equal(touchesMigration([]), false);
});

// a healthy deploy closes an agent task; anything else goes to review.
test("decideAfterVerify closes an agent task after a healthy deploy", () => {
  const decision = decideAfterVerify("agent", ["glance", "keep"]);
  assert.equal(decision.to, "done");
  assert.equal(decision.note, "Deployed and healthy: glance, keep. Closed automatically (executor agent).");
});

test("decideAfterVerify sends human+agent and human tasks to review", () => {
  for (const mode of ["human+agent", "human", undefined]) {
    const decision = decideAfterVerify(mode, ["glance"]);
    assert.equal(decision.to, "review");
    assert.equal(decision.note, "Deployed and healthy: glance. Ready for review.");
  }
});

// The whole post-CI policy in one place: the auto-deploy opt-in, the
// production guard, the migration hold.
test("decideAfterCi leaves a project without auto-deploy for a human to merge", () => {
  const decision = decideAfterCi({ autoDeployAllowed: false, localPath: "my-org/keep", repoSlugs: ["keep"], holdRepos: [] });
  assert.equal(decision.to, "review");
  assert.match(decision.note, /Auto-deploy is not enabled/);
});

test("decideAfterCi refuses to merge production even with auto-deploy on", () => {
  const decision = decideAfterCi({ autoDeployAllowed: true, localPath: "my-org/production", repoSlugs: ["production"], holdRepos: [] });
  assert.equal(decision.to, "review");
  assert.match(decision.note, /production is never eligible/);
});

test("decideAfterCi holds a migration diff for a human before merge", () => {
  const decision = decideAfterCi({ autoDeployAllowed: true, localPath: "my-org/pinboard", repoSlugs: ["pinboard"], holdRepos: ["pinboard"] });
  assert.equal(decision.to, "awaiting_review");
  assert.match(decision.note, /migration/);
});

test("decideAfterCi merges an ordinary green diff on an auto-deploy project", () => {
  const decision = decideAfterCi({ autoDeployAllowed: true, localPath: "my-org/glance", repoSlugs: ["glance"], holdRepos: [] });
  assert.equal(decision.to, "awaiting_merge");
});

// One task can land changes across several repos, each with its own PR on the
// same branch - and the pipeline follows a PR through being merged, so the
// set is filtered by branch rather than by state.
test("pipelineRepos collects every repo with a PR on this attempt's branch", () => {
  const prs = [
    { id: 11, url: "https://github.com/my-org/pinboard/pull/1", repoSlug: "pinboard", branchName: "task-160", state: "merged" },
    { id: 12, url: "https://github.com/my-org/foreman/pull/2", repoSlug: "foreman", branchName: "task-160", state: "open" },
    { id: 13, url: "https://github.com/my-org/foreman/pull/0", repoSlug: "foreman", branchName: "task-99", state: "open" },
  ] as PullRequest[];
  assert.deepEqual(pipelineRepos(prs, "task-160"), [
    { repoSlug: "pinboard", prUrl: "https://github.com/my-org/pinboard/pull/1", prId: 11 },
    { repoSlug: "foreman", prUrl: "https://github.com/my-org/foreman/pull/2", prId: 12 },
  ]);
});

// listPullRequests returns newest first, so "first" is the PR this attempt
// just opened - which matters after a a past task deploy_failed handback, where
// the repo has an older merged PR on the same branch as well.
test("pipelineRepos keeps only the first PR per repo", () => {
  const prs = [
    { id: 9, url: "https://github.com/my-org/glance/pull/9", repoSlug: "glance", branchName: "task-7", state: "open" },
    { id: 8, url: "https://github.com/my-org/glance/pull/8", repoSlug: "glance", branchName: "task-7", state: "closed" },
  ] as PullRequest[];
  assert.deepEqual(pipelineRepos(prs, "task-7"), [
    { repoSlug: "glance", prUrl: "https://github.com/my-org/glance/pull/9", prId: 9 },
  ]);
});

// which failures are worth an agent run and which the poller
// clears (or waits out) itself.
test("decideMergeFailure rebases inside the window and only then hands back", () => {
  assert.equal(decideMergeFailure(0, 300_000), "rebase");
  assert.equal(decideMergeFailure(299_000, 300_000), "rebase");
  assert.equal(decideMergeFailure(300_000, 300_000), "handback");
});

test("decideHealthcheckFailure retries a just-deployed service before calling the deploy failed", () => {
  assert.equal(decideHealthcheckFailure(0, 300_000), "retry");
  assert.equal(decideHealthcheckFailure(120_000, 300_000), "retry");
  assert.equal(decideHealthcheckFailure(300_000, 300_000), "handback");
});

// deploy targets come from a declaration, not a README grep. An
// empty step list (homelab-kit, cue) is "nothing to deploy", not a failure;
// a missing or broken declaration is reported so the pipeline parks.
test("healthcheckCommand passes the app name only for app steps", () => {
  assert.equal(healthcheckCommand({ type: "lxc", host: "glance" }), "cd /app && ./scripts/healthcheck.sh");
  assert.equal(healthcheckCommand({ type: "app", host: "sandbox", app: "my-moments" }), "cd /app && ./scripts/healthcheck.sh my-moments");
});

test("deployStepsFor reads .homelab/deploy.json and homelab/targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-deploy-target-"));
  const declare = (path: string, doc: unknown) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof doc === "string" ? doc : JSON.stringify(doc));
  };
  try {
    declare("glance/.homelab/deploy.json", { version: 1, steps: [{ type: "lxc", host: "glance" }] });
    assert.deepEqual(deployStepsFor("glance", dir), { ok: true, steps: [{ type: "lxc", host: "glance" }] });

    declare("homelab-kit/.homelab/deploy.json", { version: 1, note: "npm package", steps: [] });
    assert.deepEqual(deployStepsFor("homelab-kit", dir), { ok: true, steps: [] });

    // uncik-projects repos are declared on the homelab side, and that wins.
    declare("homelab/targets/my-moments.json", { version: 1, steps: [{ type: "app", host: "sandbox", app: "my-moments" }] });
    declare("my-moments/.homelab/deploy.json", { version: 1, steps: [] });
    assert.deepEqual(deployStepsFor("my-moments", dir), { ok: true, steps: [{ type: "app", host: "sandbox", app: "my-moments" }] });
    // a release block is parsed but never becomes a step.
    const release = {
      host: "production",
      app: "my-moments",
      branch: "production",
      workflow: "release.yml",
      versionFiles: ["server/package.json", "pwa/package.json"],
      images: ["ghcr.io/uncik-projects/my-moments-server"],
      composeRepo: "production",
      composeFile: "projects/my-moments/docker-compose.yml",
    };
    declare("homelab/targets/released.json", { version: 1, steps: [{ type: "app", host: "sandbox", app: "released" }], release });
    assert.deepEqual(deployStepsFor("released", dir), { ok: true, steps: [{ type: "app", host: "sandbox", app: "released" }], release });
    declare("homelab/targets/onlyrelease.json", { version: 1, steps: [], release });
    const onlyRelease = deployStepsFor("onlyrelease", dir);
    assert.ok(onlyRelease.ok && onlyRelease.steps.length === 0 && onlyRelease.release?.host === "production");
    for (const bad of [{ ...release, host: "prod; reboot" }, { ...release, composeFile: "../etc/passwd" }, { ...release, versionFiles: [] }, { ...release, images: "x" }, "yes"]) {
      declare("homelab/targets/badrelease.json", { version: 1, steps: [], release: bad });
      assert.equal(deployStepsFor("badrelease", dir).ok, false, JSON.stringify(bad));
    }
    declare("homelab/targets/prodstep.json", { version: 1, steps: [{ type: "app", host: "production", app: "prodstep" }] });
    assert.equal(deployStepsFor("prodstep", dir).ok, false);
    declare("noapp/.homelab/deploy.json", { version: 1, steps: [{ type: "app", host: "sandbox" }] });
    assert.equal(deployStepsFor("noapp", dir).ok, false);
    declare("badapp/.homelab/deploy.json", { version: 1, steps: [{ type: "app", host: "sandbox", app: "x && reboot" }] });
    assert.equal(deployStepsFor("badapp", dir).ok, false);

    assert.equal(deployStepsFor("no-such-repo", dir).ok, false);
    declare("broken/.homelab/deploy.json", "{not json");
    assert.equal(deployStepsFor("broken", dir).ok, false);
    declare("oldver/.homelab/deploy.json", { steps: [] });
    assert.equal(deployStepsFor("oldver", dir).ok, false);
    declare("badtype/.homelab/deploy.json", { version: 1, steps: [{ type: "docker" }] });
    assert.equal(deployStepsFor("badtype", dir).ok, false);
    // an npm step names a package, not a host.
    declare("kit/.homelab/deploy.json", { version: 1, steps: [{ type: "npm", package: "server-kit" }] });
    assert.deepEqual(deployStepsFor("kit", dir), { ok: true, steps: [{ type: "npm", package: "server-kit" }] });
    // a single-package repo.
    declare("kit/.homelab/deploy.json", { version: 1, steps: [{ type: "npm", package: "server-kit", root: true }, { type: "npm", package: "ui-kit", root: false }] });
    assert.deepEqual(deployStepsFor("kit", dir), { ok: true, steps: [{ type: "npm", package: "server-kit", root: true }, { type: "npm", package: "ui-kit" }] });
    for (const bad of [{ type: "npm" }, { type: "npm", package: "../x" }, { type: "npm", host: "server-kit" }, { type: "npm", package: "server-kit", root: "yes" }]) {
      declare("badnpm/.homelab/deploy.json", { version: 1, steps: [bad] });
      assert.equal(deployStepsFor("badnpm", dir).ok, false, JSON.stringify(bad));
    }
    declare("badhost/.homelab/deploy.json", { version: 1, steps: [{ type: "lxc", host: "a; rm -rf /" }] });
    assert.equal(deployStepsFor("badhost", dir).ok, false);

    const { deployable, undeclared } = classifyDeployTargets(
      [{ repoSlug: "glance" }, { repoSlug: "homelab-kit" }, { repoSlug: "onlyrelease" }, { repoSlug: "no-such-repo" }],
      dir,
    );
    // A repo whose only target is a release has nothing the pipeline deploys.
    assert.deepEqual(deployable, [{ repoSlug: "glance" }]);
    assert.equal(undeclared.length, 1);
    assert.match(undeclared[0], /no-such-repo has no deploy declaration/);

    // a library ("kit", npm step) listed last still deploys first.
    const ordered = classifyDeployTargets([{ repoSlug: "glance" }, { repoSlug: "kit" }], dir);
    assert.deepEqual(ordered.deployable, [{ repoSlug: "kit" }, { repoSlug: "glance" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// libraries (npm steps) deploy before their consumers, and the
// relative order of everything else is untouched.
test("orderLibrariesFirst moves npm-step repos first and keeps the rest in order", () => {
  const lxc = (host: string) => [{ type: "lxc" as const, host }];
  const npm = [{ type: "npm" as const, package: "server-kit" }];
  assert.deepEqual(
    orderLibrariesFirst([
      { repo: "pinboard", steps: lxc("pinboard") },
      { repo: "media", steps: lxc("media") },
      { repo: "homelab-kit", steps: npm },
    ]),
    ["homelab-kit", "pinboard", "media"],
  );
  assert.deepEqual(
    orderLibrariesFirst([
      { repo: "media", steps: lxc("media") },
      { repo: "glance", steps: lxc("glance") },
      { repo: "pinboard", steps: lxc("pinboard") },
    ]),
    ["media", "glance", "pinboard"],
  );
  assert.deepEqual(orderLibrariesFirst([]), []);
});

// the shared workspace clone is only fast-forwarded when that is
// safe - on its default branch and clean - never switched or reset.
test("refreshWorkspaceClone fast-forwards a clean default-branch clone and leaves others alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-refresh-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
  try {
    const upstream = join(dir, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    git(upstream, "commit", "-q", "--allow-empty", "-m", "one");
    const ws = join(dir, "ws");
    mkdirSync(ws);
    git(ws, "clone", "-q", upstream, "glance");
    const clone = join(ws, "glance");
    git(upstream, "commit", "-q", "--allow-empty", "-m", "two");

    assert.equal(refreshWorkspaceClone("glance", ws), null);
    assert.equal(git(clone, "log", "-1", "--format=%s"), "two");

    git(upstream, "commit", "-q", "--allow-empty", "-m", "three");
    writeFileSync(join(clone, "local.txt"), "uncommitted");
    assert.match(refreshWorkspaceClone("glance", ws) ?? "", /local changes/);
    assert.equal(git(clone, "log", "-1", "--format=%s"), "two");

    rmSync(join(clone, "local.txt"));
    git(clone, "checkout", "-q", "-b", "task-1");
    assert.match(refreshWorkspaceClone("glance", ws) ?? "", /on task-1, not main/);
    assert.equal(git(clone, "log", "-1", "--format=%s"), "two");

    assert.equal(refreshWorkspaceClone("not-cloned", ws), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `gh --repo` needs the PR's actual org, not always
// my-org - a uncik-projects repo like my-moments 404s otherwise.
test("repoOrgFor reads the org off the project's own localPath when there is no clone", () => {
  const noClones = join(tmpdir(), "foreman-no-clones-here");
  assert.equal(repoOrgFor("uncik-projects/my-moments", noClones), "uncik-projects");
  assert.equal(repoOrgFor("my-org/pinboard", noClones), "my-org");
});

test("repoOrgFor falls back to the workspace's default org when there is no localPath", () => {
  assert.equal(repoOrgFor(null, "/nowhere", "my-org"), "my-org");
});

// a repo transferred to rackmarten keeps its my-org/ clone.
test("repoOrgFor reads a moved repo's org from its workspace clone's origin", () => {
  const ws = mkdtempSync(join(tmpdir(), "foreman-org-"));
  try {
    for (const [name, url] of [
      ["homelab-kit", "git@github.com:rackmarten/homelab-kit.git"],
      ["pinboard", "https://github.com/rackmarten/pinboard"],
      ["glance", "git@github.com:my-org/glance.git"],
      ["local-only", "/srv/git/local-only.git"],
    ]) {
      const dir = join(ws, "my-org", name);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    }
    assert.equal(repoOrgFor("my-org/homelab-kit", ws), "rackmarten");
    assert.equal(repoOrgFor("my-org/pinboard", ws), "rackmarten");
    assert.equal(repoOrgFor("my-org/glance", ws), "my-org");
    assert.equal(repoOrgFor("my-org/local-only", ws), "my-org");
    assert.equal(repoOrgFor("my-org/not-cloned", ws), "my-org");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("githubOrgFromUrl reads ssh and https forms, with and without .git", () => {
  assert.equal(githubOrgFromUrl("git@github.com:rackmarten/homelab-kit.git"), "rackmarten");
  assert.equal(githubOrgFromUrl("git@github.com:rackmarten/homelab-kit"), "rackmarten");
  assert.equal(githubOrgFromUrl("https://github.com/rackmarten/homelab-kit"), "rackmarten");
  assert.equal(githubOrgFromUrl("https://github.com/rackmarten/homelab-kit.git"), "rackmarten");
  assert.equal(githubOrgFromUrl("https://gitlab.com/rackmarten/homelab-kit.git"), null);
  assert.equal(githubOrgFromUrl("git@github.com:only-org"), null);
});

test("truncateLog keeps the tail of an oversized log and says so", () => {
  const log = "x".repeat(50);
  assert.equal(truncateLog(log, 100), log);
  const truncated = truncateLog(log, 10);
  assert.match(truncated, /^…\(truncated\)\n/);
  assert.equal(truncated.endsWith("x".repeat(10)), true);
});

// Deploying pinboard restarts the API the poller reports back to - a call
// landing in that window must not strand a task in the stage it just left.
test("withRetry returns the first successful result without retrying", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  }, 4, 0);
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries a failing call and returns once it succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return "ok";
  }, 4, 0);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry throws the last error once attempts are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error(`fail ${calls}`);
    }, 3, 0),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test("an autonomous task's failure goes back to an agent", () => {
  const out = routeHandback(
    { moved: "queued", note: "deploy failed for glance", comment: "boom", repair: { reason: "deploy_failed", context: "ctx" } },
    "agent",
  );
  assert.equal(out.moved, "queued");
  assert.deepEqual(out.repair, { reason: "deploy_failed", context: "ctx" });
  assert.match(out.comment ?? "", /^boom\n\nHanded back to an agent/);
});

test("a human+agent task's failure parks in rework with its evidence", () => {
  const out = routeHandback(
    { moved: "queued", note: "CI failed for glance", comment: "red", repair: { reason: "ci_failed", context: "log" } },
    "human+agent",
  );
  assert.equal(out.moved, "rework");
  assert.deepEqual(out.repair, { reason: "ci_failed", context: "log" });
  assert.match(out.comment ?? "", /Parked in `rework`/);
  assert.match(out.comment ?? "", /human\+agent/);
});

test("a pinboard that sends no executorMode parks rather than risk two agents", () => {
  const out = routeHandback({ moved: "queued", note: "x", repair: { reason: "ci_failed", context: "" } }, undefined);
  assert.equal(out.moved, "rework");
});

test("outcomes that are not handbacks pass through untouched", () => {
  const park = { moved: "rework", note: "no PR", comment: "left for a human" };
  assert.equal(routeHandback(park, "human+agent"), park);
  const advance = { moved: "verifying", note: "deployed" };
  assert.equal(routeHandback(advance, "agent"), advance);
});

// ---------------------------------------------------------------------------
// CI failure evidence, repeat handbacks, red main
// ---------------------------------------------------------------------------

// A fake `gh`: each entry is matched against the joined argv, first hit wins.
function fakeGh(routes: Array<[RegExp, string]>): Exec & { calls: string[] } {
  const calls: string[] = [];
  const exec = ((cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = routes.find(([pattern]) => pattern.test(line));
    return hit ? { ok: true, stdout: hit[1], stderr: "" } : { ok: false, stdout: "", stderr: `unexpected: ${line}` };
  }) as Exec & { calls: string[] };
  exec.calls = calls;
  return exec;
}

const JOBS = JSON.stringify({
  jobs: [
    { databaseId: 11, name: "security / gitleaks", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Run gitleaks", conclusion: "failure" }] },
    { databaseId: 12, name: "security / shellcheck", conclusion: "success", steps: [] },
  ],
});

const JOB_LOG = [
  "2026-09-28T10:00:00Z ##[group]Run actions/checkout@v4",
  "2026-09-28T10:00:01Z checked out",
  "2026-09-28T10:00:02Z ##[endgroup]",
  "2026-09-28T10:00:03Z ##[group]Run gitleaks detect",
  "2026-09-28T10:00:04Z leak found in foo.env",
  "2026-09-28T10:00:05Z ##[error]Process completed with exit code 1.",
  "2026-09-28T10:00:06Z Post job cleanup.",
].join("\n");

test("extractFailingSection keeps the failing step's group through its error", () => {
  const section = extractFailingSection(JOB_LOG);
  assert.match(section, /^.*##\[group\]Run gitleaks detect/);
  assert.match(section, /leak found/);
  assert.match(section, /##\[error\]/);
  assert.doesNotMatch(section, /checked out|Post job cleanup/);
  assert.equal(extractFailingSection("no markers here"), "no markers here");
});

test("an empty --log-failed falls back to the failed job's raw log", () => {
  const gh = fakeGh([
    [/run list .*--branch task-1/, JSON.stringify([{ databaseId: 99, headSha: "abc", url: "https://gh/run/99" }])],
    [/run view 99 .*--json jobs/, JOBS],
    [/run view 99 .*--log-failed/, ""],
    [/api repos\/my-org\/foo\/actions\/jobs\/11\/logs/, JOB_LOG],
  ]);
  const failure = fetchCiFailure("my-org", "foo", "task-1", gh);
  assert.equal(failure.runId, 99);
  assert.equal(failure.headSha, "abc");
  assert.deepEqual(failure.failingSteps, ["Run gitleaks"]);
  assert.match(failure.log, /^Failing steps: security \/ gitleaks \/ Run gitleaks/);
  assert.match(failure.log, /leak found in foo\.env/);
  assert.doesNotMatch(failure.log, /checked out/);
  // only the failed job's log is fetched
  assert.ok(!gh.calls.some((call) => call.includes("/jobs/12/")));
});

test("says so explicitly when no log could be fetched at all", () => {
  const gh = fakeGh([
    [/run list/, JSON.stringify([{ databaseId: 99, headSha: "abc", url: "https://gh/run/99" }])],
    [/--json jobs/, JOBS],
    [/--log-failed/, ""],
    [/actions\/jobs\/11\/logs/, "   "],
  ]);
  assert.match(fetchCiFailure("my-org", "foo", "task-1", gh).log, /no log output could be fetched for run 99, open https:\/\/gh\/run\/99/);
});

function failure(overrides: Partial<CiFailure> = {}): CiFailure {
  return { runId: 99, headSha: "abc", url: "https://gh/run/99", failingStepLabels: ["j / Run gitleaks"], failingSteps: ["Run gitleaks"], log: "the log", ...overrides };
}
const ciInput = { repoSlug: "foo", prUrl: "https://gh/pr/1", branch: "task-1", reason: "CI failed" };

test("a ci_failed handback records the run id, and the same run failing again parks", () => {
  const first = decideCiFailure({ ...ciInput, failure: failure(), previousRunId: null, redMain: null });
  assert.equal(first.moved, "queued");
  assert.equal(first.repair?.reason, "ci_failed");
  assert.match(first.comment ?? "", /Failed CI run: foo 99 \(head abc\)/);
  assert.match(first.repair?.context ?? "", /Failed CI run: foo 99/);

  const comments = [{ authorName: "foreman-pipeline", body: first.comment ?? "" }];
  assert.equal(previousFailedRunId(comments, "foo"), 99);
  assert.equal(previousFailedRunId(comments, "bar"), null);

  const again = decideCiFailure({ ...ciInput, failure: failure(), previousRunId: previousFailedRunId(comments, "foo"), redMain: null });
  assert.equal(again.moved, "rework");
  assert.equal(again.repair, undefined);
  assert.match(again.comment ?? "", /same run that failed.*no new commits were pushed/s);

  const newPush = decideCiFailure({ ...ciInput, failure: failure({ runId: 100 }), previousRunId: 99, redMain: null });
  assert.equal(newPush.moved, "queued");
});

// 8s after a push the branch's newest run was still the previous
// attempt's red one, and the task parked as "no new commits were pushed".
const OLD_RED = { databaseId: 99, headSha: "old", status: "completed", conclusion: "failure", url: "https://gh/run/99" };

test("an older failed run plus a newer head SHA waits instead of parking", () => {
  const gh = fakeGh([
    [/api repos\/my-org\/foo\/commits\/task-1/, "new\n"],
    [/run list .*--branch task-1/, JSON.stringify([OLD_RED])],
  ]);
  const headSha = fetchBranchHeadSha("my-org", "foo", "task-1", gh);
  assert.equal(headSha, "new");
  const ciRun = fetchLatestCiRun("my-org", "foo", "task-1", headSha, gh);
  assert.equal(ciRun, null);
  assert.equal(evaluateCiRun(ciRun, 8_000, 60_000, 30_000).decision, "wait");
});

test("a failure on the current head SHA still hands back", () => {
  const newRed = { ...OLD_RED, databaseId: 100, headSha: "new", url: "https://gh/run/100" };
  const gh = fakeGh([
    [/run list .*--branch task-1/, JSON.stringify([newRed, OLD_RED])],
    [/run view 100 .*--json jobs/, JOBS],
    [/run view 100 .*--log-failed/, "boom"],
  ]);
  const ciRun = fetchLatestCiRun("my-org", "foo", "task-1", "new", gh);
  assert.equal(ciRun?.databaseId, 100);
  assert.equal(evaluateCiRun(ciRun, 8_000, 60_000, 30_000).decision, "fail");
  const failed = fetchCiFailure("my-org", "foo", "task-1", gh, "new");
  assert.equal(failed.runId, 100);
  assert.equal(failed.headSha, "new");
  assert.equal(decideCiFailure({ ...ciInput, failure: failed, previousRunId: 99, redMain: null }).moved, "queued");
});

test("the same head SHA as the last failure still parks", () => {
  const gh = fakeGh([
    [/run list .*--branch task-1/, JSON.stringify([OLD_RED])],
    [/run view 99 .*--json jobs/, JOBS],
    [/run view 99 .*--log-failed/, "boom"],
  ]);
  assert.equal(fetchLatestCiRun("my-org", "foo", "task-1", "old", gh)?.databaseId, 99);
  const failed = fetchCiFailure("my-org", "foo", "task-1", gh, "old");
  const outcome = decideCiFailure({ ...ciInput, failure: failed, previousRunId: 99, redMain: null });
  assert.equal(outcome.moved, "rework");
  assert.match(outcome.comment ?? "", /same run that failed/);
});

test("fetchCiFailure with a head SHA that has no run yet reads nothing older", () => {
  const gh = fakeGh([[/run list/, JSON.stringify([OLD_RED])]]);
  const failed = fetchCiFailure("my-org", "foo", "task-1", gh, "new");
  assert.equal(failed.runId, null);
  assert.match(failed.log, /no CI run found .* for new/);
});

test("previousFailedRunId ignores markers not written by the pipeline", () => {
  assert.equal(previousFailedRunId([{ authorName: "someone", body: failedRunMarker("foo", 5, null) }], "foo"), null);
});

test("red main failing the same step parks without spending an attempt", () => {
  const outcome = decideCiFailure({ ...ciInput, failure: failure(), previousRunId: null, redMain: { url: "https://gh/run/7", failingSteps: ["Run gitleaks"] } });
  // rework, not queued: nothing is dispatched, so attemptCount is untouched
  assert.equal(outcome.moved, "rework");
  assert.equal(outcome.repair, undefined);
  assert.match(outcome.comment ?? "", /main of foo is already failing Run gitleaks \(https:\/\/gh\/run\/7\); not caused by this task/);
  assert.equal(routeHandback(outcome, "agent"), outcome);
});

test("red main on a different step still hands back", () => {
  const outcome = decideCiFailure({ ...ciInput, failure: failure(), previousRunId: null, redMain: { url: "https://gh/run/7", failingSteps: ["Run shellcheck"] } });
  assert.equal(outcome.moved, "queued");
  assert.equal(outcome.repair?.reason, "ci_failed");
});

test("fetchRedMain reads the default branch's latest completed run", () => {
  const gh = fakeGh([
    [/repo view/, "trunk\n"],
    [/run list .*--branch trunk --status completed/, JSON.stringify([{ databaseId: 7, conclusion: "failure", url: "https://gh/run/7" }])],
    [/run view 7 .*--json jobs/, JOBS],
  ]);
  assert.deepEqual(fetchRedMain("my-org", "foo", gh), { url: "https://gh/run/7", failingSteps: ["Run gitleaks"] });
  const green = fakeGh([
    [/repo view/, "main"],
    [/run list/, JSON.stringify([{ databaseId: 8, conclusion: "success", url: "u" }])],
  ]);
  assert.equal(fetchRedMain("my-org", "foo", green), null);
});

test("orgForPr reads the org from the PR's own URL, not the task's project", () => {
  assert.equal(orgForPr("https://github.com/my-org/sandbox/pull/12", "uncik-projects/my-moments"), "my-org");
  assert.equal(orgForPr("https://github.com/uncik-projects/my-moments/pull/3", "my-org/sandbox"), "uncik-projects");
  assert.equal(orgForPr("not a url", "uncik-projects/my-moments"), "uncik-projects");
  assert.equal(orgForPr(null, null), repoOrgFor(null));
});

test("decideAfterMerge deploys regardless of how the task reached awaiting_merge", () => {
  const out = decideAfterMerge(["https://github.com/my-org/cue/pull/5"], ["cue"], { deployable: [{ repoSlug: "cue" }], undeclared: [] });
  assert.equal(out.moved, "deploying");
  assert.equal(decideAfterMerge([], ["cue"], { deployable: [], undeclared: [] }).moved, "review");
  assert.equal(decideAfterMerge([], ["cue"], { deployable: [], undeclared: ["cue: no declaration"] }).moved, "rework");
});

test("fetchCiFailure never returns an empty log: run URL plus job conclusions", () => {
  const exec = (_cmd: string, args: string[]) => {
    if (args[0] === "run" && args[1] === "list") return { ok: true, stdout: '[{"databaseId":36471847069,"url":"https://github.com/my-org/cue/actions/runs/36471847069"}]', stderr: "" };
    if (args.includes("--json")) return { ok: true, stdout: '{"jobs":[{"databaseId":9,"name":"security / gitleaks","conclusion":"failure","steps":[]},{"databaseId":10,"name":"lint","conclusion":"success"}]}', stderr: "" };
    // --log-failed and the jobs-logs API both come back blank.
    if (args[0] === "api") return { ok: true, stdout: "\n", stderr: "" };
    return { ok: true, stdout: "  \n", stderr: "" };
  };
  const failure = fetchCiFailure("my-org", "cue", "task-1", exec);
  assert.match(failure.log, /actions\/runs\/36471847069/);
  assert.match(failure.log, /security \/ gitleaks: failure/);
  assert.doesNotMatch(failure.log, /lint/);
});

test("decideCiFailure never posts an empty evidence block", () => {
  const out = decideCiFailure({
    repoSlug: "lxc-configurator",
    prUrl: "https://github.com/my-org/lxc-configurator/pull/2",
    branch: "task-1",
    reason: "CI failed",
    failure: { runId: 36436238048, headSha: null, url: null, failingStepLabels: [], failingSteps: [], log: "   " },
    previousRunId: null,
    redMain: null,
  });
  assert.match(out.comment ?? "", /output:\n\n\(no log output was captured, open https:\/\/github.com\/my-org\/lxc-configurator\/actions\)/);
});

// A past task
test("isPublicRepo: a rackmarten origin is public, my-org and no clone are not", () => {
  const ws = mkdtempSync(join(tmpdir(), "foreman-public-"));
  try {
    for (const [name, url] of [
      ["pinboard", "git@github.com:rackmarten/pinboard.git"],
      ["glance", "git@github.com:my-org/glance.git"],
    ]) {
      const dir = join(ws, "my-org", name);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    }
    const env = {};
    assert.equal(isPublicRepo("my-org/pinboard", ws, env), true);
    assert.equal(isPublicRepo("my-org/glance", ws, env), false);
    assert.equal(isPublicRepo("my-org/not-cloned", ws, env), false);
    assert.equal(isPublicRepo(null, ws, env), false);
    assert.equal(isPublicRepo("my-org/glance", ws, { PUBLIC_GITHUB_ORGS: "rackmarten, my-org" }), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("publicGithubOrgs defaults to rackmarten and an empty value means none", () => {
  assert.deepEqual(publicGithubOrgs({}), ["rackmarten"]);
  assert.deepEqual(publicGithubOrgs({ PUBLIC_GITHUB_ORGS: "" }), []);
});

test("squashMergeArgs: a public repo's subject drops the pinboard suffix, a private one keeps gh's default", () => {
  const url = "https://github.com/rackmarten/pinboard/pull/41";
  const pub = squashMergeArgs(url, "Fix the board (pinboard #594)");
  assert.deepEqual(pub, ["pr", "merge", url, "--squash", "--delete-branch", "--subject", "Fix the board (#41)"]);
  assert.doesNotMatch(pub.join(" "), /pinboard #|task [#0-9]|#594/);
  assert.deepEqual(squashMergeArgs(url, null), ["pr", "merge", url, "--squash", "--delete-branch"]);
});

// Docker Hub rate limit: retried in `deploying` instead of handed back.

test("isDockerHubRateLimited matches Docker Hub's rate-limit answers", () => {
  const samples = [
    "Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit",
    " postgres Error toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading: https://www.docker.com/increase-rate-limit",
    "failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/22-alpine: 429 Too Many Requests",
  ];
  for (const sample of samples) assert.equal(isDockerHubRateLimited(sample), true, sample);
});

test("isDockerHubRateLimited ignores other deploy failures", () => {
  const samples = [
    "Error response from daemon: manifest for postgres:99 not found: manifest unknown",
    "ssh: connect to host app-host port 22: Connection timed out",
    "healthcheck failed after 60s",
    "npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope",
    "",
  ];
  for (const sample of samples) assert.equal(isDockerHubRateLimited(sample), false, sample);
});

test("decideRateLimitRetry walks the backoff schedule, then gives up", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(decideRateLimitRetry(0, now), { retry: 1, nextAt: now + 30 * 60_000 });
  assert.deepEqual(decideRateLimitRetry(1, now), { retry: 2, nextAt: now + 60 * 60_000 });
  assert.deepEqual(decideRateLimitRetry(DEPLOY_RATE_LIMIT_BACKOFF_MS.length - 1, now)?.retry, DEPLOY_RATE_LIMIT_BACKOFF_MS.length);
  assert.equal(decideRateLimitRetry(DEPLOY_RATE_LIMIT_BACKOFF_MS.length, now), null);
});

test("rateLimitState reads the latest retry marker posted since the stage began", () => {
  const entered = "2026-01-01T10:00:00.000Z";
  const at = (iso: string, body: string, authorName = "foreman-pipeline") => ({ authorName, body, createdAt: iso });
  const first = Date.parse("2026-01-01T10:30:00.000Z");
  const second = Date.parse("2026-01-01T11:31:00.000Z");
  const comments = [
    at("2026-01-01T09:00:00.000Z", `old stage\n\n${rateLimitMarker(3, Date.parse("2026-01-01T09:30:00.000Z"))}`),
    at("2026-01-01T10:00:05.000Z", `x\n\n${rateLimitMarker(1, first)}\n\nlog`),
    at("2026-01-01T10:31:00.000Z", rateLimitMarker(2, second)),
    at("2026-01-01T10:40:00.000Z", rateLimitMarker(3, second + 1), "someone-else"),
  ];
  assert.deepEqual(rateLimitState(comments, entered), { retries: 2, nextAt: second });
  assert.deepEqual(rateLimitState([], entered), { retries: 0, nextAt: null });
});

function failingDeploy(stderr: string): DeploySequenceDeps {
  return {
    deploy: async () => ({ ran: true, value: { ok: false, stdout: "", stderr } }),
    isSecretStore: () => false,
    keyringHosts: () => [],
    syncHosts: () => ({ ok: true, detail: "" }),
  };
}

test("a rate-limited deploy stays in deploying with a retry comment, until the schedule runs out", async () => {
  const repo = [{ repoSlug: "app", prUrl: "https://github.com/x/app/pull/1", prId: 1 }];
  const deps = failingDeploy("toomanyrequests: You have reached your unauthenticated pull rate limit.");
  const now = Date.parse("2026-01-01T10:00:00.000Z");

  const waiting = await runDeploySequence(repo, 0, deps, { retries: 0, now });
  assert.equal(waiting.moved, null);
  assert.equal(waiting.repair, undefined);
  assert.match(waiting.comment ?? "", /rate limit/);
  assert.deepEqual(rateLimitState([{ authorName: "foreman-pipeline", body: waiting.comment ?? "", createdAt: "2026-01-01T10:00:01.000Z" }], null), {
    retries: 1,
    nextAt: now + DEPLOY_RATE_LIMIT_BACKOFF_MS[0],
  });

  const exhausted = await runDeploySequence(repo, 0, deps, { retries: DEPLOY_RATE_LIMIT_BACKOFF_MS.length, now });
  assert.equal(exhausted.moved, "queued");
  assert.equal(exhausted.repair?.reason, "deploy_failed");
  assert.match(exhausted.comment ?? "", /still rate-limited/);
});

test("a deploy failing for any other reason is still handed back at once", async () => {
  const repo = [{ repoSlug: "app", prUrl: "https://github.com/x/app/pull/1", prId: 1 }];
  const outcome = await runDeploySequence(repo, 0, failingDeploy("manifest unknown"), { retries: 0, now: 0 });
  assert.equal(outcome.moved, "queued");
  assert.doesNotMatch(outcome.comment ?? "", /rate-limited/);
});
