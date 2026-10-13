import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePrSync, doneButOpenComment, parseGhPrState } from "./pull-requests.js";

const pr = { url: "https://github.com/my-org/sandbox/pull/7", state: "open" as const };

test("parseGhPrState maps gh's upper-case states and rejects junk", () => {
  assert.equal(parseGhPrState('{"state":"MERGED"}'), "merged");
  assert.equal(parseGhPrState('{"state":"CLOSED"}'), "closed");
  assert.equal(parseGhPrState('{"state":"OPEN"}'), "open");
  assert.equal(parseGhPrState('{"state":"DRAFT"}'), null);
  assert.equal(parseGhPrState("not json"), null);
});

test("decidePrSync patches the row to what GitHub says", () => {
  assert.deepEqual(decidePrSync({ pr, ghState: "merged" }), { patch: "merged", comment: null });
  assert.deepEqual(decidePrSync({ pr, ghState: "closed" }), { patch: "closed", comment: null });
  assert.deepEqual(decidePrSync({ pr, ghState: null }), { patch: null, comment: null });
});

test("decidePrSync flags a done task whose PR is still open, once", () => {
  assert.deepEqual(decidePrSync({ pr, ghState: "open", taskStatus: "done", comments: [] }), { patch: null, comment: doneButOpenComment(pr.url) });
  assert.deepEqual(decidePrSync({ pr, ghState: "open", taskStatus: "done", comments: [{ body: doneButOpenComment(pr.url) }] }), { patch: null, comment: null });
  for (const status of ["review", "rework", "awaiting_ci"]) {
    assert.deepEqual(decidePrSync({ pr, ghState: "open", taskStatus: status, comments: [] }), { patch: null, comment: null });
  }
});
