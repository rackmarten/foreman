import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS } from "./agent-settings.js";

// Claude Code's Bash rule shape: `prefix:*` is a prefix match, and `*`
// elsewhere is a wildcard. Enough to check the lists against real commands.
function matches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) return false;
  const pattern = inner.endsWith(":*") ? `${inner.slice(0, -2)}*` : inner;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(command);
}
const allowed = (cmd: string) => DEFAULT_ALLOWED_TOOLS.some((r) => matches(r, cmd));
const denied = (cmd: string) => DEFAULT_DISALLOWED_TOOLS.some((r) => matches(r, cmd));

test("read-only CI commands are allowed and not denied", () => {
  for (const cmd of [
    "gh run view 36471847069 --repo my-org/cue --log-failed",
    "gh run list --repo my-org/sandbox --branch task-224",
    "gh api repos/my-org/cue/actions/jobs/123/logs",
  ]) {
    assert.ok(allowed(cmd), cmd);
    assert.ok(!denied(cmd), cmd);
  }
});

test("mutating gh commands stay denied", () => {
  for (const cmd of [
    "gh run rerun 36471847069 --repo my-org/cue",
    "gh run cancel 1",
    "gh pr merge https://github.com/my-org/cue/pull/5 --squash",
    "gh pr create --fill",
    "gh api -X POST repos/my-org/cue/actions/runs/1/rerun",
    "gh api repos/my-org/cue/actions/runs/1/rerun -X POST",
    "gh api repos/my-org/cue/actions/runs/1/rerun --method POST",
    "gh api repos/my-org/cue/actions/variables -f name=x",
    "gh workflow run ci.yml",
    "gh repo delete my-org/cue",
  ]) {
    assert.ok(denied(cmd), cmd);
  }
  assert.ok(denied("git push origin HEAD"));
});
