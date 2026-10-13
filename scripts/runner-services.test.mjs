// scripts/lib/runner-services.sh, the decisions deploy.sh makes
// about each runner service, driven with fixture process tables so the
// self-deploy detection is covered without docker, systemd or a live pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "lib", "runner-services.sh");

function sh(script, { stdin = "", env = {} } = {}) {
  const r = spawnSync("bash", ["-c", `source "${LIB}"; ${script}`], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

// The pipeline container mid self-deploy, as the host's `ps -eo pid=,ppid=,args=`
// shows it: docker-init (the container's pid 1) -> work -> deploy-service.sh
// foreman -> ssh back to the host. Plus an idle dispatch container and an
// unrelated host process.
const SELF_DEPLOY = `
    1     0 /sbin/init
  500     1 /usr/bin/containerd-shim-runc-v2 -namespace moby
  600   500 /sbin/docker-init -- work pipeline watch
  601   600 node /usr/local/bin/work pipeline watch
  700   601 bash /app/workspace/my-org/homelab/scripts/deploy-service.sh foreman
  701   700 ssh -o BatchMode=yes -o ConnectTimeout=5 marek@foreman cd /app && git pull && ./scripts/deploy.sh
  800   500 /sbin/docker-init -- work dispatch
  801   800 node /usr/local/bin/work dispatch
  900     1 bash /app/scripts/deploy.sh
`;

// Same pipeline, deploying a different repo.
const OTHER_DEPLOY = SELF_DEPLOY.replace("deploy-service.sh foreman", "deploy-service.sh glance");

test("container_main_pid finds work under docker-init", () => {
  assert.equal(sh("container_main_pid 600", { stdin: SELF_DEPLOY }).out, "601");
  assert.equal(sh("container_main_pid 800", { stdin: SELF_DEPLOY }).out, "801");
  assert.equal(sh("container_main_pid 999", { stdin: SELF_DEPLOY }).out, "");
});

test("tree_busy: a work process with a child is busy, one without is idle", () => {
  assert.equal(sh("tree_busy 601", { stdin: SELF_DEPLOY }).code, 0);
  assert.equal(sh("tree_busy 801", { stdin: SELF_DEPLOY }).code, 1);
});

test("descendants walks the whole tree, not just direct children", () => {
  assert.deepEqual(sh("descendants 600", { stdin: SELF_DEPLOY }).out.split("\n"), ["601", "700", "701"]);
});

test("tree_self_deploy: the pipeline deploying foreman is this deploy", () => {
  assert.equal(sh("tree_self_deploy 601 foreman", { stdin: SELF_DEPLOY }).code, 0);
});

test("tree_self_deploy: deploying another repo, or an idle service, is not", () => {
  assert.equal(sh("tree_self_deploy 601 foreman", { stdin: OTHER_DEPLOY }).code, 1);
  assert.equal(sh("tree_self_deploy 801 foreman", { stdin: SELF_DEPLOY }).code, 1);
  // A repo name that merely contains "foreman" is someone else's deploy.
  const lookalike = SELF_DEPLOY.replace("deploy-service.sh foreman", "deploy-service.sh foreman-docs");
  assert.equal(sh("tree_self_deploy 601 foreman", { stdin: lookalike }).code, 1);
});

test("tree_self_deploy: --release foreman counts, and the match is only inside the tree", () => {
  const release = SELF_DEPLOY.replace("deploy-service.sh foreman", "deploy-service.sh --release foreman");
  assert.equal(sh("tree_self_deploy 601 foreman", { stdin: release }).code, 0);
  // The same command outside the service's tree (an operator's shell) is not.
  const outside = SELF_DEPLOY.replace("  700   601", "  700     1");
  assert.equal(sh("tree_self_deploy 601 foreman", { stdin: outside }).code, 1);
});

test("tree_self_deploy: the legacy systemd unit's tree works the same way", () => {
  const legacy = `
  4242     1 /home/marek/.local-node/bin/node /home/marek/.local-node/bin/work pipeline watch
  4300  4242 bash /home/marek/projects/my-org/homelab/scripts/deploy-service.sh foreman
  4301  4300 ssh marek@foreman cd /app && git pull && ./scripts/deploy.sh
`;
  assert.equal(sh("tree_self_deploy 4242 foreman", { stdin: legacy }).code, 0);
  assert.equal(sh("tree_busy 4242", { stdin: legacy }).code, 0);
});

test("own_service: only inside a container, and only with FOREMAN_SERVICE", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-services-"));
  const marker = join(dir, ".dockerenv");
  writeFileSync(marker, "");
  const missing = join(dir, "absent");
  assert.equal(sh("own_service", { env: { FOREMAN_SERVICE: "pipeline", FOREMAN_CONTAINER_MARKER: marker } }).out, "pipeline");
  assert.equal(sh("own_service", { env: { FOREMAN_SERVICE: "pipeline", FOREMAN_CONTAINER_MARKER: missing } }).out, "");
  assert.equal(sh("own_service", { env: { FOREMAN_CONTAINER_MARKER: marker } }).out, "");
});

test("deploy_action: start, restart, defer for a self-deploy, skip when busy", () => {
  assert.equal(sh("deploy_action 0 0 0").out, "start");
  assert.equal(sh("deploy_action 1 0 0").out, "restart");
  // Idle wins over self: nothing is running this deploy if the tree is idle.
  assert.equal(sh("deploy_action 1 0 1").out, "restart");
  assert.equal(sh("deploy_action 1 1 1").out, "defer");
  assert.equal(sh("deploy_action 1 1 0").out, "skip");
});

test("legacy_unit names the systemd unit a service replaced", () => {
  assert.equal(sh("legacy_unit chat").out, "foreman-chat.service");
});
