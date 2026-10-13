import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRootCall,
  detachedCommand,
  resolveTaskId,
  ROOT_JOB_RUNNING,
  ROOTPROXY_REFUSED,
  rootWaitActive,
  rootWaitMarkerPath,
  runRoot,
  waitCommand,
  type RootDeps,
} from "./root.js";
import { rootAccessLines } from "./runner.js";
import type { RootGrant, TaskDetail } from "./pinboard.js";

const NOW = new Date("2026-09-22T12:00:00Z");

function grant(overrides: Partial<RootGrant> = {}): RootGrant {
  return {
    taskId: 206,
    active: true,
    ctids: [102],
    expiresAt: "2026-09-22T16:00:00Z",
    grantedAt: "2026-09-22T11:00:00Z",
    grantedBy: "operator",
    ...overrides,
  };
}

function deps(opts: { labels?: string[]; grant?: RootGrant; sshCode?: number; pinboardDown?: boolean } = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const d: RootDeps = {
    getTask: async (id) => {
      if (opts.pinboardDown) throw new Error("fetch failed");
      return { id, labels: (opts.labels ?? ["root-access"]).map((name, i) => ({ id: i, name, color: null })) } as TaskDetail;
    },
    getRootGrant: async () => {
      if (opts.pinboardDown) throw new Error("fetch failed");
      return opts.grant ?? grant();
    },
    ssh: async (args) => {
      calls.push(args);
      return opts.sshCode ?? 0;
    },
    now: () => NOW,
    newJobId: () => "j1",
    markWaiting: () => () => {},
    log: (m) => logs.push(m),
  };
  return { d, calls, logs };
}

test("resolveTaskId prefers WORK_TASK_ID", () => {
  assert.equal(resolveTaskId({ WORK_TASK_ID: "206" }, "/somewhere", "/app/tasks"), 206);
});

test("resolveTaskId falls back to the task workdir when sudo dropped the env", () => {
  assert.equal(resolveTaskId({}, "/app/tasks/task-206/repos/sandbox", "/app/tasks"), 206);
  assert.equal(resolveTaskId({}, "/app/tasks/task-206", "/app/tasks"), 206);
});

test("resolveTaskId returns null outside a task run or for a malformed id", () => {
  assert.equal(resolveTaskId({}, "/home/marek", "/app/tasks"), null);
  assert.equal(resolveTaskId({}, "/app/tasks", "/app/tasks"), null);
  assert.equal(resolveTaskId({ WORK_TASK_ID: "206; rm" }, "/app/tasks/task-1", "/app/tasks"), null);
});

test("an allowed call becomes the proxy's ssh command line", async () => {
  const { d } = deps();
  const r = await checkRootCall(206, ["status", "102"], d);
  assert.deepEqual(r, {
    ok: true,
    taskId: 206,
    jobId: undefined,
    sshArgs: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "root@homelab", "206", "status", "102"],
  });
});

test("exec passes its command as one string", async () => {
  const { d } = deps();
  const r = await checkRootCall(206, ["exec", "102", "apt-get", "update", "&&", "apt-get -y upgrade"], d);
  assert.ok(r.ok);
  assert.deepEqual(r.sshArgs.slice(-4), ["206", "exec", "102", "apt-get update && apt-get -y upgrade"]);
});

test("set checks the key against the proxy's list", async () => {
  const { d } = deps();
  assert.ok((await checkRootCall(206, ["set", "102", "memory", "4096"], d)).ok);
  const bad = await checkRootCall(206, ["set", "102", "rootfs", "local:8"], d);
  assert.ok(!bad.ok && /rootfs.*not allowed/.test(bad.error));
});

test("refuses verbs the proxy does not offer, before asking pinboard", async () => {
  const { d } = deps({ pinboardDown: true });
  const r = await checkRootCall(206, ["destroy", "102"], d);
  assert.ok(!r.ok && /verb 'destroy' is not allowed/.test(r.error));
});

test("refuses bad arguments", async () => {
  const { d } = deps();
  for (const args of [[], ["status"], ["status", "abc"], ["exec", "102"], ["status", "102", "extra"], ["set", "102", "memory"]]) {
    assert.equal((await checkRootCall(206, args, d)).ok, false, JSON.stringify(args));
  }
});

test("refuses outside a task run", async () => {
  const { d } = deps();
  const r = await checkRootCall(null, ["status", "102"], d);
  assert.ok(!r.ok && /only works inside a foreman agent run/.test(r.error));
});

test("refuses a task without the root-access label, even with a grant", async () => {
  const { d } = deps({ labels: ["infra"] });
  const r = await checkRootCall(206, ["status", "102"], d);
  assert.ok(!r.ok && /not labelled root-access/.test(r.error));
});

test("refuses when there is no grant", async () => {
  const { d } = deps({ grant: grant({ active: false, expiresAt: null, grantedAt: null, grantedBy: null }) });
  const r = await checkRootCall(206, ["status", "102"], d);
  assert.ok(!r.ok && /no active root grant/.test(r.error));
});

test("reports an expired grant as expired, not as missing", async () => {
  const { d } = deps({ grant: grant({ active: false, expiresAt: "2026-09-22T11:30:00Z" }) });
  const r = await checkRootCall(206, ["status", "102"], d);
  assert.ok(!r.ok && /expired at 2026-09-22T11:30:00Z/.test(r.error));
});

test("treats a grant past its expiry as expired even if pinboard still says active", async () => {
  const { d } = deps({ grant: grant({ active: true, expiresAt: "2026-09-22T11:59:59Z" }) });
  assert.equal((await checkRootCall(206, ["status", "102"], d)).ok, false);
});

test("refuses a CTID outside the grant", async () => {
  const { d } = deps();
  const r = await checkRootCall(206, ["status", "155"], d);
  assert.ok(!r.ok && /CTID 155 is not in task 206's grant \(in scope: 102\)/.test(r.error));
});

test("refuses when pinboard is unreachable", async () => {
  const { d } = deps({ pinboardDown: true });
  const r = await checkRootCall(206, ["status", "102"], d);
  assert.ok(!r.ok && /could not ask pinboard/.test(r.error));
});

test("runRoot does not ssh when refused locally", async () => {
  const { d, calls, logs } = deps({ labels: [] });
  assert.equal(await runRoot(["status", "102"], { WORK_TASK_ID: "206" }, "/", d), 2);
  assert.equal(calls.length, 0);
  assert.match(logs[0] as string, /refused/);
});

test("runRoot passes the proxy's exit code through and explains a refusal", async () => {
  const { d, calls, logs } = deps({ sshCode: ROOTPROXY_REFUSED });
  assert.equal(await runRoot(["status", "102"], { WORK_TASK_ID: "206", WORK_ROOT_HOST: "root@test" }, "/", d), ROOTPROXY_REFUSED);
  assert.equal(calls[0]?.[6], "root@test");
  assert.match(logs[0] as string, /rootproxy on the host refused/);
});

test("rootAccessLines is empty for a task without the label", () => {
  assert.deepEqual(rootAccessLines(1, ["infra"], grant()), []);
});

test("rootAccessLines names the CTIDs and expiry of an active grant", () => {
  const text = rootAccessLines(206, ["root-access"], grant({ ctids: [102, 116] })).join("\n");
  assert.match(text, /CTID\(s\) 102, 116/);
  assert.match(text, /expiring at 2026-09-22T16:00:00Z/);
  assert.match(text, /work root exec <ctid>/);
});

test("rootAccessLines says root will refuse when the grant is not active", () => {
  const text = rootAccessLines(206, ["root-access"], grant({ active: false })).join("\n");
  assert.match(text, /no active root grant/);
});

test("exec --detach wraps the command so it survives the connection", async () => {
  const { d } = deps();
  const r = await checkRootCall(206, ["exec", "--detach", "102", "apt-get -y full-upgrade"], { ...d, newJobId: () => "j1" });
  assert.ok(r.ok);
  assert.equal(r.jobId, "j1");
  const remote = r.sshArgs.at(-1) as string;
  assert.equal(r.sshArgs.at(-3), "exec");
  assert.match(remote, /^mkdir -p \/root\/rootjobs && nohup setsid sh -c /);
  assert.match(remote, /apt-get -y full-upgrade/);
  assert.match(remote, /> \/root\/rootjobs\/j1\.log 2>&1 < \/dev\/null &/);
});

test("wait becomes a blocking exec on the proxy and validates the job id", async () => {
  const { d } = deps();
  const r = await checkRootCall(206, ["wait", "102", "j1"], { ...d, waitSeconds: 10 });
  assert.ok(r.ok);
  assert.equal(r.sshArgs.at(-3), "exec");
  assert.match(r.sshArgs.at(-1) as string, /\$t -lt 10/);
  assert.equal((await checkRootCall(206, ["wait", "102", "j1;rm"], d)).ok, false);
  assert.equal((await checkRootCall(206, ["wait", "102"], d)).ok, false);
});

test("wait still needs the grant", async () => {
  const { d } = deps({ grant: grant({ active: false, expiresAt: "2026-09-22T11:00:00Z" }) });
  const r = await checkRootCall(206, ["wait", "102", "j1"], d);
  assert.ok(!r.ok && /expired/.test(r.error));
});

test("runRoot marks the task as waiting only for the duration of a wait", async () => {
  const { d, logs } = deps({ sshCode: ROOT_JOB_RUNNING });
  const marks: string[] = [];
  d.markWaiting = (id) => {
    marks.push(`on ${id}`);
    return () => marks.push(`off ${id}`);
  };
  assert.equal(await runRoot(["wait", "102", "j1"], { WORK_TASK_ID: "206" }, "/", d), ROOT_JOB_RUNNING);
  assert.deepEqual(marks, ["on 206", "off 206"]);
  assert.match(logs[0] as string, /still running - call `work root wait 102 j1` again/);
  await runRoot(["status", "102"], { WORK_TASK_ID: "206" }, "/", d);
  assert.equal(marks.length, 2);
});

test("the detached wrapper really records the exit code, even through set -e", () => {
  const dir = mkdtempSync(join(tmpdir(), "rootjob-"));
  const script = detachedCommand("j9", "set -e; echo out; false; echo never").replaceAll("/root/rootjobs", dir);
  execFileSync("sh", ["-c", script]);
  const rc = join(dir, "j9.rc");
  for (let i = 0; i < 50 && !existsSync(rc); i++) execFileSync("sleep", ["0.1"]);
  assert.equal(readFileSync(rc, "utf8").trim(), "1");
  assert.equal(readFileSync(join(dir, "j9.log"), "utf8").trim(), "out");
  const waited = spawnSync("sh", ["-c", waitCommand("j9", 5).replaceAll("/root/rootjobs", dir)], { encoding: "utf8" });
  assert.equal(waited.status, 1);
  assert.match(waited.stdout, /job j9 finished, exit 1/);
});

test("rootWaitActive trusts a marker only while its process lives", () => {
  const root = mkdtempSync(join(tmpdir(), "tasks-"));
  mkdirSync(join(root, "task-5"));
  assert.equal(rootWaitActive(5, root), false);
  writeFileSync(rootWaitMarkerPath(5, root), String(process.pid));
  assert.equal(rootWaitActive(5, root), true);
  writeFileSync(rootWaitMarkerPath(5, root), "999999999");
  assert.equal(rootWaitActive(5, root), false);
});
