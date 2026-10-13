import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEightBallPrompt, createEightBallClient, EightBallNotConfiguredError } from "./eightball.js";

test("createEightBallClient throws a clear error when unconfigured", () => {
  const savedUrl = process.env.EIGHT_BALL_URL;
  const savedKey = process.env.EIGHT_BALL_API_KEY;
  delete process.env.EIGHT_BALL_URL;
  delete process.env.EIGHT_BALL_API_KEY;
  try {
    assert.throws(() => createEightBallClient("foreman-test"), EightBallNotConfiguredError);
  } finally {
    if (savedUrl !== undefined) process.env.EIGHT_BALL_URL = savedUrl;
    if (savedKey !== undefined) process.env.EIGHT_BALL_API_KEY = savedKey;
  }
});

test("createEightBallClient succeeds once both env vars are set", () => {
  const savedUrl = process.env.EIGHT_BALL_URL;
  const savedKey = process.env.EIGHT_BALL_API_KEY;
  process.env.EIGHT_BALL_URL = "http://llm-gateway:8000";
  process.env.EIGHT_BALL_API_KEY = "test-key";
  try {
    assert.doesNotThrow(() => createEightBallClient("foreman-test"));
  } finally {
    if (savedUrl === undefined) delete process.env.EIGHT_BALL_URL;
    else process.env.EIGHT_BALL_URL = savedUrl;
    if (savedKey === undefined) delete process.env.EIGHT_BALL_API_KEY;
    else process.env.EIGHT_BALL_API_KEY = savedKey;
  }
});

test("buildEightBallPrompt includes the task's title, type and description", () => {
  const prompt = buildEightBallPrompt({ title: "Summarize Q3 spend", description: "See the attached notes.", taskType: "research" });
  assert.match(prompt, /Summarize Q3 spend/);
  assert.match(prompt, /research/);
  assert.match(prompt, /See the attached notes\./);
});

test("buildEightBallPrompt handles a missing description", () => {
  const prompt = buildEightBallPrompt({ title: "Classify this batch", description: null, taskType: "maintenance" });
  assert.match(prompt, /no description provided/);
});
