// MCP permission-prompt-tool server for the I8 planning
// chat's host persona (see chat.ts's resolvePersona, granted per-agent via
// pinboard's agents.isHost).
// That persona used to run under `--permission-mode bypassPermissions` with
// no allowlist at all - a static bypass rather than a real approval
// surface. This gives it one: `claude` spawns this script itself as an MCP
// stdio subprocess (see chat.ts's hostPermissionMcpConfig,
// `--permission-prompt-tool`) for the duration of one turn, and every tool
// call the host persona wants to make round-trips through here first.
//
// Reuses ask.ts's blocking-question pattern (post a chat message, poll for
// a reply) rather than inventing a second one: the same thread the
// operator is already watching gets a message describing the tool call,
// and a plain "approve"/"deny" reply in that same thread answers it. No
// pinboard schema or UI change needed for this - the existing chat
// message/reply primitives already are the approval surface.
//
// Written as a hand-rolled JSON-RPC-over-stdio server (line-delimited
// JSON, per MCP's stdio transport) rather than pulling in
// @modelcontextprotocol/sdk as a new dependency for one tool - this only
// implements the handful of methods `claude` actually calls
// (initialize/notifications/initialized/tools/list/tools/call). If the SDK
// is later needed for a second MCP tool elsewhere in this repo, switch
// this over to it rather than maintaining two hand-rolled servers.

import { createInterface } from "node:readline";
import { findQuestionMessage, findReply } from "./ask.js";
import { getChatMessages, postChatMessage } from "./pinboard.js";

const THREAD_ID = Number(process.env.CHAT_PERMISSION_THREAD_ID);
const POLL_INTERVAL_MS = 5_000;
// Long enough for an operator to notice and reply without hanging the
// whole chat turn forever - deny by default past this, same "fail closed"
// choice bypassPermissions never had to make.
export const MAX_WAIT_MS = 30 * 60 * 1000;

type PermissionResult =
  | { behavior: "allow"; updatedInput: unknown; remember?: boolean }
  | { behavior: "deny"; message: string };

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

export function formatApprovalQuestion(toolName: string, input: unknown): string {
  const inputPreview = JSON.stringify(input, null, 2)?.slice(0, 1500) ?? String(input);
  return [
    `Permission request: run tool \`${toolName}\` with input:`,
    "```json",
    inputPreview,
    "```",
    "Reply `approve` (once), `approve always` (don't ask again this turn for this command), or `deny`.",
  ].join("\n");
}

// "approve always" (the pinboard PWA's second button, per task
// #136) marks the decision to be remembered for the rest of this MCP
// subprocess's life - see rememberedThisTurn below. Matched with a word
// boundary so it doesn't fire on an unrelated reply that merely contains
// "always" elsewhere in a sentence.
export function interpretReply(replyBody: string): PermissionResult {
  const answer = replyBody.trim().toLowerCase();
  if (answer.startsWith("approve") || answer.startsWith("allow") || answer.startsWith("yes")) {
    const remember = /\balways\b/.test(answer);
    return { behavior: "allow", updatedInput: undefined, remember };
  }
  return { behavior: "deny", message: replyBody.trim() || "operator denied this action" };
}

// a signature identifying "this kind of call" for the
// remember-for-this-turn feature - for Bash, the command's first three
// whitespace-separated tokens (so approving `git commit -m x` remembers
// `Bash:git commit -m`, not the exact command string, letting a repeated
// shape of call only ask once). Deliberately NOT just the first word: an
// earlier version grouped by first word alone, which meant approving `git
// commit` also silently auto-allowed a later `git push`, `git reset --hard`,
// or any other `git` subcommand in the same turn - a real permission-boundary
// gap caught in review. Three tokens distinguishes `git commit`
// from `git push` and `gh pr create` from `gh pr merge`, at the cost of
// slightly less cache reuse across minor flag differences - correctness over
// convenience. For every other tool, just the tool name, matching how
// interactive Claude Code's own "don't ask again for this session" remembers
// per-tool.
export function toolSignature(toolName: string, input: unknown): string {
  if (toolName === "Bash" && input && typeof input === "object" && "command" in (input as Record<string, unknown>)) {
    const command = String((input as { command?: unknown }).command ?? "").trim();
    const tokens = command.split(/\s+/).slice(0, 3).join(" ");
    return `Bash:${tokens}`;
  }
  return toolName;
}

// Lives only as long as this MCP subprocess - one spawnChatTurn/`claude -p`
// invocation (chat.ts spawns a fresh subprocess per turn), so this is
// exactly "remembered for this turn," not persisted across turns or threads.
const rememberedThisTurn = new Set<string>();

// A pinboard fetch failure (bad PINBOARD_URL, transient network blip, pinboard
// itself restarting) must not throw out of here: an unhandled rejection would
// kill this whole MCP subprocess, and every tool call for the rest of the
// session would then fail with a generic "Connection closed" instead of a
// clear denial - exactly what happened in thread #23 on 2026-09-16 (see
// chat.ts's hostPermissionMcpConfig comment for the actual root cause found
// that day). Fail closed, but stay alive so the next tool call gets a real
// chance instead of inheriting a dead connection.
async function decideOrThrow(toolName: string, input: unknown): Promise<PermissionResult> {
  if (!Number.isFinite(THREAD_ID)) {
    return { behavior: "deny", message: "chat-permission server has no CHAT_PERMISSION_THREAD_ID - denying by default" };
  }

  const signature = toolSignature(toolName, input);
  if (rememberedThisTurn.has(signature)) {
    return { behavior: "allow", updatedInput: input };
  }

  const question = formatApprovalQuestion(toolName, input);
  let messages = await getChatMessages(THREAD_ID);
  const existing = findQuestionMessage(messages, question);
  const askedId = existing ? existing.id : (await postChatMessage(THREAD_ID, "agent", question)).id;

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const reply = findReply(messages, askedId);
    if (reply) {
      const result = interpretReply(reply.body);
      if (result.behavior !== "allow") return result;
      if (result.remember) rememberedThisTurn.add(signature);
      return { behavior: "allow", updatedInput: input };
    }
    if (Date.now() >= deadline) {
      return { behavior: "deny", message: `no operator reply within ${MAX_WAIT_MS / 1000}s - denying by default` };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    messages = await getChatMessages(THREAD_ID);
  }
}

async function decide(toolName: string, input: unknown): Promise<PermissionResult> {
  try {
    return await decideOrThrow(toolName, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { behavior: "deny", message: `chat-permission server error: ${message} - denying by default` };
  }
}

const APPROVAL_TOOL = {
  name: "approval_prompt",
  description: "Ask the operator in the planning chat thread to approve or deny a tool call before it runs.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
    },
    required: ["tool_name", "input"],
  },
};

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: { tool_name?: string; input?: unknown } };
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "foreman-chat-permission", version: "0.1.0" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [APPROVAL_TOOL] } });
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.params?.name !== APPROVAL_TOOL.name) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool ${msg.params?.name}` } });
      return;
    }
    const { tool_name, input } = msg.params.arguments ?? {};
    const result = await decide(tool_name ?? "unknown", input);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}

// Only run the stdio loop when actually executed as the MCP subprocess -
// keeps this importable from tests (formatApprovalQuestion/interpretReply)
// without also starting a readline loop on stdin.
if (process.env.CHAT_PERMISSION_RUN === "1") {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line) as JsonRpcMessage);
    } catch {
      // Malformed line from the host - nothing sensible to reply to, drop it.
    }
  });
}
