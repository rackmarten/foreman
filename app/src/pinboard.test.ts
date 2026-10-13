import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatStreamEvent, subscribeChatStream, type ChatStreamEvent } from "./pinboard.js";

test("parses a human_message event", () => {
  assert.deepEqual(parseChatStreamEvent({ event: "human_message", data: '{"threadId":4,"message":"hi"}' }), {
    type: "human_message",
    threadId: 4,
    message: "hi",
  });
});

test("parses a permission_decision event with updated permissions", () => {
  const updates = [{ type: "addRules", rules: [{ toolName: "Read" }], behavior: "allow", destination: "session" }];
  assert.deepEqual(
    parseChatStreamEvent({
      event: "permission_decision",
      data: JSON.stringify({ threadId: 4, requestId: "r1", behavior: "allow", updatedPermissions: updates }),
    }),
    { type: "permission_decision", threadId: 4, requestId: "r1", behavior: "allow", updatedPermissions: updates },
  );
});

test("parses an interrupt event", () => {
  assert.deepEqual(parseChatStreamEvent({ event: "interrupt", data: '{"threadId":9}' }), {
    type: "interrupt",
    threadId: 9,
  });
});

test("parses a question_answer event", () => {
  assert.deepEqual(
    parseChatStreamEvent({
      event: "question_answer",
      data: JSON.stringify({
        threadId: 4,
        requestId: "q1",
        answers: { "Which breakpoint?": "lg (1280px+)" },
        annotations: { "Which breakpoint?": { notes: "laptops stay narrow" } },
      }),
    }),
    {
      type: "question_answer",
      threadId: 4,
      requestId: "q1",
      answers: { "Which breakpoint?": "lg (1280px+)" },
      annotations: { "Which breakpoint?": { notes: "laptops stay narrow" } },
    },
  );
});

test("drops a question_answer with nothing usable in it", () => {
  // An empty answer map would stop the session waiting while handing the tool
  // the same nothing it gets from a timeout - worse than waiting.
  assert.equal(parseChatStreamEvent({ event: "question_answer", data: '{"threadId":1,"requestId":"q"}' }), null);
  assert.equal(
    parseChatStreamEvent({ event: "question_answer", data: '{"threadId":1,"requestId":"q","answers":{}}' }),
    null,
  );
  // A non-string value would reach the model as "[object Object]".
  assert.equal(
    parseChatStreamEvent({ event: "question_answer", data: '{"threadId":1,"requestId":"q","answers":{"a":3}}' }),
    null,
  );
  assert.equal(parseChatStreamEvent({ event: "question_answer", data: '{"threadId":1,"answers":{"a":"b"}}' }), null);
});

test("a question_answer with unusable annotations still delivers the answers", () => {
  assert.deepEqual(
    parseChatStreamEvent({
      event: "question_answer",
      data: '{"threadId":1,"requestId":"q","answers":{"a":"b"},"annotations":{"a":{"notes":7}}}',
    }),
    { type: "question_answer", threadId: 1, requestId: "q", answers: { a: "b" } },
  );
});

test("drops an event foreman does not handle", () => {
  assert.equal(parseChatStreamEvent({ event: "something_new", data: '{"threadId":1}' }), null);
});

test("drops malformed JSON rather than throwing", () => {
  assert.equal(parseChatStreamEvent({ event: "human_message", data: "{not json" }), null);
  assert.equal(parseChatStreamEvent({ event: "human_message", data: "null" }), null);
});

test("drops an event with no usable threadId", () => {
  assert.equal(parseChatStreamEvent({ event: "interrupt", data: "{}" }), null);
  assert.equal(parseChatStreamEvent({ event: "interrupt", data: '{"threadId":"nope"}' }), null);
});

test("drops an incomplete human_message or permission_decision", () => {
  assert.equal(parseChatStreamEvent({ event: "human_message", data: '{"threadId":1}' }), null);
  assert.equal(parseChatStreamEvent({ event: "permission_decision", data: '{"threadId":1,"requestId":"r"}' }), null);
  assert.equal(
    parseChatStreamEvent({ event: "permission_decision", data: '{"threadId":1,"requestId":"r","behavior":"maybe"}' }),
    null,
  );
});

test("accepts a numeric-string threadId", () => {
  assert.deepEqual(parseChatStreamEvent({ event: "interrupt", data: '{"threadId":"12"}' }), {
    type: "interrupt",
    threadId: 12,
  });
});

test("subscribeChatStream decodes a chunked stream and resolves when it ends", async () => {
  const wire = [
    ": ping\n\n",
    'event: human_message\ndata: {"threadId":1,"mess',
    'age":"hello"}\n\n: ping\n\nevent: interrupt\ndata: {"threadId":1}\n\n',
  ];
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of wire) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const seen: ChatStreamEvent[] = [];
    await subscribeChatStream((event) => seen.push(event));
    assert.deepEqual(seen, [
      { type: "human_message", threadId: 1, message: "hello" },
      { type: "interrupt", threadId: 1 },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("subscribeChatStream throws on a non-ok response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
  try {
    await assert.rejects(() => subscribeChatStream(() => undefined), /503/);
  } finally {
    globalThis.fetch = original;
  }
});

// Regression, found live 2026-09-17: the daemon subscribed cleanly and then
// did nothing at all on a real message, because pinboard publishes the
// chat_messages row (text in `body`) while this parser required `message`.
// Every genuine event parsed to null and was dropped silently.
test("parseChatStreamEvent reads pinboard's real human_message row", () => {
  const event = parseChatStreamEvent({
    event: "human_message",
    data: JSON.stringify({ id: 173, threadId: 30, role: "human", body: "hello", createdAt: "2026-09-17T19:27:51.255Z" }),
  });
  assert.deepEqual(event, { type: "human_message", threadId: 30, message: "hello" });
});

test("parseChatStreamEvent still accepts the older {threadId, message} shape", () => {
  const event = parseChatStreamEvent({ event: "human_message", data: JSON.stringify({ threadId: 7, message: "hi" }) });
  assert.deepEqual(event, { type: "human_message", threadId: 7, message: "hi" });
});

test("an agent's own message is never fed back into the session as operator input", () => {
  assert.equal(
    parseChatStreamEvent({ event: "human_message", data: JSON.stringify({ threadId: 7, role: "agent", body: "my own reply" }) }),
    null,
  );
});
