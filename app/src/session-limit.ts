// why an attempt failed, so the runner can stop spending attempts
// on failures a retry provably cannot fix.
//
// The attempt loop used to treat every non-terminal failure identically -
// comment, `continue`, retry until the attempt cap sent the task to rework.
// That is right for a flaky test or a bad edit and wrong for the two
// failures that actually showed up in production on 2026-09-17:
//
//   - Session limit. A past task's attempts 2 and 3 cost $0 each, ~15s apart,
//     and then the attempt cap threw a perfectly good task into rework.
//     A past task independently did the same thing minutes later. Nothing a
//     retry does can clear a 5h window; only waiting can.
//   - Budget cap. #117's attempt 1 cost $2.0203 and attempt 2 $2.0379
//     against a $2 cap. Every attempt gets a *fresh* cap, so a task that
//     genuinely needs more than the cap can never finish no matter how many
//     attempts it is given - it just buys the same wall three times.
//
// A past task added a third, found the same way on the same day: a retained
// session id resumed under a seat whose store has never seen it. See
// STALE_SESSION_PATTERN below.
//
// The rule this module encodes: an attempt is only spent on a failure a
// retry could plausibly fix.

import { classifyInfraError, type InfraCause } from "./infra.js";

export type FailureClass =
  | { kind: "session_limit"; resetsAt: Date; raw: string }
  | { kind: "stale_session"; raw: string }
  | { kind: "infra"; cause: InfraCause; raw: string }
  | { kind: "budget_exhausted"; costUsd: number; capUsd: number }
  | { kind: "retryable" };

// Matches the message Claude prints when the 5h window is spent, e.g.
//   You've hit your session limit · resets 1:40am (UTC)
// Detection and time extraction are deliberately separate: if Claude rewords
// the sentence but keeps the shape, we still want to recognise the class even
// when the timestamp no longer parses, because classifying it as retryable is
// the expensive mistake. Apostrophes vary (straight vs curly) so the
// detection pattern avoids them entirely.
const SESSION_LIMIT_PATTERN = /hit\s+your\s+session\s+limit/i;
const RESET_TIME_PATTERN = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(?UTC\)?/i;

// The error text gives a wall-clock time with no date ("resets 1:40am
// (UTC)"), so it has to be resolved against `now`: the next occurrence of
// that UTC time. A reset that would land in the past is the next day's.
export function parseSessionLimitReset(error: string, now: Date): Date | null {
  const match = RESET_TIME_PATTERN.exec(error);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }

  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

export function isSessionLimitError(error: string): boolean {
  return SESSION_LIMIT_PATTERN.test(error);
}

// the third $0 wall, found the same way as the first two. Claude
// prints this when `--resume` names a session its own store has never seen:
//   No conversation found with session ID: 2fd29484-...
// Retrying is provably useless - the id does not become known - so without
// its own class it behaves exactly like #117 did: three attempts, $0 each,
// 8 seconds apart, then a perfectly good task in rework. That is what
// happened to #166 and #169 on 2026-09-17, when a session retained under
// marek's seat was offered to peter's after marek's 5h window closed.
//
// Unlike the two walls above, this one has a remedy the runner can apply by
// itself: drop the unusable session id and start the attempt cold.
const STALE_SESSION_PATTERN = /No conversation found with session ID/i;

export function isStaleSessionError(error: string): boolean {
  return STALE_SESSION_PATTERN.test(error);
}

// Order matters. A session limit is checked first because it is both the
// cheaper failure ($0) and the one with a real remedy (wait), and because a
// run can in principle report a spend at or over its cap *and* have been cut
// off by the window - in which case the reset time is the actionable fact.
//
// `costUsd` is null when the run never produced a result line to read a cost
// from. That is treated as retryable: an unknown cost is not evidence of
// budget exhaustion, and guessing "exhausted" would send fixable failures to
// rework.
export function classifyAttemptFailure(args: {
  error: string;
  costUsd: number | null;
  capUsd: number;
  now?: Date;
}): FailureClass {
  const now = args.now ?? new Date();

  // an infrastructure failure (full disk, outdated CLI, logged-out
  // seat) is checked first - it spends $0 and says nothing about the task.
  const infraCause = classifyInfraError(args.error);
  if (infraCause) return { kind: "infra", cause: infraCause, raw: args.error };

  if (isSessionLimitError(args.error)) {
    const resetsAt = parseSessionLimitReset(args.error, now);
    // No parseable time still means "do not retry, do not burn an attempt".
    // Fall back to the end of a full window from now - pessimistic on
    // purpose, since waiting too long costs nothing but attempts and money.
    return {
      kind: "session_limit",
      resetsAt: resetsAt ?? new Date(now.getTime() + 5 * 60 * 60 * 1000),
      raw: args.error,
    };
  }

  // Before the budget check: a run that died on an unusable session id spent
  // nothing, so it can never look budget-exhausted - but classifying it after
  // a cost comparison would still be reading the wrong fact first.
  if (isStaleSessionError(args.error)) {
    return { kind: "stale_session", raw: args.error };
  }

  if (args.costUsd !== null && args.capUsd > 0 && args.costUsd >= args.capUsd) {
    return { kind: "budget_exhausted", costUsd: args.costUsd, capUsd: args.capUsd };
  }

  return { kind: "retryable" };
}
