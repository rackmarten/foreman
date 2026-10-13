// Notices when pinboard itself is down. Every other alert foreman raises goes
// through pinboard (health.ts), which is no use when pinboard is the thing
// that broke, so this one goes straight to ntfy.
//
// A probe counts as failing when either GET /health or GET /api/plan (a plain
// read that needs the database) does not answer 2xx. A failure that lasts
// PINBOARD_WATCHDOG_OUTAGE_MINUTES (default 10) without a single good probe in
// between is an outage: one ntfy alert, and one call of the repair hook if the
// bounds allow it (one run per outage, at most PINBOARD_WATCHDOG_MAX_RUNS_PER_DAY
// in a rolling 24h). The hook is a no-op for now; the watchdog only logs
// `repair would start`. When pinboard answers again after an outage, a second
// ntfy says so and a pending record is kept for turning into a pinboard task.
//
// State lives in a JSON file under HOME (so under /app/state in the
// container), so a restart neither forgets an outage in progress nor resets
// the daily run count.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;
// A gap this many intervals long between two probes means foreman itself was
// not running, so a failure streak from before the gap says nothing about
// whether pinboard was down the whole time.
const STALE_GAP_INTERVALS = 5;

export interface WatchdogConfig {
  baseUrl: string;
  intervalMs: number;
  outageMs: number;
  maxRunsPerDay: number;
  probeTimeoutMs: number;
  statePath: string;
  ntfy: { url: string; topic: string; token: string } | null;
}

export interface RecoveryRecord {
  startedAt: string;
  recoveredAt: string;
  minutes: number;
  repair: RepairDecision;
  lastError: string | null;
}

export type RepairDecision = "pending" | "started" | "bounded";

export interface WatchdogState {
  // Start of the current unbroken run of failed probes, null while healthy.
  failingSince: string | null;
  lastError: string | null;
  lastProbeAt: string | null;
  // Set once the failure has lasted the outage threshold.
  outageDeclaredAt: string | null;
  outageAlerted: boolean;
  repair: RepairDecision;
  // Repair runs started in the last 24h, oldest first.
  runs: string[];
  // Outages that ended and have not been written up as a pinboard task yet.
  pending: RecoveryRecord[];
}

export interface RepairContext {
  outageStartedAt: string;
  lastError: string | null;
}

export type RepairHook = (ctx: RepairContext) => void | Promise<void>;
export type Probe = () => Promise<string | null>;
export type Notifier = (title: string, message: string, priority?: number) => Promise<void>;

export interface WatchdogDeps {
  probe: Probe;
  notify: Notifier;
  repair: RepairHook;
  now: () => number;
  log: (message: string) => void;
}

export function emptyState(): WatchdogState {
  return {
    failingSince: null,
    lastError: null,
    lastProbeAt: null,
    outageDeclaredAt: null,
    outageAlerted: false,
    repair: "pending",
    runs: [],
    pending: [],
  };
}

export function loadState(path: string): WatchdogState {
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<WatchdogState>) };
  } catch {
    return emptyState();
  }
}

export function saveState(path: string, state: WatchdogState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function watchdogConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): WatchdogConfig {
  const tokenVar = env.PINBOARD_WATCHDOG_NTFY_TOKEN_VAR || "NTFY_TOKEN_PINBOARD";
  const ntfyUrl = env.NTFY_URL;
  const token = env[tokenVar];
  return {
    baseUrl: (env.PINBOARD_URL ?? "http://pinboard:8095").replace(/\/+$/, ""),
    intervalMs: positiveNumber(env.PINBOARD_WATCHDOG_INTERVAL_SECONDS, 30) * 1000,
    outageMs: positiveNumber(env.PINBOARD_WATCHDOG_OUTAGE_MINUTES, 10) * 60 * 1000,
    maxRunsPerDay: positiveNumber(env.PINBOARD_WATCHDOG_MAX_RUNS_PER_DAY, 2),
    probeTimeoutMs: 10_000,
    statePath: env.PINBOARD_WATCHDOG_STATE_FILE || join(home, ".foreman", "pinboard-watchdog.json"),
    ntfy:
      ntfyUrl && token
        ? { url: ntfyUrl.replace(/\/+$/, ""), topic: env.PINBOARD_WATCHDOG_NTFY_TOPIC || "pinboard", token }
        : null,
  };
}

// null when both endpoints answer 2xx, otherwise what went wrong.
export function httpProbe(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Probe {
  const check = async (path: string): Promise<string | null> => {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? null : `${path} answered ${res.status}`;
    } catch (err) {
      return `${path} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  return async () => {
    const results = await Promise.all([check("/health"), check("/api/plan")]);
    const errors = results.filter((r): r is string => r !== null);
    return errors.length > 0 ? errors.join("; ") : null;
  };
}

export function ntfyNotifier(
  ntfy: WatchdogConfig["ntfy"],
  log: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): Notifier {
  return async (title, message, priority = 3) => {
    if (!ntfy) {
      log(`pinboard-watchdog: (no ntfy configured) ${title}: ${message}`);
      return;
    }
    try {
      const res = await fetchImpl(`${ntfy.url}/${encodeURIComponent(ntfy.topic)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ntfy.token}`, Title: title, Priority: String(priority) },
        body: message,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    } catch (err) {
      log(`pinboard-watchdog: ntfy failed (${err instanceof Error ? err.message : String(err)}): ${title}: ${message}`);
      throw err;
    }
  };
}

// Filled in by the repair run; until then an outage only logs.
export const noopRepair: RepairHook = () => {};

export class PinboardWatchdog {
  private state: WatchdogState;
  private okSinceHeartbeat = 0;
  private lastHeartbeat: number;

  constructor(
    private readonly config: Pick<WatchdogConfig, "intervalMs" | "outageMs" | "maxRunsPerDay" | "statePath">,
    private readonly deps: WatchdogDeps,
  ) {
    this.state = loadState(config.statePath);
    this.lastHeartbeat = deps.now();
  }

  get snapshot(): WatchdogState {
    return structuredClone(this.state);
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    const error = await this.deps.probe();
    const s = this.state;

    if (s.failingSince && !s.outageDeclaredAt && s.lastProbeAt) {
      const gap = now - Date.parse(s.lastProbeAt);
      if (gap > this.config.intervalMs * STALE_GAP_INTERVALS) s.failingSince = null;
    }
    s.lastProbeAt = new Date(now).toISOString();

    if (error === null) await this.onHealthy(now);
    else await this.onFailing(now, error);
    this.save();
    this.heartbeat(now, error === null);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.deps.log(`pinboard-watchdog: tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(this.config.intervalMs, signal);
    }
  }

  private async onFailing(now: number, error: string): Promise<void> {
    const s = this.state;
    s.lastError = error;
    if (!s.failingSince) {
      s.failingSince = new Date(now).toISOString();
      this.deps.log(`pinboard-watchdog: pinboard health failing (${error})`);
    }
    const startedAt = Date.parse(s.failingSince);
    if (now - startedAt < this.config.outageMs) return;

    if (!s.outageDeclaredAt) {
      s.outageDeclaredAt = new Date(now).toISOString();
      this.deps.log(`pinboard-watchdog: outage declared, failing since ${s.failingSince}`);
      this.decideRepair(now);
    }
    if (!s.outageAlerted) {
      const minutes = Math.round((now - startedAt) / 60_000);
      const repair =
        s.repair === "started"
          ? "A repair run is starting."
          : `No repair run: ${this.config.maxRunsPerDay} already ran in the last 24h.`;
      try {
        await this.deps.notify("pinboard is down", `pinboard has failed its health check for ${minutes} min (${error}). ${repair}`, 5);
        s.outageAlerted = true;
      } catch {
        // Retried on the next failing probe.
      }
    }
  }

  private decideRepair(now: number): void {
    const s = this.state;
    s.runs = s.runs.filter((t) => now - Date.parse(t) < DAY_MS);
    if (s.runs.length >= this.config.maxRunsPerDay) {
      s.repair = "bounded";
      this.deps.log(`pinboard-watchdog: repair skipped, ${s.runs.length} run(s) in the last 24h`);
      return;
    }
    s.repair = "started";
    s.runs.push(new Date(now).toISOString());
    this.save();
    this.deps.log("pinboard-watchdog: repair would start");
    const ctx: RepairContext = { outageStartedAt: s.failingSince!, lastError: s.lastError };
    // Not awaited: a repair run can take far longer than a poll interval, and
    // the loop has to keep probing to notice the recovery.
    Promise.resolve()
      .then(() => this.deps.repair(ctx))
      .catch((err) => this.deps.log(`pinboard-watchdog: repair hook failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async onHealthy(now: number): Promise<void> {
    const s = this.state;
    if (!s.failingSince) return;
    const startedAt = Date.parse(s.failingSince);
    const minutes = Math.round((now - startedAt) / 60_000);
    if (s.outageDeclaredAt) {
      s.pending.push({
        startedAt: s.failingSince,
        recoveredAt: new Date(now).toISOString(),
        minutes,
        repair: s.repair,
        lastError: s.lastError,
      });
      this.deps.log(`pinboard-watchdog: pinboard is back after ${minutes} min`);
      try {
        await this.deps.notify("pinboard is back", `pinboard is back after ${minutes} min.`);
      } catch {
        // Logged by the notifier; the pending record keeps the outage on file.
      }
    } else {
      this.deps.log(`pinboard-watchdog: pinboard health ok again after ${Math.round((now - startedAt) / 1000)}s`);
    }
    s.failingSince = null;
    s.lastError = null;
    s.outageDeclaredAt = null;
    s.outageAlerted = false;
    s.repair = "pending";
  }

  // One line an hour while healthy, so the log shows the watchdog is alive.
  private heartbeat(now: number, ok: boolean): void {
    if (ok) this.okSinceHeartbeat++;
    if (now - this.lastHeartbeat < HEARTBEAT_MS) return;
    this.deps.log(`pinboard-watchdog: ${this.okSinceHeartbeat} healthy probe(s) in the last hour`);
    this.okSinceHeartbeat = 0;
    this.lastHeartbeat = now;
  }

  private save(): void {
    try {
      saveState(this.config.statePath, this.state);
    } catch (err) {
      this.deps.log(`pinboard-watchdog: could not save state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function startPinboardWatchdog(signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.PINBOARD_WATCHDOG === "off") {
    console.log("pinboard-watchdog: disabled (PINBOARD_WATCHDOG=off)");
    return Promise.resolve();
  }
  const config = watchdogConfig(env);
  const log = (message: string): void => console.log(message);
  const watchdog = new PinboardWatchdog(config, {
    probe: httpProbe(config.baseUrl, config.probeTimeoutMs),
    notify: ntfyNotifier(config.ntfy, log),
    repair: noopRepair,
    now: Date.now,
    log,
  });
  log(
    `pinboard-watchdog: polling ${config.baseUrl}/health and /api/plan every ${config.intervalMs / 1000}s, ` +
      `outage after ${config.outageMs / 60_000} min, ntfy ${config.ntfy ? `topic ${config.ntfy.topic}` : "not configured (log only)"}`,
  );
  return watchdog.run(signal);
}
