import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAttemptFailure, isSessionLimitError, isStaleSessionError, parseSessionLimitReset } from "./session-limit.js";

// Verbatim from a past task's own comments on 2026-09-17 - the run that burned
// three attempts and then marked itself for rework.
const SESSION_LIMIT_117 =
  "session ended with is_error: You've hit your session limit · resets 1:40am (UTC) (cost so far: $0.6425542)";

// Verbatim from #117 attempt 1, which spent $2.0203 against a $2 cap. Post
// a past task the stdin warning no longer masks the real cause, but the cost
// is what identifies this class either way.
const BUDGET_117 =
  "session ended with is_error: Warning: no stdin data received in 3s, proceeding without it. (cost so far: $2.0203292)";

// Verbatim from #166/#169 attempt 1 on 2026-09-17 - peter's seat resuming a
// session id retained under marek's, per a past task.
const STALE_SESSION_166 =
  "session ended with is_error: No conversation found with session ID: 2fd29484-c9f7-42dc-bbb0-7ff636892c81";

test("recognises the real session-limit error from a past run", () => {
  assert.equal(isSessionLimitError(SESSION_LIMIT_117), true);
  assert.equal(isSessionLimitError(BUDGET_117), false);
});

test("parses the reset time as the next occurrence of that UTC clock time", () => {
  const now = new Date("2026-09-16T22:21:31.000Z");
  const resetsAt = parseSessionLimitReset(SESSION_LIMIT_117, now);
  assert.equal(resetsAt?.toISOString(), "2026-09-17T01:40:00.000Z");
});

test("a reset time earlier in the day than now rolls to tomorrow", () => {
  const now = new Date("2026-09-16T10:00:00.000Z");
  const resetsAt = parseSessionLimitReset("resets 1:40am (UTC)", now);
  assert.equal(resetsAt?.toISOString(), "2026-09-17T01:40:00.000Z");
});

test("handles pm and the 12am/12pm edges", () => {
  const now = new Date("2026-09-16T00:30:00.000Z");
  assert.equal(parseSessionLimitReset("resets 1:40pm (UTC)", now)?.toISOString(), "2026-09-16T13:40:00.000Z");
  assert.equal(parseSessionLimitReset("resets 12:15am (UTC)", now)?.toISOString(), "2026-09-17T00:15:00.000Z");
  assert.equal(parseSessionLimitReset("resets 12:15pm (UTC)", now)?.toISOString(), "2026-09-16T12:15:00.000Z");
});

test("returns null when there is no reset time to read", () => {
  assert.equal(parseSessionLimitReset("something else entirely", new Date()), null);
});

test("classifies the session limit and does not mistake it for budget exhaustion", () => {
  const now = new Date("2026-09-16T22:21:31.000Z");
  const result = classifyAttemptFailure({ error: SESSION_LIMIT_117, costUsd: 0.6425542, capUsd: 2, now });
  assert.equal(result.kind, "session_limit");
  assert.equal(result.kind === "session_limit" && result.resetsAt.toISOString(), "2026-09-17T01:40:00.000Z");
});

// #117 attempts 2 and 3 cost exactly $0 - the case that must not consume an
// attempt, since three of them proved nothing and cost nothing to discover.
test("a $0 session-limit failure still classifies as session_limit", () => {
  const now = new Date("2026-09-16T22:21:49.000Z");
  const result = classifyAttemptFailure({
    error: "session ended with is_error: You've hit your session limit · resets 1:40am (UTC) (cost so far: $0)",
    costUsd: 0,
    capUsd: 2,
    now,
  });
  assert.equal(result.kind, "session_limit");
});

test("a session limit with an unreadable reset time still refuses to retry", () => {
  const now = new Date("2026-09-16T22:00:00.000Z");
  const result = classifyAttemptFailure({ error: "You've hit your session limit, try later", costUsd: 0, capUsd: 2, now });
  assert.equal(result.kind, "session_limit");
  assert.equal(result.kind === "session_limit" && result.resetsAt.getTime(), now.getTime() + 5 * 60 * 60 * 1000);
});

test("classifies a run that spent its cap as budget_exhausted", () => {
  const result = classifyAttemptFailure({ error: BUDGET_117, costUsd: 2.0203292, capUsd: 2 });
  assert.equal(result.kind, "budget_exhausted");
  assert.equal(result.kind === "budget_exhausted" && result.costUsd, 2.0203292);
});

test("a run that failed well under its cap is retryable", () => {
  const result = classifyAttemptFailure({ error: "tests failed on the third case", costUsd: 0.4, capUsd: 2 });
  assert.equal(result.kind, "retryable");
});

// An unknown cost is not evidence of budget exhaustion - guessing would send
// fixable failures to rework instead of retrying them.
test("an unknown cost is retryable rather than assumed exhausted", () => {
  const result = classifyAttemptFailure({ error: "no result line found in stream-json output", costUsd: null, capUsd: 2 });
  assert.equal(result.kind, "retryable");
});

// the third $0 wall, found the same way as #117's session-limit
// one - a retry can never fix it, so it must not spend an attempt.
test("recognises a resume against a session id its own store has never seen", () => {
  assert.equal(isStaleSessionError(STALE_SESSION_166), true);
  assert.equal(isStaleSessionError(SESSION_LIMIT_117), false);
  assert.equal(isStaleSessionError(BUDGET_117), false);
});

test("classifies a stale session id as its own failure class, not budget_exhausted or retryable", () => {
  const result = classifyAttemptFailure({ error: STALE_SESSION_166, costUsd: 0, capUsd: 2 });
  assert.equal(result.kind, "stale_session");
});
