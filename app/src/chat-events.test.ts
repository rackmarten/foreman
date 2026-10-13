import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatEventBatcher } from "./chat-events.js";
import type { ChatEventInput } from "./pinboard.js";

interface Harness {
  batcher: ChatEventBatcher;
  sent: ChatEventInput[][];
  fire: () => void;
  timers: number;
}

function harness(overrides: { maxBatchSize?: number; maxTextChars?: number; send?: (e: ChatEventInput[]) => Promise<unknown> } = {}): Harness {
  const sent: ChatEventInput[][] = [];
  let pending: (() => void) | null = null;
  let timers = 0;
  const h: Harness = {
    sent,
    timers: 0,
    fire: () => {
      const fn = pending;
      pending = null;
      if (fn) fn();
    },
    batcher: new ChatEventBatcher({
      send: overrides.send ?? (async (events) => { sent.push(events); }),
      maxBatchSize: overrides.maxBatchSize ?? 50,
      maxTextChars: overrides.maxTextChars ?? 4000,
      flushIntervalMs: 250,
      setTimer: (fn) => { timers += 1; pending = fn; return timers; },
      clearTimer: () => { pending = null; },
    }),
  };
  Object.defineProperty(h, "timers", { get: () => timers });
  return h;
}

test("buffers instead of sending per event, then flushes on the timer", async () => {
  const h = harness();
  h.batcher.add({ kind: "text_delta", payload: { text: "a" }, turn: 1 });
  h.batcher.add({ kind: "tool_start", payload: { name: "Bash" }, turn: 1 });
  assert.equal(h.sent.length, 0);
  h.fire();
  await h.batcher.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, 2);
});

test("coalesces consecutive text deltas in the same turn into one event", async () => {
  const h = harness();
  for (const text of ["Hel", "lo ", "world"]) h.batcher.add({ kind: "text_delta", payload: { text }, turn: 3 });
  await h.batcher.flush();
  assert.deepEqual(h.sent, [[{ kind: "text_delta", payload: { text: "Hello world" }, turn: 3, seq: 1 }]]);
});

test("does not coalesce across turns or across kinds", async () => {
  const h = harness();
  h.batcher.add({ kind: "text_delta", payload: { text: "a" }, turn: 1 });
  h.batcher.add({ kind: "text_delta", payload: { text: "b" }, turn: 2 });
  h.batcher.add({ kind: "thinking", payload: { text: "c" }, turn: 2 });
  h.batcher.add({ kind: "thinking", payload: { text: "d" }, turn: 2 });
  await h.batcher.flush();
  assert.deepEqual(h.sent[0].map((e) => [e.kind, e.turn, (e.payload as { text: string }).text]), [
    ["text_delta", 1, "a"],
    ["text_delta", 2, "b"],
    ["thinking", 2, "cd"],
  ]);
});

test("a tool_start between two text deltas breaks the merge run", async () => {
  const h = harness();
  h.batcher.add({ kind: "text_delta", payload: { text: "a" }, turn: 1 });
  h.batcher.add({ kind: "tool_start", payload: { name: "Read" }, turn: 1 });
  h.batcher.add({ kind: "text_delta", payload: { text: "b" }, turn: 1 });
  await h.batcher.flush();
  assert.deepEqual(h.sent[0].map((e) => e.kind), ["text_delta", "tool_start", "text_delta"]);
});

test("flushes immediately once the batch size threshold is reached", async () => {
  const h = harness({ maxBatchSize: 3 });
  h.batcher.add({ kind: "tool_start", payload: { name: "a" } });
  h.batcher.add({ kind: "tool_start", payload: { name: "b" } });
  assert.equal(h.sent.length, 0);
  h.batcher.add({ kind: "tool_start", payload: { name: "c" } });
  await h.batcher.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, 3);
});

test("flushes immediately once buffered delta text passes the char threshold", async () => {
  const h = harness({ maxTextChars: 10 });
  h.batcher.add({ kind: "text_delta", payload: { text: "12345" }, turn: 1 });
  assert.equal(h.sent.length, 0);
  h.batcher.add({ kind: "text_delta", payload: { text: "67890" }, turn: 1 });
  await h.batcher.flush();
  assert.deepEqual(h.sent, [[{ kind: "text_delta", payload: { text: "1234567890" }, turn: 1, seq: 1 }]]);
});

test("assigns a monotonic seq across batches", async () => {
  const h = harness();
  h.batcher.add({ kind: "turn_start", payload: {} });
  await h.batcher.flush();
  h.batcher.add({ kind: "turn_end", payload: {} });
  await h.batcher.flush();
  assert.deepEqual(h.sent.flat().map((e) => e.seq), [1, 2]);
});

test("a flush with nothing buffered sends nothing", async () => {
  const h = harness();
  await h.batcher.flush();
  assert.equal(h.sent.length, 0);
});

test("a send failure is swallowed and does not stop later batches", async () => {
  let calls = 0;
  const sent: ChatEventInput[][] = [];
  const h = harness({
    send: async (events) => {
      calls += 1;
      if (calls === 1) throw new Error("pinboard restarting");
      sent.push(events);
    },
  });
  h.batcher.add({ kind: "error", payload: { message: "x" } });
  await h.batcher.flush();
  h.batcher.add({ kind: "turn_end", payload: {} });
  await h.batcher.flush();
  assert.equal(calls, 2);
  assert.deepEqual(sent.flat().map((e) => e.kind), ["turn_end"]);
});

test("batches land in the order they were buffered even when sends are slow", async () => {
  const order: string[] = [];
  const h = harness({
    send: async (events) => {
      const kind = events[0].kind;
      await new Promise((resolve) => setTimeout(resolve, kind === "turn_start" ? 20 : 1));
      order.push(kind);
    },
  });
  h.batcher.add({ kind: "turn_start", payload: {} });
  const first = h.batcher.flush();
  h.batcher.add({ kind: "turn_end", payload: {} });
  const second = h.batcher.flush();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["turn_start", "turn_end"]);
});

test("close flushes what is buffered and then ignores further events", async () => {
  const h = harness();
  h.batcher.add({ kind: "text_delta", payload: { text: "bye" }, turn: 1 });
  await h.batcher.close();
  assert.equal(h.sent.length, 1);
  h.batcher.add({ kind: "text_delta", payload: { text: "late" }, turn: 1 });
  await h.batcher.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.batcher.pending, 0);
});

test("only one timer is scheduled per buffered run", async () => {
  const h = harness();
  h.batcher.add({ kind: "tool_start", payload: { name: "a" } });
  h.batcher.add({ kind: "tool_start", payload: { name: "b" } });
  assert.equal(h.timers, 1);
  await h.batcher.flush();
  h.batcher.add({ kind: "tool_start", payload: { name: "c" } });
  assert.equal(h.timers, 2);
});
