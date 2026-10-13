// I12a: deterministic routing - which agent should run a task when the
// caller didn't explicitly request one via `--agent=`. Pure and
// synchronous (no network call), same as runner.ts's own
// pickNextRunnableTask, so it's unit-testable without a live pinboard.
//
// Zero rules configured is deliberately a no-op: every task falls back to
// `fallbackAgentName` (the runner's own default), so adding this feature
// doesn't change existing behavior until the operator actually adds rules.

import type { Agent, RoutingRule } from "./pinboard.js";

export interface ResolvedAgent {
  name: string;
  model: string | null;
  autonomyLevel: number | null;
  // I12b: which executor actually runs the task - "cli" (claude -p, the
  // original I4a pipeline) vs. "8ball" (free local models, no repo/worktree/
  // PR - see eightball.ts).
  executor: string;
  // which license (and so which OAuth token, see spawn-env.ts)
  // this agent's run counts against and spawns under. null only for
  // runner.ts's own explicit `--agent=` path when the named agent doesn't
  // resolve to a real, enabled row - every agent returned from here (rule
  // match or fallback) always has a real license.
  licenseId: number | null;
}

interface RoutableTask {
  taskType: string;
  labels: { name: string }[];
  // the floor a resolved agent must clear - see clearsFloor
  // below. null means no floor (matches every enabled agent), the same as
  // before this field existed.
  autonomyLevel: number | null;
}

function toResolved(agent: Agent): ResolvedAgent {
  return { name: agent.name, model: agent.model, autonomyLevel: agent.autonomyLevel, executor: agent.executor, licenseId: agent.licenseId };
}

// which license the caller is dispatching for, when it is
// dispatching for one in particular. The dispatch loop asks once per enabled
// license, so an unrouted task must fall back to *that* seat's own runner
// rather than always to the single global fallback name - otherwise a second
// license never starts anything unless the operator writes a routing rule for
// every task, and the loop's per-license budget question is answered for a
// task that would then run on the other license anyway.
//
// Undefined means "no particular seat" (the `work task run` path and every
// pre-#152 caller): fallback is the named agent, exactly as before.
export function resolveAgentForTask(
  task: RoutableTask,
  rules: RoutingRule[],
  agents: Agent[],
  fallbackAgentName: string,
  preferLicenseId?: number,
): ResolvedAgent | null {
  // a rule match or the fallback agent is only usable if its own
  // autonomyLevel clears the task's floor - routing used to hand back an
  // agent that runner.ts's own post-hoc check would then refuse anyway,
  // which is both wasted work (a claim + lease taken for nothing) and,
  // worse, a null autonomyLevel agent slipping through unchecked. Filtering
  // here means a task with no eligible agent is refused up front instead.
  const clearsFloor = (agent: Agent) => task.autonomyLevel === null || agent.autonomyLevel >= task.autonomyLevel;
  const enabledAgentsById = new Map(agents.filter((a) => a.enabled && clearsFloor(a)).map((a) => [a.id, a]));
  const labelNames = new Set(task.labels.map((l) => l.name));

  const matches = rules.filter(
    (r) =>
      r.enabled &&
      enabledAgentsById.has(r.agentId) &&
      (r.taskType === null || r.taskType === task.taskType) &&
      (r.labelName === null || labelNames.has(r.labelName)),
  );

  if (matches.length > 0) {
    matches.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const weightDiff = enabledAgentsById.get(b.agentId)!.routingWeight - enabledAgentsById.get(a.agentId)!.routingWeight;
      if (weightDiff !== 0) return weightDiff;
      return a.id - b.id;
    });
    return toResolved(enabledAgentsById.get(matches[0].agentId)!);
  }

  // No degenerate fallback any more: a fallback agent that doesn't exist,
  // isn't enabled, or doesn't clear the floor means no agent may run this
  // task, not a synthetic agent with a null autonomyLevel that bypassed the
  // check entirely.
  const eligible = agents.filter((a) => a.enabled && clearsFloor(a));

  if (preferLicenseId !== undefined) {
    // This seat's own unattended runner. Restricted to executor "cli" on
    // purpose: a license's fallback is the agent that runs the full
    // worktree/PR pipeline, not its LLM gateway executor (free local inference,
    // deliberately reachable only through an explicit routing rule) and not
    // its "cli-host" chat persona. The named global fallback still sorts
    // first when it belongs to this license, so on a single-seat install the
    // answer is the same agent as before this task - by a different route,
    // since the dispatcher now always names a seat once any license row
    // exists.
    const onLicense = eligible
      .filter((a) => a.licenseId === preferLicenseId && a.executor === "cli")
      .sort((a, b) => {
        if (a.name === fallbackAgentName) return -1;
        if (b.name === fallbackAgentName) return 1;
        if (b.routingWeight !== a.routingWeight) return b.routingWeight - a.routingWeight;
        return a.id - b.id;
      });
    return onLicense.length > 0 ? toResolved(onLicense[0]) : null;
  }

  const fallback = eligible.find((a) => a.name === fallbackAgentName);
  return fallback ? toResolved(fallback) : null;
}
