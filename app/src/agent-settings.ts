// Shared model and effort for every `claude` session foreman spawns (task
// runner and chat) - operator's call (2026-09-27, a past task): Opus 5.5 at
// medium effort. Effort is always passed explicitly, so a run no longer
// inherits `effortLevel` from the run user's ~/.claude/settings.json (which
// on foreman is "high"). Override via CLAUDE_MODEL / CLAUDE_EFFORT without a
// code change. A pinboard agent row's own model still wins over the default.
//
// History: 2026-09-09 settled on Sonnet at the CLI's default effort after
// --effort high burned ~67% of a 5h session window on a past task's failed
// attempts with nothing to show for it.
export const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

// Takes the env as a parameter so tests can pin it: a test run inside a
// Claude Code session inherits that session's own CLAUDE_EFFORT.
export function resolveEffort(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_EFFORT || "medium";
}

export const DEFAULT_EFFORT = resolveEffort();

// The `--model`/`--effort` pair every task run passes (runner.ts).
export function modelArgs(model: string, effort: string = DEFAULT_EFFORT): string[] {
  return ["--model", model, "--effort", effort];
}

// Default tool allowlist for I4a's unattended agent runner (runner.ts).
// Broad enough for a typical small implementation task - I4a's own scope is
// "single-agent execution, branch and PR only" - without ever trusting the
// agent with push or PR-creation rights: foreman pushes the branch and opens
// the PR itself after inspecting the worktree's commits, so a compromised or
// confused agent session can at worst leave bad commits on a throwaway
// branch, never touch `origin` or GitHub directly. I12a added per-agent
// routing (which agent/model runs a task) but deliberately left this
// allowlist shared rather than per-agent: every agent this routes to today
// is still the same `claude -p` executor with the same tool profile, so a
// per-agent override would be unused config. Revisit if/when I12b's LLM gateway
// executor (a genuinely different tool profile) lands.

// Widened after I4a's first real run (a past task, pinboard PR #1): the
// original list let the agent implement the change but denied every command
// it needed to verify its own work (`npm --prefix app run build`, `cd app &&
// ...`, plain `grep`/`find`), so it committed unverified and said so
// honestly in its handoff. Compound commands (`a && b`) need each piece
// allowed separately, hence `cd:*` alongside `npm run:*`.
export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(cd:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(npm install:*)",
  "Bash(npm ci:*)",
  "Bash(npm run:*)",
  "Bash(npm test:*)",
  "Bash(npm --prefix *)",
  // I9: lets the running session pause and ask the operator a question
  // instead of guessing - see ask.ts.
  "Bash(work task ask:*)",
  // records a reversible decision and returns at once - the
  // runner prompt's autonomy policy prefers this over asking.
  "Bash(work task assume:*)",
  // rootproxy calls for a root-access task's own run - see root.ts.
  "Bash(work root:*)",
  // lets a session grant itself write access to a repo it
  // discovers it needs mid-task, instead of stopping to ask a human -
  // see runner.ts's relatedRepoLines and work.ts's taskAddRelatedRepo.
  "Bash(work task add-related-repo:*)",
  // read-only CI evidence, so an agent fixing a ci_failed handback
  // can read the run itself. GET only: every mutating form is denied below.
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(gh api repos/*/actions/*:*)",
];

export const GH_MUTATING_DENIES = [
  "Bash(gh pr:*)",
  "Bash(gh issue:*)",
  "Bash(gh repo:*)",
  "Bash(gh release:*)",
  "Bash(gh workflow:*)",
  "Bash(gh secret:*)",
  "Bash(gh variable:*)",
  "Bash(gh auth:*)",
  "Bash(gh cache:*)",
  "Bash(gh label:*)",
  "Bash(gh run rerun:*)",
  "Bash(gh run cancel:*)",
  "Bash(gh run delete:*)",
  "Bash(gh run watch:*)",
  "Bash(gh api -X:*)",
  "Bash(gh api --method:*)",
  "Bash(gh api * -X *)",
  "Bash(gh api * --method *)",
  "Bash(gh api * -f *)",
  "Bash(gh api * -F *)",
  "Bash(gh api * --field *)",
  "Bash(gh api * --raw-field *)",
  "Bash(gh api * --input *)",
];

// git push/gh denials are real: verified they block the Bash tool. The
// Read(**/.env) denials are also real, but only for the dedicated Read
// tool - a real test in this build showed plain Bash read commands (cat,
// grep, ls, find) are NOT gated by --allowedTools/--disallowedTools at
// all, so "Bash(cat .env)" below is decorative, not an actual control.
// The real reason a session can't leak `.env` secrets is structural, not
// a permission rule: the session works in a checkout containing only
// committed content (a `--worktree` worktree before a past task, the task's
// own clone under /app/tasks since), and every repo in this org gitignores
// `.env` - so it simply isn't present for the agent to read, by any tool.
// Kept here anyway in case Bash gating changes in a future build.
export const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  // was a blanket `Bash(gh:*)`, which (deny beats allow) also
  // blocked the read-only CI commands above. Everything that writes is listed
  // instead; any other gh command is still unapproved, so denied unattended.
  ...GH_MUTATING_DENIES,
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Bash(cat .env)",
  "Bash(cat .env.*)",
  "WebFetch",
  "WebSearch",
];

// I8: the planning chat agent. Discusses/decomposes work and reads code to
// inform that discussion, but never edits anything and never commits - it
// files the agreed outcome as a task via `work task create` instead of
// executing it. Narrower than the runner's DEFAULT_ALLOWED_TOOLS on
// purpose: no Write/Edit, no git at all.
export const CHAT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(work task create:*)",
  // lets the planning chat wire depends_on (or other) relations
  // between cross-repo subtasks it just created - parent/child linkage
  // itself goes through `task create --parent=`, already covered above.
  "Bash(work task relate:*)",
  // Pinboard "Resolve in chat" seeds a thread with open asks and
  // the operator settles them here, so the chat answers them by id.
  "Bash(work task answer:*)",
];

export const CHAT_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "Bash(git*)",
  "Bash(gh:*)",
  "Read(**/.env)",
  "Read(**/.env.*)",
  "WebFetch",
  "WebSearch",
];

// a planning-chat thread whose agent has pinboard's
// agents.isHost set swaps the read-only planning persona above for an
// unrestricted execution persona - auto permission mode, no tool
// allowlist/denylist at all, equivalent to an interactive `claude` session
// run from that project's own checkout. See chat.ts's resolvePersona.
// (Originally gated on a single hardcoded agent name, "foreman-host" -
// replaced because pinboard's agents.name is globally unique, which meant
// only one license, ever, could own that name.)

// A past task added a HOST_ALLOWED_TOOLS prefix allowlist here, pre-approving
// read-only investigation commands so they skipped the chat approval
// round-trip. A past task removed it: `--permission-mode auto` (see chat.ts's
// spawnChatTurn) makes that judgment itself, the way an interactive session
// does, and a static prefix list could only ever be a worse approximation of
// it - chat thread #26 still needed an approval for each of `cd`, `sed -n`,
// `systemctl` and `curl` because none of them were literally on the list.
// What replaced it is permission-gate.ts: a short always-ask floor of
// genuinely destructive verbs, which is the opposite direction (name what
// must stop, not what may pass) and so does not have to be exhaustive to be
// correct.
