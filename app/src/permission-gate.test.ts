import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, evaluate, hookOutput } from "./permission-gate.js";

test("a plain read or build command is left to auto mode", () => {
  for (const command of [
    "ls -la",
    "cat app/src/chat.ts",
    "grep -rn foo app/",
    "npm --prefix app run build",
    "git status",
    "git log --oneline -5",
    "curl -s http://pinboard:8095/health",
    "work task list --project=foreman",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, false, command);
  }
});

test("destructive and outward-facing commands are forced to ask", () => {
  for (const command of [
    "git push origin main",
    "git reset --hard origin/main",
    "git clean -fd",
    "gh pr merge 12 --squash",
    "gh pr close 12",
    "gh release create v1",
    "gh repo delete my-org/foreman",
    "rm -rf node_modules",
    "rm -f .env",
    "sudo systemctl restart docker",
    "systemctl --user restart foreman-chat.service",
    "docker compose down",
    "docker prune -a",
    "./scripts/deploy-service.sh glance",
    "ssh glance docker ps",
    "scp file marek@glance:/tmp/",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, true, command);
  }
});

// The reason this is anchored on a separator rather than matched anywhere in
// the string: a compound command must not be able to hide a listed verb
// behind a harmless first clause, and an innocent mention must not fire.
test("a listed verb still asks when it is not the first clause of a compound command", () => {
  for (const command of [
    "npm run build && git push",
    "cd app; git push origin main",
    "npm test || git reset --hard",
    "git log | grep push && sudo reboot",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, true, command);
  }
});

test("a listed verb quoted or embedded in a longer word does not fire", () => {
  for (const command of [
    'echo "remember to git push later"',
    "grep -rn 'git push' scripts/",
    "git pushd",
    "cat docs/rm-rf-warning.md",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, false, command);
  }
});

test("only Bash carries a command to inspect; every other tool is auto mode's call", () => {
  assert.equal(commandOf("Edit", { file_path: "a.ts" }), undefined);
  assert.equal(commandOf("Bash", { command: "ls" }), "ls");
  assert.equal(commandOf("Bash", {}), undefined);
  assert.equal(evaluate("Edit", { file_path: "a.ts", new_string: "git push" }).ask, false);
  assert.equal(evaluate("Write", { content: "rm -rf /" }).ask, false);
});

test("hook output is emitted only for an ask, in the shape Claude Code expects", () => {
  assert.equal(hookOutput({ ask: false }), null);
  const parsed = JSON.parse(hookOutput({ ask: true, reason: "pushes to a remote" }) ?? "");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /pushes to a remote/);
});

// Found in review of each of these reaches the same destructive
// command through a wrapper the original patterns looked straight past. The
// env-assignment prefix is the one an agent is most likely to write by itself.
test("a listed verb still asks behind an env prefix, a git option or a nested shell", () => {
  for (const command of [
    "FOO=1 git push",
    "NODE_ENV=production git push origin main",
    "env GIT_SSH_COMMAND='ssh -i k' git push",
    "env FOO=1 BAR=2 rm -rf build",
    "git -C /home/marek/projects/my-org/glance push",
    "git --no-pager push origin main",
    "git -c user.name=x push",
    "bash -c 'git push'",
    'sh -c "rm -rf /tmp/x"',
    "zsh -c 'gh pr merge 1'",
    "bash -lc 'git push'",
    "eval \"$DEPLOY_CMD\"",
    "npm run build && FOO=1 git push",
    "(cd app && git push)",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, true, command);
  }
});

// The prefix and option allowances must not turn into a wildcard that gates
// ordinary work - every one of these is a command the operator wants to run
// without being asked.
test("the wrapper allowances do not start gating ordinary commands", () => {
  for (const command of [
    "NODE_ENV=test npm test",
    "env",
    "git -C app status",
    "git --no-pager log --oneline -5",
    "command -v claude",
    "npm run build && npm test",
    "cd app && npm ci",
  ]) {
    assert.equal(evaluate("Bash", { command }).ask, false, command);
  }
});
