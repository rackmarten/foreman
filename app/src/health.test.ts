import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthTracker, type HealthReport } from "./health.js";

function tracker(fail = false) {
  const sent: HealthReport[] = [];
  const state = { fail };
  const t = new HealthTracker(async (r) => {
    if (state.fail) throw new Error("pinboard down");
    sent.push(r);
  });
  return { t, sent, state };
}

test("a first success is the baseline, not a recovery", async () => {
  const { t, sent } = tracker();
  assert.equal(await t.observe("8ball", true, "8ball"), null);
  assert.equal(sent.length, 0);
});

test("repeated failures report once, then one recovery", async () => {
  const { t, sent } = tracker();
  assert.equal(await t.observe("8ball", false, "8ball", "fetch failed"), "failing");
  assert.equal(await t.observe("8ball", false, "8ball", "fetch failed"), null);
  assert.equal(await t.observe("8ball", false, "8ball", "timeout"), null);
  assert.equal(await t.observe("8ball", true, "8ball"), "recovered");
  assert.equal(await t.observe("8ball", true, "8ball"), null);
  assert.deepEqual(sent, [
    { check: "8ball", status: "failing", project: "8ball", detail: "fetch failed" },
    { check: "8ball", status: "recovered", project: "8ball", detail: null },
  ]);
  // A second outage is news again.
  assert.equal(await t.observe("8ball", false, "8ball"), "failing");
});

test("checks are independent", async () => {
  const { t, sent } = tracker();
  await t.observe("seat:1", false, "foreman", "auth");
  await t.observe("seat:2", true, "foreman");
  await t.observe("seat:2", false, "foreman", "auth");
  await t.observe("seat:1", true, "foreman");
  assert.deepEqual(sent.map((r) => `${r.check} ${r.status}`), ["seat:1 failing", "seat:2 failing", "seat:1 recovered"]);
});

test("a report pinboard did not accept is retried on the next observation", async () => {
  const { t, sent, state } = tracker(true);
  assert.equal(await t.observe("disk", false, "foreman"), null);
  state.fail = false;
  assert.equal(await t.observe("disk", false, "foreman"), "failing");
  assert.equal(sent.length, 1);
});

test("detail is capped", async () => {
  const { t, sent } = tracker();
  await t.observe("8ball", false, "8ball", "x".repeat(2000));
  assert.equal(sent[0].detail?.length, 500);
});
