import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentForTask } from "./routing.js";
import type { Agent, RoutingRule } from "./pinboard.js";

function agent(overrides: Partial<Agent> & { id: number; name: string }): Agent {
  return {
    role: null,
    provider: "anthropic",
    model: null,
    executor: "cli",
    autonomyLevel: 3,
    credentialRef: null,
    routingWeight: 1,
    enabled: true,
    licenseId: 1,
    isHost: false,
    ...overrides,
  };
}

function rule(overrides: Partial<RoutingRule> & { id: number; agentId: number }): RoutingRule {
  return { taskType: null, labelName: null, priority: 0, enabled: true, ...overrides };
}

test("resolveAgentForTask falls back to the default agent when no rules exist", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const resolved = resolveAgentForTask({ taskType: "implementation", labels: [], autonomyLevel: null }, [], [fallback], "foreman-runner");
  assert.equal(resolved?.name, "foreman-runner");
});

test("resolveAgentForTask falls back when no rule matches the task", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const other = agent({ id: 2, name: "research-bot" });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research" })];
  const resolved = resolveAgentForTask(
    { taskType: "implementation", labels: [], autonomyLevel: null },
    rules,
    [fallback, other],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "foreman-runner");
});

test("resolveAgentForTask matches by taskType", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const researchBot = agent({ id: 2, name: "research-bot", model: "haiku" });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research" })];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: null },
    rules,
    [fallback, researchBot],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "research-bot");
  assert.equal(resolved?.model, "haiku");
});

test("resolveAgentForTask matches by label", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const summarizer = agent({ id: 2, name: "summarizer" });
  const rules = [rule({ id: 1, agentId: 2, labelName: "digest" })];
  const resolved = resolveAgentForTask(
    { taskType: "implementation", labels: [{ name: "digest" }], autonomyLevel: null },
    rules,
    [fallback, summarizer],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "summarizer");
});

test("resolveAgentForTask picks the highest-priority match among several", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const low = agent({ id: 2, name: "low-priority-agent" });
  const high = agent({ id: 3, name: "high-priority-agent" });
  const rules = [
    rule({ id: 1, agentId: 2, taskType: "research", priority: 1 }),
    rule({ id: 2, agentId: 3, taskType: "research", priority: 5 }),
  ];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: null },
    rules,
    [fallback, low, high],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "high-priority-agent");
});

test("resolveAgentForTask ties break on the matched agent's routingWeight", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const lightweight = agent({ id: 2, name: "lightweight-agent", routingWeight: 1 });
  const heavyweight = agent({ id: 3, name: "heavyweight-agent", routingWeight: 10 });
  const rules = [
    rule({ id: 1, agentId: 2, taskType: "research", priority: 0 }),
    rule({ id: 2, agentId: 3, taskType: "research", priority: 0 }),
  ];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: null },
    rules,
    [fallback, lightweight, heavyweight],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "heavyweight-agent");
});

test("resolveAgentForTask ignores a matching rule that targets a disabled agent", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const disabled = agent({ id: 2, name: "disabled-agent", enabled: false });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research" })];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: null },
    rules,
    [fallback, disabled],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "foreman-runner");
});

test("resolveAgentForTask ignores a disabled rule", () => {
  const fallback = agent({ id: 1, name: "foreman-runner" });
  const researchBot = agent({ id: 2, name: "research-bot" });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research", enabled: false })];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: null },
    rules,
    [fallback, researchBot],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "foreman-runner");
});

// A past task coverage below: the autonomy floor and the null-instead-of-
// degenerate-fallback behavior.

test("resolveAgentForTask filters a rule-matched agent below the task's autonomy floor, falling back", () => {
  const fallback = agent({ id: 1, name: "foreman-runner", autonomyLevel: 3 });
  const tooLow = agent({ id: 2, name: "low-autonomy-agent", autonomyLevel: 1 });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research" })];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: 2 },
    rules,
    [fallback, tooLow],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "foreman-runner");
});

test("resolveAgentForTask returns null when no agent, routed or fallback, clears the autonomy floor", () => {
  const fallback = agent({ id: 1, name: "foreman-runner", autonomyLevel: 1 });
  const tooLow = agent({ id: 2, name: "low-autonomy-agent", autonomyLevel: 1 });
  const rules = [rule({ id: 1, agentId: 2, taskType: "research" })];
  const resolved = resolveAgentForTask(
    { taskType: "research", labels: [], autonomyLevel: 2 },
    rules,
    [fallback, tooLow],
    "foreman-runner",
  );
  assert.equal(resolved, null);
});

test("resolveAgentForTask returns null rather than a degenerate fallback when the fallback agent doesn't exist", () => {
  const resolved = resolveAgentForTask({ taskType: "implementation", labels: [], autonomyLevel: null }, [], [], "foreman-runner");
  assert.equal(resolved, null);
});

test("resolveAgentForTask lets an agent exactly at the floor through", () => {
  const fallback = agent({ id: 1, name: "foreman-runner", autonomyLevel: 2 });
  const resolved = resolveAgentForTask(
    { taskType: "implementation", labels: [], autonomyLevel: 2 },
    [],
    [fallback],
    "foreman-runner",
  );
  assert.equal(resolved?.name, "foreman-runner");
});

// the dispatch loop asks per license, so an unrouted task has to
// fall back to that seat's own runner rather than always to the global one.
test("resolveAgentForTask falls back to the asking license's own cli runner", () => {
  const mine = agent({ id: 1, name: "foreman-runner", licenseId: 1 });
  const theirs = agent({ id: 2, name: "peter-runner", licenseId: 2 });
  const task = { taskType: "implementation", labels: [], autonomyLevel: null };

  assert.equal(resolveAgentForTask(task, [], [mine, theirs], "foreman-runner", 2)?.name, "peter-runner");
  assert.equal(resolveAgentForTask(task, [], [mine, theirs], "foreman-runner", 1)?.name, "foreman-runner");
});

test("a license-scoped fallback ignores non-cli executors on that license", () => {
  const eightBall = agent({ id: 1, name: "8ball-text", licenseId: 2, executor: "8ball", autonomyLevel: 5 });
  const host = agent({ id: 2, name: "foreman-host", licenseId: 2, executor: "cli-host", autonomyLevel: 5 });
  const task = { taskType: "implementation", labels: [], autonomyLevel: null };

  assert.equal(resolveAgentForTask(task, [], [eightBall, host], "foreman-runner", 2), null);
});

test("a license with no eligible runner starts nothing rather than borrowing another's", () => {
  const mine = agent({ id: 1, name: "foreman-runner", licenseId: 1 });
  const task = { taskType: "implementation", labels: [], autonomyLevel: null };

  assert.equal(resolveAgentForTask(task, [], [mine], "foreman-runner", 2), null);
});

test("a routing rule still wins over the asking license's fallback", () => {
  const mine = agent({ id: 1, name: "foreman-runner", licenseId: 1 });
  const theirs = agent({ id: 2, name: "peter-runner", licenseId: 2 });
  const rules = [rule({ id: 1, agentId: 1, taskType: "implementation" })];
  const resolved = resolveAgentForTask(
    { taskType: "implementation", labels: [], autonomyLevel: null },
    rules,
    [mine, theirs],
    "foreman-runner",
    2,
  );
  // Resolves to the other seat's agent - dispatchOnce then leaves the task for
  // that seat's own pass instead of starting it here.
  assert.equal(resolved?.name, "foreman-runner");
  assert.equal(resolved?.licenseId, 1);
});

test("the autonomy floor still applies to a license-scoped fallback", () => {
  const theirs = agent({ id: 2, name: "peter-runner", licenseId: 2, autonomyLevel: 2 });
  const task = { taskType: "implementation", labels: [], autonomyLevel: 4 };
  assert.equal(resolveAgentForTask(task, [], [theirs], "foreman-runner", 2), null);
});
