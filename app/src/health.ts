// dependencies foreman needs that fail in a way only the operator
// can fix. Before this, each of them only reached the dispatcher's own log
// (or a comment on whichever task happened to hit it). Now a change of state
// is journaled in pinboard (POST /health/report), whose notification rules
// turn it into a bell entry.
//
// Checks reported:
//   8ball         an 8ball-executor run failed to reach or get an answer from
//                 the LLM gateway (filed under the pinboard project named by
//                 EIGHT_BALL_PROJECT, if any); recovered on the next good run.
//   seat:<id>     a seat's claude CLI is logged out or too old (#440's auth /
//                 cli_outdated); recovered on that seat's next run that is
//                 not an infrastructure failure.
//   disk          the task workdir disk is below FOREMAN_MIN_FREE_GB even
//                 after a sweep; recovered on the next passing preflight.
//
// Deduplicated: only transitions are sent, so a gateway outage is one bell
// entry, not one per task. State is in-memory, like InfraCooldowns - a
// restart forgets it, so a still-failing check reports once more afterwards,
// and a recovery across a restart is not reported (the first success after
// start is the baseline, not news).

import { reportHealth, type HealthStatus } from "./pinboard.js";

export interface HealthReport {
  check: string;
  status: HealthStatus;
  project: string;
  detail: string | null;
}

export type HealthSender = (report: HealthReport) => Promise<void>;

export class HealthTracker {
  private readonly failing = new Set<string>();

  constructor(private readonly send: HealthSender) {}

  // Returns the transition sent, if any. The state only moves once the send
  // succeeded, so an alert raised while pinboard is unreachable is retried by
  // the next observation instead of being lost.
  async observe(check: string, ok: boolean, project: string, detail: string | null = null): Promise<HealthStatus | null> {
    const wasFailing = this.failing.has(check);
    if (ok === !wasFailing) return null;
    const status: HealthStatus = ok ? "recovered" : "failing";
    try {
      await this.send({ check, status, project, detail: detail?.slice(0, 500) ?? null });
    } catch (err) {
      console.error(`health: could not report ${check} ${status} to pinboard: ${String(err)}`);
      return null;
    }
    if (ok) this.failing.delete(check);
    else this.failing.add(check);
    console.log(`health: ${check} ${status}${detail ? ` (${detail.slice(0, 200)})` : ""}`);
    return status;
  }
}

export const health = new HealthTracker(reportHealth);

export const EIGHT_BALL_CHECK = "8ball";
// The pinboard project slug a gateway alert is filed under; empty files it
// under none.
export function eightBallProject(env: NodeJS.ProcessEnv = process.env): string {
  return env.EIGHT_BALL_PROJECT ?? "";
}
export const DISK_CHECK = "disk";
export function seatCheck(licenseId: number | null | undefined): string {
  return `seat:${licenseId ?? "default"}`;
}
