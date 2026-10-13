import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpVersion,
  checkoutDir,
  deployedShaCommand,
  latestPackageTag,
  npmTagPrefix,
  imageTag,
  packageVersion,
  pendingFromCompare,
  runForCommit,
  setImageTags,
  setPackageVersion,
} from "./releases.js";

test("checkoutDir: /app for an LXC, the app's own clone on a shared LXC", () => {
  assert.equal(checkoutDir({ type: "lxc", host: "glance" }), "/app");
  assert.equal(checkoutDir({ type: "app", host: "sandbox", app: "my-moments" }), "/app/projects/my-moments");
  assert.match(deployedShaCommand({ type: "app", host: "sandbox", app: "my-moments" }), /git -C \/app\/projects\/my-moments rev-parse HEAD/);
});

test("pendingFromCompare: ahead lists commits newest first", () => {
  const r = pendingFromCompare({
    status: "ahead",
    ahead_by: 2,
    behind_by: 0,
    commits: [
      { sha: "a", message: "Old: first\n\nbody" },
      { sha: "b", message: "New: second" },
    ],
  });
  assert.deepEqual(r, {
    pendingCount: 2,
    pendingCommits: [
      { sha: "b", subject: "New: second" },
      { sha: "a", subject: "Old: first" },
    ],
    probeError: null,
  });
});

test("pendingFromCompare: identical is up to date", () => {
  assert.deepEqual(pendingFromCompare({ status: "identical", ahead_by: 0, behind_by: 0, commits: [] }), {
    pendingCount: 0,
    pendingCommits: [],
    probeError: null,
  });
});

test("pendingFromCompare: a host checkout off the default branch is flagged", () => {
  const r = pendingFromCompare({ status: "diverged", ahead_by: 1, behind_by: 3, commits: [{ sha: "c", message: "x" }] });
  assert.equal(r.pendingCount, 1);
  assert.match(r.probeError ?? "", /3 commit\(s\).*diverged/);
});

test("pendingFromCompare caps the list at 30", () => {
  const commits = Array.from({ length: 40 }, (_, i) => ({ sha: String(i), message: "m" }));
  const r = pendingFromCompare({ status: "ahead", ahead_by: 40, commits });
  assert.equal(r.pendingCount, 40);
  assert.equal(r.pendingCommits.length, 30);
  assert.equal(r.pendingCommits[0].sha, "39");
});

// the production release's pure steps.
test("bumpVersion: patch, minor, major", () => {
  assert.equal(bumpVersion("0.2.0", "patch"), "0.2.1");
  assert.equal(bumpVersion("0.2.9", "minor"), "0.3.0");
  assert.equal(bumpVersion("1.4.2", "major"), "2.0.0");
  assert.throws(() => bumpVersion("0.2.0-rc.1", "patch"), /not plain/);
});

test("setPackageVersion rewrites only the top-level version and keeps formatting", () => {
  const pkg = '{\n  "name": "pwa",\n  "private": true,\n  "version": "0.2.0",\n  "dependencies": {\n    "x": { "version": "0.2.0" }\n  }\n}\n';
  const next = setPackageVersion(pkg, "pwa/package.json", "0.2.1");
  assert.equal(packageVersion(next, "pwa/package.json"), "0.2.1");
  assert.equal(next, pkg.replace('"version": "0.2.0",', '"version": "0.2.1",'));
  assert.throws(() => packageVersion('{"name":"x"}', "x/package.json"), /no top-level/);
});

const COMPOSE = `services:
  server:
    image: ghcr.io/uncik-projects/my-moments-server:v0.2.0
    restart: unless-stopped
  pwa:
    image: ghcr.io/uncik-projects/my-moments-pwa:v0.2.0
  db:
    image: postgres:17-alpine
`;
const IMAGES = ["ghcr.io/uncik-projects/my-moments-server", "ghcr.io/uncik-projects/my-moments-pwa"];

test("imageTag reads the one tag the declared images share", () => {
  assert.deepEqual(imageTag(COMPOSE, IMAGES), { ok: true, tag: "v0.2.0" });
  const mixed = COMPOSE.replace("my-moments-pwa:v0.2.0", "my-moments-pwa:v0.1.0");
  assert.match((imageTag(mixed, IMAGES) as { error: string }).error, /different tags/);
  assert.match((imageTag(COMPOSE, ["ghcr.io/uncik-projects/other"]) as { error: string }).error, /no pinned/);
  // A prefix of an image name is not that image.
  assert.equal(imageTag(COMPOSE, ["ghcr.io/uncik-projects/my-moments"]).ok, false);
});

test("setImageTags bumps every declared image and nothing else", () => {
  const next = setImageTags(COMPOSE, IMAGES, "v0.2.1");
  assert.deepEqual(imageTag(next, IMAGES), { ok: true, tag: "v0.2.1" });
  assert.match(next, /postgres:17-alpine/);
  assert.equal(next.split("\n").length, COMPOSE.split("\n").length);
  assert.throws(() => setImageTags(COMPOSE, ["ghcr.io/x/y"], "v1"), /no pinned/);
});

test("runForCommit picks the run for the pushed commit", () => {
  const runs = [
    { databaseId: 2, status: "in_progress", conclusion: null, headSha: "bbb", url: "u2" },
    { databaseId: 1, status: "completed", conclusion: "success", headSha: "aaa", url: "u1" },
  ];
  assert.equal(runForCommit(runs, "aaa")?.databaseId, 1);
  assert.equal(runForCommit(runs, "ccc"), null);
});

test("latestPackageTag picks the highest version of that package only", () => {
  const refs = ["refs/tags/server-kit-v0.3.0", "refs/tags/server-kit-v0.10.1", "refs/tags/server-kit-v0.9.9", "refs/tags/ui-kit-v1.0.0", "refs/tags/server-kit-vnext"];
  assert.deepEqual(latestPackageTag("server-kit-v", refs), { tag: "server-kit-v0.10.1", version: "0.10.1" });
  assert.equal(latestPackageTag("ui-kit-v", ["refs/tags/v0.3.2"]), null);
});

// a single-package repo tags plain v<version>.
test("npmTagPrefix: <package>-v in a monorepo, v for a root package", () => {
  assert.equal(npmTagPrefix({ type: "npm", package: "server-kit" }), "server-kit-v");
  assert.equal(npmTagPrefix({ type: "npm", package: "server-kit", root: true }), "v");
  const refs = ["refs/tags/v0.9.0", "refs/tags/v0.10.0", "refs/tags/server-kit-v0.11.0"];
  assert.deepEqual(latestPackageTag("v", refs), { tag: "v0.10.0", version: "0.10.0" });
});
