// I8: planning chat passthrough (PLAN.md). foreman never accepts inbound
// connections, so this is pinboard-mediated message passing, not a direct
// socket - polls for threads with awaitingAgent: true the same way the I7
// dispatcher polls for queued tasks, and replies via `claude -p`. Default
// persona is read-only repo access plus `work task create` (see
// agent-settings.ts's CHAT_ALLOWED_TOOLS) - it never commits code, only
// proposes and, once agreed, files a task for a later run to actually
// execute. a thread whose agent has isHost set instead
// gets an unrestricted execution persona - see resolvePersona below.

import { spawn } from "node:child_process";
import { workspaceRoot } from "./paths.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getChatMessages,
  listAgents,
  listChatThreads,
  listLicenses,
  listProjects,
  patchChatThread,
  postChatMessage,
  postChatUsage,
  type Agent,
  type ChatMessage,
  type ChatThread,
  type License,
  type Project,
} from "./pinboard.js";
import { CHAT_ALLOWED_TOOLS, CHAT_DISALLOWED_TOOLS, DEFAULT_EFFORT, DEFAULT_MODEL } from "./agent-settings.js";
import { claudeBin, inheritedEnv, spawnEnvOrThrow, type SpawnEnv } from "./spawn-env.js";

// see work.ts's WORKSPACE_ROOT for why this moved up one level.
const WORKSPACE_ROOT = workspaceRoot();

export interface ChatOptions {
  timeoutMs: number;
  budgetUsd: number;
}

// raised from 10 minutes / $2, which was sized for I8's original
// read-only planning reply and became the binding constraint once the
// foreman-host persona started actually doing work in a thread. The timeout
// in particular has to clear permission-server.ts's own MAX_WAIT_MS (30
// minutes of waiting for an operator approval): while those two disagreed,
// the outer kill always fired first, so the approval wait could never be
// reached and a turn the operator answered slowly died instead of resuming.
export const DEFAULT_CHAT_OPTIONS: ChatOptions = {
  timeoutMs: 45 * 60 * 1000,
  budgetUsd: 10,
};

interface ClaudeChatResult {
  is_error: boolean;
  result: string;
  session_id: string;
  // present on every `--output-format json` result and previously
  // discarded here, which is why every chat thread read totalCostUsd "0" and
  // no chat spend reached pinboard's usage_events at all - see handleThread.
  total_cost_usd?: number;
  duration_ms?: number;
}

// the "foreman-host" agent swaps this planning-only framing
// for an unrestricted execution persona - it's expected to actually do the
// work in the thread (edit files, run commands, commit) rather than just
// discuss and file a task for a later run.
// exported so chat-daemon.ts builds a live session under exactly
// the same persona framing this poller used - one source of truth for what
// each persona is, whether it runs as a turn or as a session.
export function systemFraming(project: Project | undefined, isHostAgent: boolean): string {
  const scope = project
    ? `This thread is scoped to the '${project.slug}' project - your current working directory ` +
      "is that project's own repo checkout."
    : "This thread has no project scoped to it.";

  if (isHostAgent) {
    return [
      "You are an unrestricted execution agent running unattended on foreman, equivalent to an " +
        "interactive `claude` session started in this directory: full tool access (no allowlist or " +
        "denylist) under automatic permission approval, picking up this machine's global ~/.claude " +
        "config plus whatever project AGENTS.md/.claude settings apply as you navigate.",
      scope + " Actually do the work discussed in this thread yourself - read/edit files, run " +
        "commands, commit changes - rather than just proposing an approach.",
      "Reply with just the message to show the operator next - plain text, not JSON.",
    ].join("\n\n");
  }

  return [
    "You are a planning assistant discussing and decomposing a piece of work with the operator, " +
      "running unattended on foreman. You are not executing anything yourself this turn - ask " +
      "clarifying questions and propose an approach, the same way an interactive Claude Code " +
      "planning session would.",
    project
      ? scope + " Read its code/PLAN.md as needed to inform the discussion."
      : "If filing a task ends up needing a project, ask which project it belongs to before " +
        "calling `work task create`.",
    "Once you and the operator agree on a concrete, well-scoped piece of work, file it with " +
      "`work task create --project=<slug> [--description=] <title...>` rather than implementing it " +
      "yourself.",
    "if the agreed work genuinely spans more than one repo (e.g. a shared helper " +
      "needed in homelab-kit before another project can consume it - see homelab/AGENTS.md's " +
      "Cross-repo issues convention), don't file one task that quietly covers both halves. " +
      "Recognize the split at definition time and propose - or, once the operator agrees, create " +
      "directly - a parent task for the overall goal plus one child task per repo, each created " +
      "with `--parent=<parentTaskId>`. If one child must land before another can start, also wire " +
      "that ordering with `work task relate <fromId> <toId> --type=depends_on` once both exist. " +
      "Subtask creation happens here, at planning time with the operator in the loop - never mid-" +
      "execution by a running task's own agent.",
    "Reply with just the message to show the operator next - plain text, not JSON.",
  ].join("\n\n");
}

// A fresh session (no prior --resume context) needs the whole conversation
// replayed into the prompt itself, since there's no session state to
// carry it. Used both for a thread's first turn and as the fallback when a
// stored session id turns out to be stale - see handleThread below.
export function buildFreshPrompt(project: Project | undefined, messages: ChatMessage[], isHostAgent = false): string {
  const transcript = messages.map((m) => `${m.role === "human" ? "Operator" : "You"}: ${m.body}`).join("\n\n");
  return [systemFraming(project, isHostAgent), "", "Conversation so far:", "", transcript].join("\n");
}

// A resumed session already has every prior message in its own context -
// sending the whole transcript again would just double it up.
export function buildResumePrompt(lastHumanMessage: ChatMessage): string {
  return lastHumanMessage.body;
}

export function latestHumanMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.filter((m) => m.role === "human").at(-1);
}

export function resolveCwd(project: Project | undefined): string {
  return project?.localPath ? join(WORKSPACE_ROOT, project.localPath) : WORKSPACE_ROOT;
}

export interface ChatPersona {
  isHostAgent: boolean;
  model: string;
  effort: string;
}

// which persona a thread's messages should be spawned
// under. Everything except an agent with isHost set keeps the existing
// read-only planning persona (CHAT_ALLOWED_TOOLS/CHAT_DISALLOWED_TOOLS);
// isHost switches to an unrestricted execution persona - see spawnChatTurn
// below. Keyed off the agent's own isHost flag rather than a single
// hardcoded agent name (the old "foreman-host" scheme), since pinboard's
// agents.name is globally unique and so could only ever grant this to one
// license - isHost is per-agent, so each license can flag its own. A
// thread's own model/effort (set at creation, see pinboard's POST
// /chat/threads) override the agent's own model, which overrides
// foreman's default. Effort falls back to DEFAULT_EFFORT rather
// than the run user's settings.json.
export function resolvePersona(thread: ChatThread, agent: Agent | undefined): ChatPersona {
  return {
    isHostAgent: agent?.isHost === true,
    model: thread.model ?? agent?.model ?? DEFAULT_MODEL,
    effort: thread.effort ?? DEFAULT_EFFORT,
  };
}

// the host persona's tool calls approve/deny inline in the same
// chat thread instead of running under a blanket `bypassPermissions` -
// resolves to the sibling permission-server module, compiled (.js, under
// dist/) in production or the .ts source under `tsx` in dev (see
// permission-server.ts's own comment on why it's spawned this way instead
// of pulling in an MCP SDK dependency).
export function hostPermissionMcpConfig(threadId: number): { configJson: string; toolName: string } {
  const isTs = import.meta.url.endsWith(".ts");
  const serverPath = fileURLToPath(new URL(`./permission-server${isTs ? ".ts" : ".js"}`, import.meta.url));
  const serverName = "chat-permission";
  const config = {
    mcpServers: {
      [serverName]: {
        command: isTs ? "npx" : process.execPath,
        args: isTs ? ["tsx", serverPath] : [serverPath],
        env: {
          PATH: process.env.PATH ?? "",
          // Bug found 2026-09-16 (pinboard chat thread #23): defaulting to ""
          // here defeats pinboard.ts's own `?? "http://pinboard:8095"`
          // fallback in the child process, since `??` only substitutes for
          // null/undefined, not an empty string - PINBOARD_URL isn't set in
          // foreman-dispatch.service's environment, so this was landing on
          // every real host-persona turn. The empty base URL makes every
          // fetch in permission-server.ts throw ERR_INVALID_URL, which is
          // unhandled and kills the MCP subprocess - every tool call for the
          // rest of that session then fails with a generic MCP "Connection
          // closed" error (indistinguishable from a sandbox/permission
          // denial), which is what thread #23 actually hit.
          PINBOARD_URL: process.env.PINBOARD_URL ?? "http://pinboard:8095",
          CHAT_PERMISSION_RUN: "1",
          CHAT_PERMISSION_THREAD_ID: String(threadId),
        },
      },
    },
  };
  return { configJson: JSON.stringify(config), toolName: `mcp__${serverName}__approval_prompt` };
}

// the always-ask floor under `--permission-mode auto`, as an
// inline `--settings` JSON string registering permission-gate.ts as a
// PreToolUse hook. Same .ts-under-tsx / .js-under-node resolution as
// hostPermissionMcpConfig above, for the same reason - one module, run
// either from source in dev or from dist/ in production.
//
// Why a hook rather than --disallowedTools: a denylist entry refuses the
// call outright with no way for the operator to say yes, whereas the hook's
// `permissionDecision: "ask"` routes it through the approval surface that
// already exists (the MCP prompt tool above), which is exactly what "always
// ask, never silently allow, but let me approve it" needs.
export function hostPermissionSettings(): string {
  const isTs = import.meta.url.endsWith(".ts");
  const gatePath = fileURLToPath(new URL(`./permission-gate${isTs ? ".ts" : ".js"}`, import.meta.url));
  const command = isTs ? `npx tsx ${gatePath}` : `${process.execPath} ${gatePath}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `CHAT_PERMISSION_GATE_RUN=1 ${command}` }],
        },
      ],
    },
  });
}

async function spawnChatTurn(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  opts: ChatOptions,
  persona: ChatPersona,
  threadId: number,
  spawnEnv: SpawnEnv,
): Promise<ClaudeChatResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    persona.model,
    "--max-budget-usd",
    String(opts.budgetUsd),
  ];
  args.push("--effort", persona.effort);
  if (persona.isHostAgent) {
    // real inline approval instead of a blanket bypass - anything
    // escalated round-trips through permission-server.ts, which posts a
    // message in this same thread and blocks for an operator approve/deny.
    //
    // A past task changed *what* escalates. This used to be `--permission-mode
    // default` plus HOST_ALLOWED_TOOLS, a prefix allowlist that tried to
    // enumerate every safe command by hand - which is why chat thread #26
    // needed an approval for each of `cd`, `work --help`, `sed -n`,
    // `systemctl`, `curl`: anything not literally listed prompted, and
    // "approve always" keyed on a command's first three tokens so it never
    // matched the next command either. `auto` moves that judgment into
    // Claude Code itself (the same mode an interactive session runs in), and
    // hostPermissionSettings above puts a hard always-ask floor under it for
    // the genuinely destructive verbs. No --allowedTools at all now: an
    // allowlist entry would only re-create the thing it replaced, and could
    // pre-approve a call the always-ask list wants a human to see.
    const { configJson, toolName } = hostPermissionMcpConfig(threadId);
    args.push("--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", toolName, "--mcp-config", configJson);
    args.push("--settings", hostPermissionSettings());
  } else {
    // See runner.ts's I21 follow-up comment: --permission-prompts none alone
    // still auto-denies anything outside a narrow built-in set regardless of
    // --allowedTools, since there's no approval surface in a headless run.
    // The planning persona stays on that narrow allowlist/bypass - it's
    // read-only by construction (CHAT_ALLOWED_TOOLS has no Write/Edit/git),
    // so there's nothing there worth an inline approval round-trip for.
    args.push("--permission-mode", "bypassPermissions", "--permission-prompts", "none");
    args.push("--allowedTools", CHAT_ALLOWED_TOOLS.join(","), "--disallowedTools", CHAT_DISALLOWED_TOOLS.join(","));
  }
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  // same license-scoped token as runner.ts's runOneAttempt - see
  // spawn-env.ts.
  const child = spawn(claudeBin(), args, {
    cwd,
    env: {
      ...inheritedEnv(),
      ...spawnEnv,
      WORK_ACTOR_TYPE: "agent",
      WORK_ACTOR_NAME: "foreman-chat",
    },
  });

  // the prompt is passed as an argument, so nothing is ever
  // written here - but leaving the pipe open made `claude` wait on it and
  // emit "Warning: no stdin data received in 3s, proceeding without it",
  // which then became the entire user-facing error text whenever a turn
  // failed for an unrelated reason (the stderr fallback below prints
  // whichever stream has content). Closing it removes that red herring.
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
      exited.then(() => clearTimeout(timer));
    }),
  ]);

  if (outcome === "timeout") {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    child.kill("SIGKILL");
    return { is_error: true, result: `hard timeout (${opts.timeoutMs}ms) exceeded, session killed`, session_id: "" };
  }

  try {
    return JSON.parse(stdout) as ClaudeChatResult;
  } catch {
    return {
      is_error: true,
      result: `could not parse claude output as JSON: ${(stderr || stdout).slice(0, 500)}`,
      session_id: "",
    };
  }
}

async function handleThread(
  thread: ChatThread,
  projects: Project[],
  agents: Agent[],
  licenses: License[],
  opts: ChatOptions,
): Promise<void> {
  const project = projects.find((p) => p.id === thread.projectId) ?? undefined;
  const agent = agents.find((a) => a.id === thread.agentId) ?? undefined;
  const persona = resolvePersona(thread, agent);
  const license = agent ? licenses.find((l) => l.id === agent.licenseId) : undefined;
  const spawnEnv = spawnEnvOrThrow(license);
  const messages = await getChatMessages(thread.id);
  const lastHuman = latestHumanMessage(messages);
  if (!lastHuman) return;

  const cwd = resolveCwd(project);
  let result: ClaudeChatResult;

  // every spawn that produced a result JSON is charged, including
  // a failed resume that is then retried fresh below - that attempt cost real
  // money whether or not its answer was used. A spawn that never produced
  // parseable output (hard timeout, killed process) carries no figure to
  // report and is silently uncharged; that gap closes with #148, which reads
  // the streamed events rather than only the final blob.
  const charge = async (r: ClaudeChatResult): Promise<ClaudeChatResult> => {
    if (r.total_cost_usd === undefined && r.duration_ms === undefined) return r;
    try {
      await postChatUsage(thread.id, { costUsd: r.total_cost_usd ?? 0, durationMs: r.duration_ms ?? 0 });
    } catch (err) {
      // Losing the cost record must not also lose the operator's answer -
      // the reply below is the point of the turn.
      console.error(`chat: thread #${thread.id} usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    return r;
  };

  if (thread.claudeSessionId) {
    result = await charge(
      await spawnChatTurn(buildResumePrompt(lastHuman), cwd, thread.claudeSessionId, opts, persona, thread.id, spawnEnv),
    );
    if (result.is_error) {
      // Open design question from PLAN.md's I8, resolved here: a stored
      // session id isn't kept forever, so a resume can fail for reasons
      // that have nothing to do with this turn's content. Fall back to a
      // fresh session with the transcript replayed into the prompt instead
      // of surfacing that as a user-facing error.
      result = await charge(
        await spawnChatTurn(buildFreshPrompt(project, messages, persona.isHostAgent), cwd, undefined, opts, persona, thread.id, spawnEnv),
      );
    }
  } else {
    result = await charge(
      await spawnChatTurn(buildFreshPrompt(project, messages, persona.isHostAgent), cwd, undefined, opts, persona, thread.id, spawnEnv),
    );
  }

  // Posting the reply is what clears awaitingAgent (see pinboard's
  // routes.ts) - true on the error path too, so a failed turn doesn't spin
  // the poller retrying the same thread forever; the operator sees the
  // failure as a message instead.
  await postChatMessage(thread.id, "agent", result.result || "(no reply produced)");
  if (result.session_id && result.session_id !== thread.claudeSessionId) {
    await patchChatThread(thread.id, { claudeSessionId: result.session_id });
  }
}

export interface ChatPollResult {
  handled: number;
}

// how often `work chat watch` looks for a thread awaiting a reply.
// Two seconds rather than the dispatcher's 60 because this is a person
// waiting for an answer, not a queue - and unlike the dispatch loop, a poll
// that finds nothing is one cheap request against a service on the same
// tailnet. #147/#148 replace this with an SSE subscription, at which point
// the interval only matters as a reconnect fallback.
export const DEFAULT_CHAT_WATCH_INTERVAL_SECONDS = 2;

export async function pollChatThreads(opts: ChatOptions = DEFAULT_CHAT_OPTIONS): Promise<ChatPollResult> {
  // I9: taskId=none excludes task-scoped session chat threads - those are
  // only ever replied to by the task's own running session via `work task
  // ask`, never by this planning-chat poller, which would otherwise race
  // it with a second, unrelated fresh/resumed session on the same thread.
  const threads = await listChatThreads({ awaitingAgent: true, status: "open", taskId: "none" });
  if (threads.length === 0) return { handled: 0 };

  const startable = threads.filter((t) => !inFlight.has(t.id));
  if (startable.length === 0) return { handled: 0 };

  const [projects, agents, licenses] = await Promise.all([listProjects(), listAgents(), listLicenses()]);
  let handled = 0;
  for (const thread of startable) {
    handled += 1;
    // started, not awaited. Two threads are two independent
    // conversations with their own sessions, so one parked on an approval
    // must not hold up the other - the same reason runner.ts stopped
    // awaiting runTask in a past task. The inFlight map is what makes this safe
    // at a 2s poll: awaitingAgent only clears when the reply is posted, so
    // without it every tick would spawn another session for the same thread.
    const turn = handleThread(thread, projects, agents, licenses, opts)
      .catch((err: unknown) => {
        console.error(`chat: thread #${thread.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => inFlight.delete(thread.id));
    inFlight.set(thread.id, turn);
  }
  return { handled };
}

// Turns currently in flight in this process, by thread id. Lives only as long
// as the process: a restart loses it, and the thread is simply picked up again
// on the next poll, which is the correct recovery - its `claude` child died
// with the process.
const inFlight = new Map<number, Promise<void>>();

// For the one-shot `work chat poll`, which has to stay alive until the turn it
// started finishes - exiting would kill the `claude` child with it. The watch
// loop never calls this: not waiting is the entire point there.
export async function awaitInFlightTurns(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
}

// the chat half of what used to be one cycle of `work dispatch`,
// now its own loop in its own process (foreman-chat.service). Stops between
// polls on SIGINT/SIGTERM; a turn already running is left alone, the same
// contract runDispatchLoop has for a running task.
export async function runChatWatchLoop(
  intervalSeconds: number = DEFAULT_CHAT_WATCH_INTERVAL_SECONDS,
  opts: ChatOptions = DEFAULT_CHAT_OPTIONS,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: string | null = null;
  while (!signal?.aborted) {
    try {
      const result = await pollChatThreads(opts);
      if (result.handled > 0) console.log(`chat: started ${result.handled} turn(s)`);
      lastError = null;
    } catch (err) {
      // pinboard being briefly unreachable is a normal blip at a 2s poll -
      // log it once rather than every two seconds until it recovers.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) console.error(`chat: poll failed: ${message}`);
      lastError = message;
    }
    if (signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}
