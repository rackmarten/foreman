import assert from "node:assert/strict";
import { test } from "node:test";
import { askInput, findQuestionMessage, findReply, formatAskMessage, pendingQuestion } from "./ask.js";
import type { ChatMessage } from "./pinboard.js";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 1, threadId: 1, role: "agent", body: "?", createdAt: new Date().toISOString(), ...overrides };
}

test("findQuestionMessage finds a still-pending question (no reply after it yet)", () => {
  const messages = [message({ id: 1, role: "human", body: "unrelated" }), message({ id: 2, role: "agent", body: "which env?" })];
  assert.equal(findQuestionMessage(messages, "which env?")?.id, 2);
});

test("findQuestionMessage still finds a question that already has a reply after it", () => {
  // The reviewer-caught bug: a reply that arrives after a prior call's own
  // wait window gave up must not be lost on a retry with the same text.
  const messages = [message({ id: 1, role: "agent", body: "which env?" }), message({ id: 2, role: "human", body: "staging" })];
  assert.equal(findQuestionMessage(messages, "which env?")?.id, 1);
});

test("findQuestionMessage returns undefined for a genuinely new question, even with unrelated history", () => {
  const messages = [message({ id: 1, role: "agent", body: "which env?" }), message({ id: 2, role: "human", body: "staging" })];
  assert.equal(findQuestionMessage(messages, "which repo?"), undefined);
});

test("findQuestionMessage returns undefined for an empty thread", () => {
  assert.equal(findQuestionMessage([], "which env?"), undefined);
});

test("findReply returns the first human message after the asked message id", () => {
  const messages = [
    message({ id: 1, role: "agent" }),
    message({ id: 2, role: "human", body: "the answer" }),
  ];
  assert.equal(findReply(messages, 1)?.body, "the answer");
});

test("findReply ignores human messages that came before the question was asked", () => {
  const messages = [message({ id: 1, role: "human", body: "earlier chatter" }), message({ id: 2, role: "agent" })];
  assert.equal(findReply(messages, 2), undefined);
});

test("findReply returns undefined when no reply has arrived yet", () => {
  assert.equal(findReply([message({ id: 1, role: "agent" })], 1), undefined);
});

test("pendingQuestion returns the agent's last message on an open thread", () => {
  const msg = (id: number, role: "agent" | "human", body: string) => ({ id, role, body }) as ChatMessage;
  const open = { status: "open" };
  assert.equal(pendingQuestion(open, [msg(1, "agent", "Which DB?")]), "Which DB?");
  assert.equal(pendingQuestion(open, [msg(1, "agent", "Which DB?"), msg(2, "human", "Postgres")]), null);
  assert.equal(pendingQuestion({ status: "closed" }, [msg(1, "agent", "Which DB?")]), null);
  assert.equal(pendingQuestion(null, []), null);
  assert.equal(pendingQuestion(open, []), null);
});

// A past task
test("formatAskMessage is the bare question without structure, numbered options with it", () => {
  assert.equal(formatAskMessage("Which db?", { options: [] }), "Which db?");
  assert.equal(
    formatAskMessage("Which db?", {
      context: "Needs one.",
      options: [{ label: "Postgres", rationale: "shared" }, { label: "SQLite" }],
      recommended: 0,
    }),
    "Which db?\n\nNeeds one.\n\n1. Postgres (recommended) - shared\n2. SQLite",
  );
});

test("askInput marks exactly the recommended option and carries the thread", () => {
  const input = askInput("Which db?", 9, { options: [{ label: "a", rationale: "r" }, { label: "b" }], recommended: 1 });
  assert.deepEqual(input, {
    kind: "question",
    question: "Which db?",
    options: [
      { label: "a", rationale: "r", recommended: false },
      { label: "b", recommended: true },
    ],
    threadId: 9,
  });
  assert.deepEqual(askInput("Free text?", 3).options, []);
});
