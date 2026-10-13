// A past task: `work root <verb> <ctid> [args]`, an agent run's way
// to use rootproxy on the Proxmox host (homelab/rootproxy/rootproxy.sh) for
// its own task. The proxy is the real gate - it asks pinboard for the grant
// on every call and journals everything. This side refuses early, with a
// message the agent can act on, so a run that has no business with root
// never reaches the host at all.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getRootGrant, getTask, type RootGrant, type TaskDetail } from "./pinboard.js";
import { TASK_ROOT, parseTaskWorkdirName, taskWorkdir } from "./workdir.js";

export const ROOT_ACCESS_LABEL = "root-access";
// Must match rootproxy.sh's verbs and SET_KEYS.
export const ROOT_VERBS = ["status", "start", "shutdown", "reboot", "exec", "set"] as const;
// `wait` is ours, not the proxy's: it is an exec that blocks inside the
// container until a detached job (exec --detach) finishes.
const LOCAL_VERBS = ["wait"];
export const ROOT_SET_KEYS = ["memory", "swap", "cores", "cpulimit", "onboot", "startup", "features", "tags", "description"];
// rootproxy.sh exits with this on every refusal; ssh itself uses 255.
export const ROOTPROXY_REFUSED = 77;
const SSH_FAILED = 255;
// `work root wait` exits with this while the job is still running.
export const ROOT_JOB_RUNNING = 75;
// Just under the runner's 30-minute Bash timeout (BASH_MAX_TIMEOUT_MS), so a
// wait returns on its own rather than being killed by the tool.
export const ROOT_WAIT_SECONDS = 1740;
const JOB_DIR = "/root/rootjobs";

export const ROOT_USAGE =
  "usage: work root <status|start|shutdown|reboot> <ctid>\n" +
  "       work root exec <ctid> '<command>'\n" +
  "       work root exec --detach <ctid> '<command>'   (prints a job id; for anything slow)\n" +
  "       work root wait <ctid> <job-id>              (blocks until the job ends, up to ~29 min)\n" +
  `       work root set <ctid> <key> <value>   (key: ${ROOT_SET_KEYS.join(", ")})`;

export interface RootDeps {
  getTask(id: number): Promise<TaskDetail>;
  getRootGrant(id: number): Promise<RootGrant>;
  ssh(args: string[]): Promise<number>;
  // Marks this task's run as blocked on a root job while a wait is in
  // progress, so the runner's hard timeout pauses (see rootWaitActive).
  // Returns the function that clears the mark.
  markWaiting(taskId: number): () => void;
  now(): Date;
  newJobId(): string;
  log(message: string): void;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Runs the command under nohup/setsid inside the container, so it no longer
// depends on the ssh connection that started it: the router is known to kill
// long-lived connections, and apt killed halfway through is far worse than a
// wait call that has to be repeated. Output and exit code go to JOB_DIR.
export function detachedCommand(jobId: string, command: string): string {
  const f = `${JOB_DIR}/${jobId}`;
  return (
    // The command gets its own shell, so a `set -e` or `exit` in it cannot
    // skip writing the exit code.
    `mkdir -p ${JOB_DIR} && nohup setsid sh -c ${shQuote(`sh -c ${shQuote(command)}; echo $? > ${f}.rc`)} ` +
    `> ${f}.log 2>&1 < /dev/null & echo "started job ${jobId} (log ${f}.log)"`
  );
}

export function waitCommand(jobId: string, seconds: number): string {
  const f = `${JOB_DIR}/${jobId}`;
  return [
    `[ -f ${f}.log ] || { echo "no job ${jobId} in this container"; exit 2; }`,
    `t=0; while [ ! -f ${f}.rc ] && [ $t -lt ${seconds} ]; do sleep 5; t=$((t+5)); done`,
    `tail -n 60 ${f}.log`,
    `if [ -f ${f}.rc ]; then echo "job ${jobId} finished, exit $(cat ${f}.rc)"; exit $(cat ${f}.rc); fi`,
    `echo "job ${jobId} still running after ${seconds}s - call work root wait again"; exit ${ROOT_JOB_RUNNING}`,
  ].join("; ");
}

// The runner sets WORK_TASK_ID, but a run on another seat is spawned through
// `sudo -u`, whose env_reset drops it. That run's cwd is still inside its own
// task workdir (<TASK_ROOT>/task-<id>/...), so fall back to that.
export function resolveTaskId(env: NodeJS.ProcessEnv, cwd: string, root: string = TASK_ROOT): number | null {
  const fromEnv = env.WORK_TASK_ID?.trim();
  if (fromEnv) return /^\d+$/.test(fromEnv) ? Number(fromEnv) : null;
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..")) return null;
  return parseTaskWorkdirName(rel.split(sep)[0] as string);
}

export type RootCheck = { ok: true; sshArgs: string[]; taskId: number; jobId?: string } | { ok: false; error: string };

// Everything that can be decided before touching the host. `host` is the
// ssh destination whose forced command is rootproxy.
export async function checkRootCall(
  taskId: number | null,
  args: string[],
  deps: Pick<RootDeps, "getTask" | "getRootGrant" | "now"> & { newJobId(): string; waitSeconds?: number },
  host = "root@homelab",
): Promise<RootCheck> {
  if (taskId === null) {
    return {
      ok: false,
      error: "work root only works inside a foreman agent run for a root-access task (no WORK_TASK_ID, and the cwd is not a task workdir)",
    };
  }
  const [verb, ...afterVerb] = args;
  const detach = verb === "exec" && afterVerb[0] === "--detach";
  const [ctidRaw, ...rest] = detach ? afterVerb.slice(1) : afterVerb;
  if (!verb || !ctidRaw) return { ok: false, error: ROOT_USAGE };
  if (!(ROOT_VERBS as readonly string[]).includes(verb) && !LOCAL_VERBS.includes(verb)) {
    return {
      ok: false,
      error: `verb '${verb}' is not allowed (allowed: ${[...ROOT_VERBS, ...LOCAL_VERBS].join(", ")})\n${ROOT_USAGE}`,
    };
  }
  if (!/^\d+$/.test(ctidRaw)) return { ok: false, error: `ctid must be a number, got '${ctidRaw}'` };
  const ctid = Number(ctidRaw);

  let proxyVerb = verb;
  let remote: string[] = [];
  let jobId: string | undefined;
  if (verb === "exec") {
    const command = rest.join(" ").trim();
    if (!command) return { ok: false, error: `exec needs a command\n${ROOT_USAGE}` };
    // ssh joins its arguments with spaces anyway; one argument keeps it
    // obvious that the proxy receives the command as a single string.
    if (detach) {
      jobId = deps.newJobId();
      remote = [detachedCommand(jobId, command)];
    } else {
      remote = [command];
    }
  } else if (verb === "wait") {
    const [id, ...extra] = rest;
    if (!id || extra.length || !/^j\d+$/.test(id)) return { ok: false, error: `wait needs one job id (jNNN) from exec --detach\n${ROOT_USAGE}` };
    proxyVerb = "exec";
    jobId = id;
    remote = [waitCommand(id, deps.waitSeconds ?? ROOT_WAIT_SECONDS)];
  } else if (verb === "set") {
    const [key, value, ...extra] = rest;
    if (!key || value === undefined || extra.length) return { ok: false, error: `set needs exactly <key> <value>\n${ROOT_USAGE}` };
    if (!ROOT_SET_KEYS.includes(key)) return { ok: false, error: `set key '${key}' is not allowed (allowed: ${ROOT_SET_KEYS.join(", ")})` };
    remote = [key, value];
  } else if (rest.length) {
    return { ok: false, error: `${verb} takes no arguments after the ctid\n${ROOT_USAGE}` };
  }

  let task: TaskDetail;
  let grant: RootGrant;
  try {
    [task, grant] = await Promise.all([deps.getTask(taskId), deps.getRootGrant(taskId)]);
  } catch (err) {
    return { ok: false, error: `could not ask pinboard about task ${taskId}'s root grant: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!task.labels.some((l) => l.name === ROOT_ACCESS_LABEL)) {
    return { ok: false, error: `task ${taskId} is not labelled ${ROOT_ACCESS_LABEL}, so it has no root access` };
  }
  const expired = grant.expiresAt !== null && new Date(grant.expiresAt).getTime() <= deps.now().getTime();
  if (grant.grantedAt !== null && expired) {
    return {
      ok: false,
      error: `task ${taskId}'s root grant expired at ${grant.expiresAt}. Stop root work here and say so in your handoff; the operator has to requeue the task for a new grant`,
    };
  }
  if (!grant.active) {
    return {
      ok: false,
      error: `task ${taskId} has no active root grant (the operator grants one when queueing a root-access task)`,
    };
  }
  if (!grant.ctids.includes(ctid)) {
    return {
      ok: false,
      error: `CTID ${ctid} is not in task ${taskId}'s grant (in scope: ${grant.ctids.join(", ") || "none"})`,
    };
  }

  return {
    ok: true,
    taskId,
    jobId,
    sshArgs: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", host, String(taskId), proxyVerb, String(ctid), ...remote],
  };
}

export async function runRoot(args: string[], env: NodeJS.ProcessEnv, cwd: string, deps: RootDeps): Promise<number> {
  const host = env.WORK_ROOT_HOST || "root@homelab";
  const check = await checkRootCall(resolveTaskId(env, cwd), args, deps, host);
  if (!check.ok) {
    deps.log(`work root: refused: ${check.error}`);
    return 2;
  }
  const waiting = args[0] === "wait";
  const unmark = waiting ? deps.markWaiting(check.taskId) : () => {};
  let code: number;
  try {
    code = await deps.ssh(check.sshArgs);
  } finally {
    unmark();
  }
  if (code === ROOTPROXY_REFUSED) {
    deps.log("work root: rootproxy on the host refused the call (reason above); the refusal is logged on the task");
  } else if (code === SSH_FAILED) {
    deps.log(
      `work root: ssh to ${host} failed (exit 255) - the host may be unreachable or the key not authorized` +
        (waiting ? `. A detached job keeps running regardless; call \`work root wait\` again` : ""),
    );
  } else if (waiting && code === ROOT_JOB_RUNNING) {
    deps.log(`work root: job ${check.jobId} is still running - call \`work root wait ${args[1]} ${check.jobId}\` again`);
  }
  return code;
}

// Present while `work root wait` blocks for this task; holds the waiting
// process's pid so a marker left by a killed process is not trusted.
export function rootWaitMarkerPath(taskId: number, root: string = TASK_ROOT): string {
  return join(taskWorkdir(taskId, root), ".root-wait");
}

export function rootWaitActive(taskId: number, root: string = TASK_ROOT): boolean {
  const path = rootWaitMarkerPath(taskId, root);
  if (!existsSync(path)) return false;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but owned by the other seat's user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const defaultRootDeps: RootDeps = {
  getTask,
  getRootGrant,
  now: () => new Date(),
  newJobId: () => `j${Date.now()}`,
  markWaiting: (taskId) => {
    const path = rootWaitMarkerPath(taskId);
    try {
      writeFileSync(path, String(process.pid));
    } catch {
      return () => {};
    }
    return () => rmSync(path, { force: true });
  },
  log: (message) => console.error(message),
  ssh: (args) =>
    new Promise((resolve) => {
      const child = spawn("ssh", args, { stdio: "inherit" });
      child.on("error", () => resolve(SSH_FAILED));
      child.on("close", (code) => resolve(code ?? SSH_FAILED));
    }),
};
