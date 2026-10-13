import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyInfraError,
  DEFAULT_INFRA_COOLDOWN_MS,
  InfraCooldowns,
  infraCooldownMs,
  minFreeBytes,
  preflightDecision,
  seatCooldownKey,
} from "./infra.js";
import { classifyAttemptFailure } from "./session-limit.js";
import { attemptAfterFailure } from "./runner.js";

// Verbatim from the runner's own comments on #407 and #262.
const DISK_407 =
  "could not prepare the task workdir: Command failed: git clone --local --no-hardlinks --no-checkout /home/marek/projects/my-org/pinboard /app/tasks/task-407/repos/pinboard\nfatal: could not create work tree dir '/app/tasks/task-407/repos/pinboard': No space left on device\n";
const CLI_262 =
  "session ended with is_error: API Error: 400 Claude Code 2.1.266 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again. (cost so far: $0)";

test("classifyInfraError: full disk during workdir preparation (#407/#408)", () => {
  assert.equal(classifyInfraError(DISK_407), "disk_full");
  assert.equal(classifyInfraError("could not prepare the task workdir: ENOSPC: no space left, write"), "disk_full");
});

test("classifyInfraError: ENOSPC from inside the agent's own session is not infra", () => {
  assert.equal(classifyInfraError("session ended with is_error: tests failed: ENOSPC in fixture"), null);
});

test("classifyInfraError: outdated CLI (#262)", () => {
  assert.equal(classifyInfraError(CLI_262), "cli_outdated");
});

test("classifyInfraError: auth failures", () => {
  assert.equal(classifyInfraError("session ended with is_error: Invalid API key · Please run /login"), "auth");
  assert.equal(classifyInfraError("session ended with is_error: Not logged in · Please run /login"), "auth");
  assert.equal(classifyInfraError("session ended with is_error: API Error: 401 OAuth token has expired"), "auth");
  assert.equal(classifyInfraError('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'), "auth");
});

test("classifyInfraError: ordinary failures are not infra", () => {
  assert.equal(classifyInfraError("tests failed on the third case"), null);
  assert.equal(classifyInfraError("could not prepare the task workdir: fatal: branch already exists"), null);
});

test("classifyAttemptFailure reports infra before anything else", () => {
  assert.deepEqual(classifyAttemptFailure({ error: CLI_262, costUsd: 0, capUsd: 2 }), { kind: "infra", cause: "cli_outdated", raw: CLI_262 });
});

test("attempt accounting: infra failure leaves the count unchanged, a normal one keeps its spend", () => {
  // runTask increments before the attempt starts; this is what it holds after.
  const before = 1;
  const started = before + 1;
  assert.equal(attemptAfterFailure(started, "infra"), before);
  assert.equal(attemptAfterFailure(started, "retryable"), before + 1);
});

test("InfraCooldowns are per seat and expire", () => {
  const cd = new InfraCooldowns();
  cd.start(seatCooldownKey(1), "cli_outdated", 1000, 0);
  assert.ok(cd.active(seatCooldownKey(1), 500));
  assert.equal(cd.active(seatCooldownKey(2), 500), null);
  assert.equal(cd.active(seatCooldownKey(1), 1000), null);
  assert.equal(seatCooldownKey(undefined), "seat:default");
});

test("infraCooldownMs honours FOREMAN_INFRA_COOLDOWN_MS", () => {
  assert.equal(infraCooldownMs({}), DEFAULT_INFRA_COOLDOWN_MS);
  assert.equal(infraCooldownMs({ FOREMAN_INFRA_COOLDOWN_MS: "60000" }), 60000);
  assert.equal(infraCooldownMs({ FOREMAN_INFRA_COOLDOWN_MS: "nope" }), DEFAULT_INFRA_COOLDOWN_MS);
});

test("preflightDecision: ok, sweep, then ok or refuse", () => {
  const GB = 1024 ** 3;
  const min = minFreeBytes({});
  assert.equal(min, 3 * GB);
  assert.equal(minFreeBytes({ FOREMAN_MIN_FREE_GB: "5" }), 5 * GB);
  assert.equal(preflightDecision(10 * GB, min), "ok");
  assert.equal(preflightDecision(1 * GB, min), "sweep");
  assert.equal(preflightDecision(1 * GB, min, 4 * GB), "ok");
  assert.equal(preflightDecision(1 * GB, min, 2 * GB), "refuse");
});
