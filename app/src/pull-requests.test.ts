import assert from "node:assert/strict";
import { test } from "node:test";
import { completeWithPrSync, decidePrSync, doneButOpenComment, parseGhPrState, type GhPrState } from "./pull-requests.js";

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

// A fake pinboard that refuses to complete while a row is open, like the real one.
const OPEN_PR_409 = "POST /tasks/7/complete -> 409 Conflict: task has an open pull request";

function fakePinboard(rows: { id: number; url: string; state: GhPrState }[]) {
  const patches: [number, GhPrState][] = [];
  return {
    patches,
    deps: (ghState: (url: string) => GhPrState | { reason: string }) => ({
      listPrs: async () => rows.map((r) => ({ ...r, taskId: 7 }) as never),
      updateState: async (_taskId: number, prId: number, state: GhPrState) => {
        patches.push([prId, state]);
        rows.find((r) => r.id === prId)!.state = state;
        return { status: 200 };
      },
      ghState,
    }),
    complete: async () => {
      if (rows.some((r) => r.state === "open")) throw new Error(OPEN_PR_409);
      return "done";
    },
  };
}

test("completeWithPrSync records a PR GitHub already merged, then completes", async () => {
  const pb = fakePinboard([
    { id: 1, url: "https://github.com/o/r/pull/195", state: "open" },
    { id: 2, url: "https://github.com/o/r/pull/190", state: "closed" },
  ]);
  const asked: string[] = [];
  const out = await completeWithPrSync(7, pb.complete, pb.deps((url) => (asked.push(url), "merged")));
  assert.equal(out.result, "done");
  assert.deepEqual(pb.patches, [[1, "merged"]]);
  assert.deepEqual(asked, ["https://github.com/o/r/pull/195"]);
  assert.deepEqual(out.notes, ["PR #195 was merged on GitHub; synced before completing"]);
});

test("completeWithPrSync keeps the 409 for a PR GitHub still has open", async () => {
  const pb = fakePinboard([{ id: 1, url: "https://github.com/o/r/pull/195", state: "open" }]);
  await assert.rejects(completeWithPrSync(7, pb.complete, pb.deps(() => "open")), { message: OPEN_PR_409 });
  assert.deepEqual(pb.patches, []);
});

test("completeWithPrSync falls back to the 409 with the reason when gh fails", async () => {
  const pb = fakePinboard([{ id: 1, url: "https://github.com/o/r/pull/195", state: "open" }]);
  await assert.rejects(completeWithPrSync(7, pb.complete, pb.deps(() => ({ reason: "gh is not installed" }))), {
    message: `${OPEN_PR_409} (GitHub check skipped: gh is not installed)`,
  });
  assert.deepEqual(pb.patches, []);
});

test("completeWithPrSync completes a task with no PRs without asking GitHub", async () => {
  const pb = fakePinboard([]);
  const out = await completeWithPrSync(7, pb.complete, pb.deps(() => assert.fail("gh should not be called")));
  assert.deepEqual(out, { result: "done", notes: [] });
});
