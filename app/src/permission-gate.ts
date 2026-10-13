// the hard floor under `--permission-mode auto` for the chat host
// persona.
//
// Auto mode (see chat.ts's spawnChatTurn) lets Claude Code decide for itself
// when a tool call is risky enough to stop and ask, which is what makes the
// chat feel like an interactive session instead of a permission form. The
// operator's call (2026-09-17) was that its judgment needs a floor: a short
// list of genuinely destructive or outward-facing commands that must reach a
// human every time regardless of what auto thinks.
//
// The mechanism is a PreToolUse hook rather than --disallowedTools, because
// those two do different things: a denylist entry refuses the call outright
// with no way for the operator to say yes, while a hook returning
// `permissionDecision: "ask"` forces the call through the normal approval
// surface (permission-server.ts's MCP prompt tool, which posts into the chat
// thread). Verified live on foreman 2026-09-17 against claude 2.1.266: under
// `--permission-mode auto`, an ordinary `echo` ran unattended while a
// pattern-matched command was escalated.
//
// Spawned by `claude` itself as the hook command - see chat.ts's
// hostPermissionSettings for the same .ts-under-tsx / .js-under-node
// resolution permission-server.ts already uses.

import { createInterface } from "node:readline";

// Matched against a Bash tool call's `command` string. Deliberately short:
// every entry here costs the operator an approval tap on a real workflow, so
// this is "things that change something outside this machine, destroy data, or
// touch production", not a general risk list. Anything not listed is auto
// mode's call to make.
//
// Anchored at the start of a command or just after a shell separator (`;`,
// `&&`, `||`, `|`), so a compound command can't smuggle a listed verb past the
// check by putting it second - and so a mention inside a quoted string or a
// longer word (`git pushd`, `echo "rm -rf"`) doesn't fire.
//
// The anchor also steps over anything that can sit between a separator and the
// real command without changing what it does: inline environment assignments
// (`FOO=1 git push`), an explicit `env` with its own assignments, and
// `command`/`exec`. Review of a past task caught these - an agent writing
// `NODE_ENV=production git push` is entirely natural, and without this the
// always-ask floor simply wouldn't see it.
// An assignment's value may itself be quoted and contain spaces
// (`env GIT_SSH_COMMAND='ssh -i key' git push`), so it is matched as a quoted
// run rather than a bare \S*.
const ASSIGNMENT = String.raw`\w+=(?:'[^']*'|"[^"]*"|\S*)`;
const PREFIX = String.raw`(?:(?:` + ASSIGNMENT + String.raw`|env|command|exec)\s+)*`;
const SEPARATOR = String.raw`(?:^|[;&|(]\s*|\n)\s*` + PREFIX;

// Global options between `git` and its subcommand - `git -C /some/dir push`,
// `git --no-pager push` - are likewise invisible to a naive `git\s+push`.
const GIT_OPTS = String.raw`(?:(?:-[cC]\s+\S+|--\S+|-[a-zA-Z])\s+)*`;

export const ALWAYS_ASK_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp(SEPARATOR + String.raw`git\s+` + GIT_OPTS + String.raw`push\b`), reason: "pushes to a remote" },
  { pattern: new RegExp(SEPARATOR + String.raw`git\s+` + GIT_OPTS + String.raw`reset\s+--hard\b`), reason: "discards uncommitted work" },
  { pattern: new RegExp(SEPARATOR + String.raw`git\s+` + GIT_OPTS + String.raw`clean\b`), reason: "deletes untracked files" },
  { pattern: new RegExp(SEPARATOR + String.raw`gh\s+pr\s+(merge|close)\b`), reason: "changes a pull request's state on GitHub" },
  { pattern: new RegExp(SEPARATOR + String.raw`gh\s+release\b`), reason: "publishes a GitHub release" },
  { pattern: new RegExp(SEPARATOR + String.raw`gh\s+repo\s+(delete|archive)\b`), reason: "destroys or archives a repository" },
  { pattern: new RegExp(SEPARATOR + String.raw`rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+`), reason: "recursive or forced delete" },
  { pattern: new RegExp(SEPARATOR + String.raw`(sudo|doas)\b`), reason: "runs as root" },
  { pattern: new RegExp(SEPARATOR + String.raw`(systemctl|journalctl)\s+[^|;&]*\b(stop|disable|mask|restart|vacuum)\b`), reason: "changes a running service" },
  { pattern: new RegExp(SEPARATOR + String.raw`docker\s+(compose\s+)?(down|rm|kill|prune|stop)\b`), reason: "stops or removes containers" },
  { pattern: new RegExp(String.raw`scripts/deploy(-service)?\.sh`), reason: "deploys a service" },
  // Any shell out to another box is outside this machine's blast radius, and
  // the command it carries is invisible to a prefix check - see
  // agent-settings.ts's note on why curl/python3 were never allowlisted.
  { pattern: new RegExp(SEPARATOR + String.raw`(ssh|scp|rsync|pct)\b`), reason: "acts on another machine" },
  // A nested shell or an eval carries its real command inside a quoted string,
  // where none of the patterns above can see it - `bash -c "git push"` would
  // otherwise pass the floor untouched. Rare enough in practice (the Bash tool
  // already runs through a shell, so re-invoking one is unusual) that always
  // asking costs the operator almost nothing, and it closes the one bypass
  // that no amount of pattern refinement would.
  { pattern: new RegExp(SEPARATOR + String.raw`(ba|z|k|da)?sh\s+(?:-\S+\s+)*-[a-zA-Z]*c\b`), reason: "runs a nested shell whose command this check cannot inspect" },
  { pattern: new RegExp(SEPARATOR + String.raw`eval\b`), reason: "evaluates a command this check cannot inspect" },
];

export interface GateDecision {
  ask: boolean;
  reason?: string;
}

// The `command` of a Bash call, or undefined for any other tool - only Bash
// carries a free-text payload a pattern can meaningfully inspect. Every other
// tool is left entirely to auto mode: Edit/Write are already the kind of thing
// auto reasons about, and re-gating them here would put an approval tap on the
// most common action in a working session.
export function commandOf(toolName: string, toolInput: unknown): string | undefined {
  if (toolName !== "Bash") return undefined;
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const command = (toolInput as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

export function evaluate(toolName: string, toolInput: unknown): GateDecision {
  const command = commandOf(toolName, toolInput);
  if (command === undefined) return { ask: false };
  for (const { pattern, reason } of ALWAYS_ASK_PATTERNS) {
    if (pattern.test(command)) return { ask: true, reason };
  }
  return { ask: false };
}

// A PreToolUse hook communicates by writing JSON on stdout; writing nothing at
// all means "no opinion, carry on with the normal permission flow". Only the
// ask case produces output, so an ordinary tool call pays nothing but this
// process's startup.
export function hookOutput(decision: GateDecision): string | null {
  if (!decision.ask) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: `foreman always-ask list: ${decision.reason}`,
    },
  });
}

if (process.env.CHAT_PERMISSION_GATE_RUN === "1") {
  let input = "";
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => (input += line));
  rl.on("close", () => {
    try {
      const payload = JSON.parse(input) as { tool_name?: string; tool_input?: unknown };
      const output = hookOutput(evaluate(payload.tool_name ?? "", payload.tool_input));
      if (output) process.stdout.write(`${output}\n`);
    } catch {
      // A payload this can't parse is not a reason to block the session -
      // stay silent and let the normal permission flow decide, same
      // fail-open-to-the-normal-path choice as a non-Bash tool.
    }
  });
}
