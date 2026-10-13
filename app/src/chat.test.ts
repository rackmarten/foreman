import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CHAT_OPTIONS,
  buildFreshPrompt,
  buildResumePrompt,
  hostPermissionMcpConfig,
  hostPermissionSettings,
  latestHumanMessage,
  resolvePersona,
} from "./chat.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, modelArgs, resolveEffort } from "./agent-settings.js";
import type { Agent, ChatMessage, ChatThread, Project } from "./pinboard.js";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 1, threadId: 1, role: "human", body: "hello", createdAt: new Date().toISOString(), ...overrides };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    slug: "media",
    name: "Media",
    description: null,
    localPath: "my-org/media",
    autoDeployAllowed: false,
    relatedProjectIds: [],
    ...overrides,
  };
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 1,
    projectId: null,
    taskId: null,
    agentId: null,
    title: "t",
    status: "open",
    awaitingAgent: true,
    claudeSessionId: null,
    model: null,
    effort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 1,
    name: "planner",
    role: null,
    provider: "anthropic",
    model: null,
    executor: "cli",
    autonomyLevel: 0,
    credentialRef: null,
    routingWeight: 1,
    enabled: true,
    licenseId: 1,
    isHost: false,
    ...overrides,
  };
}

test("latestHumanMessage returns the last human message, ignoring agent replies after it", () => {
  const messages = [
    message({ id: 1, role: "human", body: "first" }),
    message({ id: 2, role: "agent", body: "reply" }),
    message({ id: 3, role: "human", body: "second" }),
  ];
  assert.equal(latestHumanMessage(messages)?.body, "second");
});

test("latestHumanMessage returns undefined when the thread only has agent messages", () => {
  assert.equal(latestHumanMessage([message({ role: "agent" })]), undefined);
});

test("latestHumanMessage returns undefined for an empty thread", () => {
  assert.equal(latestHumanMessage([]), undefined);
});

test("buildResumePrompt sends only the latest human message, not the transcript", () => {
  assert.equal(buildResumePrompt(message({ body: "what about the retention sweep?" })), "what about the retention sweep?");
});

test("buildFreshPrompt replays the whole transcript and names the scoped project", () => {
  const messages = [message({ role: "human", body: "let's discuss X" }), message({ role: "agent", body: "sure, tell me more" })];
  const prompt = buildFreshPrompt(project({ slug: "router" }), messages);
  assert.match(prompt, /router/);
  assert.match(prompt, /Operator: let's discuss X/);
  assert.match(prompt, /You: sure, tell me more/);
});

test("buildFreshPrompt asks which project when none is scoped", () => {
  const prompt = buildFreshPrompt(undefined, [message()]);
  assert.match(prompt, /ask which/);
});

test("buildFreshPrompt instructs cross-repo work to be split into parent/child subtasks", () => {
  const prompt = buildFreshPrompt(project(), [message()]);
  assert.match(prompt, /--parent=<parentTaskId>/);
  assert.match(prompt, /work task relate .*--type=depends_on/);
});

test("buildFreshPrompt switches to an unrestricted execution persona for the host agent", () => {
  const prompt = buildFreshPrompt(project(), [message()], true);
  assert.match(prompt, /unrestricted execution agent/);
  assert.match(prompt, /full tool access/);
  // The planning-only instructions (file a task instead of doing the work)
  // must not leak into the host persona's framing.
  assert.doesNotMatch(prompt, /work task create/);
});

test("resolvePersona is not the host persona when no agent is set", () => {
  const persona = resolvePersona(thread(), undefined);
  assert.equal(persona.isHostAgent, false);
});

test("resolvePersona is not the host persona for an agent with isHost unset", () => {
  const persona = resolvePersona(thread(), agent({ isHost: false }));
  assert.equal(persona.isHostAgent, false);
});

test("resolvePersona recognizes an agent with isHost set as the host persona", () => {
  const persona = resolvePersona(thread(), agent({ isHost: true }));
  assert.equal(persona.isHostAgent, true);
});

test("resolvePersona falls back to the default model when neither thread nor agent set one", () => {
  const persona = resolvePersona(thread(), agent({ model: null }));
  assert.equal(persona.model, DEFAULT_MODEL);
});

test("resolvePersona prefers the agent's own model over the default", () => {
  const persona = resolvePersona(thread(), agent({ model: "opus" }));
  assert.equal(persona.model, "opus");
});

test("resolvePersona prefers the thread's model override over the agent's own model", () => {
  const persona = resolvePersona(thread({ model: "sonnet" }), agent({ model: "opus" }));
  assert.equal(persona.model, "sonnet");
});

test("resolvePersona passes through the thread's effort hint", () => {
  const persona = resolvePersona(thread({ effort: "high" }), undefined);
  assert.equal(persona.effort, "high");
});

test("resolvePersona falls back to DEFAULT_EFFORT when the thread has none", () => {
  const persona = resolvePersona(thread(), undefined);
  assert.equal(persona.effort, DEFAULT_EFFORT);
});

test("resolveEffort defaults to medium and honors CLAUDE_EFFORT", () => {
  assert.equal(resolveEffort({}), "medium");
  assert.equal(resolveEffort({ CLAUDE_EFFORT: "high" }), "high");
});

test("modelArgs always passes --effort, medium by default", () => {
  assert.deepEqual(modelArgs("claude-opus-5-5", resolveEffort({})), ["--model", "claude-opus-5-5", "--effort", "medium"]);
  assert.deepEqual(modelArgs("m", resolveEffort({ CLAUDE_EFFORT: "low" })), ["--model", "m", "--effort", "low"]);
  assert.deepEqual(modelArgs("m"), ["--model", "m", "--effort", DEFAULT_EFFORT]);
});

test("hostPermissionMcpConfig wires the approval tool name to the given thread id", () => {
  const { configJson, toolName } = hostPermissionMcpConfig(42);
  assert.equal(toolName, "mcp__chat-permission__approval_prompt");
  const config = JSON.parse(configJson);
  assert.equal(config.mcpServers["chat-permission"].env.CHAT_PERMISSION_THREAD_ID, "42");
});

// the always-ask floor is wired in as a PreToolUse hook via an
// inline --settings JSON string. Worth a test because nothing else fails
// loudly if it stops being emitted - the chat would simply run with no floor
// under auto mode, which looks exactly like working correctly.
test("hostPermissionSettings registers permission-gate as a PreToolUse hook on Bash", () => {
  const settings = JSON.parse(hostPermissionSettings());
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, "Bash");
  assert.equal(entries[0].hooks[0].type, "command");
  assert.match(entries[0].hooks[0].command, /CHAT_PERMISSION_GATE_RUN=1/);
  assert.match(entries[0].hooks[0].command, /permission-gate\.(ts|js)$/);
});

test("the chat turn timeout clears the approval wait it has to outlive", async () => {
  // permission-server.ts blocks up to 30 minutes for an operator reply; while
  // DEFAULT_CHAT_OPTIONS.timeoutMs was 10 minutes, the outer kill always won
  // and a slowly-answered approval could never succeed.
  const { MAX_WAIT_MS } = await import("./permission-server.js");
  assert.ok(
    DEFAULT_CHAT_OPTIONS.timeoutMs > MAX_WAIT_MS,
    `chat timeout ${DEFAULT_CHAT_OPTIONS.timeoutMs}ms must exceed the ${MAX_WAIT_MS}ms approval wait`,
  );
});
