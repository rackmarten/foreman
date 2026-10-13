import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "./sse.js";

function pushAll(parser: SseParser, chunks: string[]) {
  return chunks.flatMap((chunk) => parser.push(chunk));
}

test("parses a single well-formed event", () => {
  const events = new SseParser().push('event: human_message\ndata: {"threadId":1}\n\n');
  assert.deepEqual(events, [{ event: "human_message", data: '{"threadId":1}' }]);
});

test("defaults the event name to message when none is sent", () => {
  const events = new SseParser().push("data: hello\n\n");
  assert.deepEqual(events, [{ event: "message", data: "hello" }]);
});

test("joins multi-line data with newlines", () => {
  const events = new SseParser().push("event: x\ndata: line one\ndata: line two\ndata:\n\n");
  assert.deepEqual(events, [{ event: "x", data: "line one\nline two\n" }]);
});

test("ignores comment/heartbeat lines without dispatching", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": ping\n"), []);
  assert.deepEqual(parser.push(": ping\n\n"), []);
  assert.deepEqual(parser.push("event: interrupt\n"), []);
  assert.deepEqual(parser.push(": ping\n"), []);
  assert.deepEqual(parser.push("data: 1\n\n"), [{ event: "interrupt", data: "1" }]);
});

test("a blank line with no data buffered dispatches nothing but clears the event name", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: interrupt\n\n"), []);
  assert.deepEqual(parser.push("data: 1\n\n"), [{ event: "message", data: "1" }]);
});

test("reassembles an event split across chunk boundaries", () => {
  const parser = new SseParser();
  const chunks = ["event: perm", "ission_decision\ndat", 'a: {"requestId"', ':"r1"}\n', "\n"];
  assert.deepEqual(pushAll(parser, chunks), [
    { event: "permission_decision", data: '{"requestId":"r1"}' },
  ]);
});

test("reassembles an event split one character at a time", () => {
  const parser = new SseParser();
  const wire = "event: interrupt\ndata: 7\n\n";
  const events = pushAll(parser, wire.split(""));
  assert.deepEqual(events, [{ event: "interrupt", data: "7" }]);
});

test("handles CRLF line endings", () => {
  const events = new SseParser().push("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
  assert.deepEqual(events, [{ event: "x", data: "a\nb" }]);
});

test("handles a CRLF terminator split across two chunks", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: x\r"), []);
  assert.deepEqual(parser.push("\ndata: a\r"), []);
  // The bare \r here already terminates the blank line that dispatches the
  // event - the \n that follows it in the next chunk is part of the same
  // terminator and must not read as a second blank line.
  assert.deepEqual(parser.push("\n\r"), [{ event: "x", data: "a" }]);
  assert.deepEqual(parser.push("\ndata: b\r\n\r\n"), [{ event: "message", data: "b" }]);
});

test("treats a bare CR as a line terminator", () => {
  const events = new SseParser().push("event: x\rdata: a\r\r");
  assert.deepEqual(events, [{ event: "x", data: "a" }]);
});

test("strips exactly one leading space after the colon", () => {
  const events = new SseParser().push("data:  two spaces\n\n");
  assert.deepEqual(events, [{ event: "message", data: " two spaces" }]);
});

test("a field line with no colon is a field with an empty value", () => {
  const events = new SseParser().push("data\ndata: x\n\n");
  assert.deepEqual(events, [{ event: "message", data: "\nx" }]);
});

test("carries an id field through when the producer sends one", () => {
  const events = new SseParser().push("id: 42\nevent: x\ndata: a\n\n");
  assert.deepEqual(events, [{ event: "x", data: "a", id: "42" }]);
});

test("emits several events arriving in one chunk, in order", () => {
  const events = new SseParser().push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n: ping\n\n");
  assert.deepEqual(events, [
    { event: "a", data: "1" },
    { event: "b", data: "2" },
  ]);
});

test("does not dispatch until the blank line arrives", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: a\ndata: 1\n"), []);
  assert.deepEqual(parser.push("\n"), [{ event: "a", data: "1" }]);
});
