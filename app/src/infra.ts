// infrastructure failures - the machine or the seat cannot run
// anything right now, whatever the task. Before this, each of them burned a
// task's attempts at $0 within seconds: #407/#408 spent all three on a full
// disk, #262 all three on an outdated claude CLI. None of them says anything
// about the task, so none of them may spend an attempt, and the dispatcher
// should stop feeding work into the same wall until someone (or time) fixes it.
import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { claudeBin } from "./spawn-env.js";

export type InfraCause = "disk_full" | "cli_outdated" | "auth";

// Real texts, as posted by the runner:
//   #407: could not prepare the task workdir: Command failed: git clone ...
//         fatal: could not create work tree dir '...': No space left on device
//   #262: session ended with is_error: API Error: 400 Claude Code 2.1.266 does
//         not support this model; version 2.1.280 or newer is required. Run
//         'claude update', or update the Claude desktop app, then try again.
// Disk is only matched on workdir preparation: an agent's own session can
// mention ENOSPC in its output without the runner being out of space.
const WORKDIR_PREP_PREFIX = "could not prepare the task workdir";
const DISK_FULL_PATTERN = /No space left on device|ENOSPC/i;
const CLI_OUTDATED_PATTERN = /does not support this model;\s*version\s+\S+\s+or newer is required|Run 'claude update'/i;
const AUTH_PATTERN =
  /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|invalid (?:bearer|access|oauth) token|token (?:has )?(?:expired|been revoked)/i;

export function classifyInfraError(error: string): InfraCause | null {
  if (error.startsWith(WORKDIR_PREP_PREFIX) && DISK_FULL_PATTERN.test(error)) return "disk_full";
  if (CLI_OUTDATED_PATTERN.test(error)) return "cli_outdated";
  if (AUTH_PATTERN.test(error)) return "auth";
  return null;
}

export function describeInfraCause(cause: InfraCause): string {
  switch (cause) {
    case "disk_full":
      return "the disk holding the task workdirs is full";
    case "cli_outdated":
      return "this seat's claude CLI is too old for the requested model";
    case "auth":
      return "this seat's claude CLI is not logged in (or its token is invalid/expired)";
  }
}

export const DEFAULT_INFRA_COOLDOWN_MS = 30 * 60 * 1000;

export function infraCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FOREMAN_INFRA_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INFRA_COOLDOWN_MS;
}

// In-memory on purpose: a restart of foreman-dispatch (e.g. after the
// operator fixed the cause) should clear it. Keyed per seat so one seat's
// outdated CLI does not stop the other; the disk preflight uses its own key
// since a full disk stops every seat.
export class InfraCooldowns {
  private readonly until = new Map<string, { untilMs: number; cause: string }>();

  start(key: string, cause: string, durationMs: number, now = Date.now()): Date {
    const untilMs = now + durationMs;
    this.until.set(key, { untilMs, cause });
    return new Date(untilMs);
  }

  active(key: string, now = Date.now()): { until: Date; cause: string } | null {
    const entry = this.until.get(key);
    if (!entry) return null;
    if (entry.untilMs <= now) {
      this.until.delete(key);
      return null;
    }
    return { until: new Date(entry.untilMs), cause: entry.cause };
  }
}

export function seatCooldownKey(licenseId: number | null | undefined): string {
  return `seat:${licenseId ?? "default"}`;
}

export const DISK_COOLDOWN_KEY = "disk";

export const DEFAULT_MIN_FREE_GB = 3;

export function minFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FOREMAN_MIN_FREE_GB);
  const gb = Number.isFinite(raw) && raw >= 0 && env.FOREMAN_MIN_FREE_GB !== "" ? raw : DEFAULT_MIN_FREE_GB;
  return gb * 1024 ** 3;
}

export type PreflightDecision = "ok" | "sweep" | "refuse";

// Pure: `afterSweep` is the free space measured after a sweep, or undefined
// when no sweep has run yet this poll.
export function preflightDecision(freeBytes: number, minBytes: number, afterSweep?: number): PreflightDecision {
  if (freeBytes >= minBytes) return "ok";
  if (afterSweep === undefined) return "sweep";
  return afterSweep >= minBytes ? "ok" : "refuse";
}

export function freeBytesAt(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function runClaude(args: string[], timeoutMs: number): string {
  return execFileSync(claudeBin(), args, {
    timeout: timeoutMs,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

export function claudeVersion(): string | null {
  try {
    return runClaude(["--version"], 30_000);
  } catch {
    return null;
  }
}

// Runs `claude update` once (every seat shares foreman's own install), and
// reports whether the version actually changed - only then is an immediate
// retry worth it.
export function updateClaude(): { changed: boolean; before: string | null; after: string | null; error?: string } {
  const before = claudeVersion();
  try {
    runClaude(["update"], 5 * 60_000);
  } catch (err) {
    return { changed: false, before, after: before, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
  const after = claudeVersion();
  return { changed: before !== null && after !== null && before !== after, before, after };
}
