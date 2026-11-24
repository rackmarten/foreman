import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW_WIDTH, ago, formatNow, truncate } from "./now.js";
import type { NowStory } from "./pinboard.js";

const NOW = new Date("2026-03-01T12:00:00Z");

function story(overrides: Partial<NowStory> = {}): NowStory {
  return {
    id: 10,
    title: "Story title",
    status: "in_progress",
    project: { id: 1, slug: "alpha", name: "Alpha" },
    progress: { done: 3, total: 7 },
    running: [],
    waiting: [],
    next: null,
    sessions: [],
    interactiveCostUsd: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

test("formatNow: nothing active", () => {
  assert.equal(formatNow({ generatedAt: NOW.toISOString(), stories: [] }, NOW), "Nothing active.");
});

test("formatNow: one story with every kind of line", () => {
  const out = formatNow(
    {
      generatedAt: NOW.toISOString(),
      stories: [
        story({
          interactiveCostUsd: 4.2,
          running: [{ id: 12, title: "Running child", status: "in_progress" }],
          waiting: [
            { kind: "review", taskId: 11, title: "Needs a look" },
            { kind: "ask", taskId: 13, title: "Ask task", askId: 5, question: "Which port?" },
            { kind: "human", taskId: 14, title: "Plug in the disk" },
          ],
          next: { id: 15, title: "Next child" },
          sessions: [{ sessionId: "1a2b3c4d-5e6f", cwd: "/home/op/projects/alpha", lastSeenAt: "2026-03-01T10:00:00Z" }],
        }),
      ],
    },
    NOW,
    "/home/op",
  );
  assert.equal(
    out,
    [
      "alpha",
      "  #10 Story title (3/7) $4.20",
      "    ▶ #12 Running child",
      "    ! review #11 Needs a look",
      "    ! ask #13 Which port?",
      "    ! human #14 Plug in the disk",
      "    next #15 Next child",
      "    session 1a2b3c4d ~/projects/alpha (2h ago)",
    ].join("\n"),
  );
});

test("formatNow: an ask without a question falls back to the task title, no cost when zero", () => {
  const out = formatNow(
    { generatedAt: "", stories: [story({ waiting: [{ kind: "ask", taskId: 3, title: "Ask task" }] })] },
    NOW,
  );
  assert.match(out, /^ {2}#10 Story title \(3\/7\)$/m);
  assert.match(out, /! ask #3 Ask task$/m);
});

test("formatNow: groups by project, waiting stories and their projects first", () => {
  const beta = { id: 2, slug: "beta", name: "Beta" };
  const out = formatNow(
    {
      generatedAt: "",
      stories: [
        story({ id: 1, title: "Quiet alpha" }),
        story({ id: 2, title: "Quiet beta", project: beta }),
        story({ id: 3, title: "Waiting beta", project: beta, waiting: [{ kind: "human", taskId: 9, title: "Do it" }] }),
        story({ id: 4, title: "Waiting alpha", waiting: [{ kind: "review", taskId: 8, title: "Look" }] }),
      ],
    },
    NOW,
  );
  const headers = out.split("\n").filter((l) => /^#?\S/.test(l));
  assert.deepEqual(headers, ["beta", "alpha"]);
  const storyIds = [...out.matchAll(/^ {2}#(\d+) /gm)].map((m) => Number(m[1]));
  assert.deepEqual(storyIds, [3, 2, 4, 1]);
  assert.match(out, /\n\nalpha\n/);
});

test("formatNow: every line fits the phone width, long titles and paths are cut", () => {
  const long = "A very long title that goes on and on well past the width of a phone";
  const out = formatNow(
    {
      generatedAt: "",
      stories: [
        story({
          title: long,
          interactiveCostUsd: 123.456,
          running: [{ id: 99999, title: long, status: "in_progress" }],
          waiting: [{ kind: "review", taskId: 99998, title: long }],
          next: { id: 99997, title: long },
          sessions: [
            { sessionId: "abcdef0123456789", cwd: `/srv/${"deep/".repeat(12)}repo`, lastSeenAt: "2026-02-20T12:00:00Z" },
            { sessionId: "0011223344556677", cwd: null, lastSeenAt: "2026-02-19T12:00:00Z" },
          ],
        }),
      ],
    },
    NOW,
  );
  for (const line of out.split("\n")) assert.ok([...line].length <= NOW_WIDTH, `too wide: '${line}'`);
  assert.match(out, /^ {2}#10 A very long.*… \(3\/7\) \$123\.46$/m);
  assert.match(out, /session abcdef01 …(deep\/)+repo \(9d ago\)$/m);
  assert.match(out, /session 00112233 \? \(10d ago\)$/m);
});

test("truncate and ago", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("exactly10!", 10), "exactly10!");
  assert.equal(truncate("eleven char", 10), "eleven ch…");
  assert.equal(truncate("multi\n line", 20), "multi line");
  assert.equal(ago("2026-03-01T11:59:30Z", NOW), "now");
  assert.equal(ago("2026-03-01T11:15:00Z", NOW), "45m ago");
  assert.equal(ago("2026-02-28T12:00:00Z", NOW), "24h ago");
  assert.equal(ago("2026-02-25T12:00:00Z", NOW), "4d ago");
  assert.equal(ago("not a date", NOW), "?");
});

test("formatNow: finished sessions are listed under Can archive, a missing field is none", () => {
  const finishedSessions = [
    {
      sessionId: "1a2b3c4d-0000",
      cwd: "/home/op/projects/alpha",
      lastSeenAt: "2026-03-01T10:00:00Z",
      stories: [{ id: 12, title: "Done story", status: "done" }],
    },
    {
      sessionId: "99887766-0000",
      cwd: `/home/op/${"deep/".repeat(10)}repo`,
      lastSeenAt: "2026-03-01T09:00:00Z",
      stories: Array.from({ length: 6 }, (_, i) => ({ id: 1000 + i, title: "x", status: "rejected" })),
    },
  ];
  assert.equal(
    formatNow({ generatedAt: "", stories: [], finishedSessions: finishedSessions.slice(0, 1) }, NOW, "/home/op"),
    "Nothing active.\n\nCan archive:\n  1a2b3c4d ~/projects/alpha (#12 done)",
  );
  const out = formatNow({ generatedAt: "", stories: [story()], finishedSessions }, NOW, "/home/op");
  assert.match(out, /\(3\/7\)\n\nCan archive:\n {2}1a2b3c4d ~\/projects\/alpha \(#12 done\)\n {2}99887766 …/);
  for (const line of out.split("\n")) assert.ok([...line].length <= NOW_WIDTH, `too wide: '${line}'`);
  assert.doesNotMatch(formatNow({ generatedAt: "", stories: [story()] }, NOW), /Can archive/);
  assert.doesNotMatch(formatNow({ generatedAt: "", stories: [story()], finishedSessions: [] }, NOW), /Can archive/);
});
