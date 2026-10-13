import { test } from "node:test";
import assert from "node:assert/strict";

import { integrationLines } from "./integrations.js";

const nothingOnDisk = (): boolean => false;

test("an install with only ANTHROPIC_API_KEY reports every optional integration off", () => {
  const lines = integrationLines({ ANTHROPIC_API_KEY: "k", WORK_WORKSPACE_ROOT: "/w" }, nothingOnDisk);
  assert.match(lines[0], /^claude: ANTHROPIC_API_KEY/);
  assert.equal(lines.filter((l) => l.includes(": off (")).length, 4);
  assert.ok(lines.every((l) => !l.includes("k\n") && !l.includes("=k")), "never prints a value");
});

test("no Claude credential at all is named, not thrown", () => {
  assert.match(integrationLines({}, nothingOnDisk)[0], /no credential/);
  assert.match(integrationLines({ CLAUDE_OAUTH_TOKEN_PETER: "t" }, nothingOnDisk)[0], /1 seat token/);
});

test("the homelab layout turns conventions and deploys on, under WORK_HOMELAB_ROOT when set", () => {
  const seen: string[] = [];
  const lines = integrationLines({ CLAUDE_CODE_OAUTH_TOKEN: "o", WORK_HOMELAB_ROOT: "/h", GH_TOKEN: "g", EIGHT_BALL_URL: "u", EIGHT_BALL_API_KEY: "a" }, (p) => {
    seen.push(p);
    return true;
  });
  assert.ok(lines.every((l) => !l.includes("off")));
  assert.deepEqual(seen, ["/h/homelab/AGENTS.md", "/h/homelab/scripts/deploy-service.sh"]);
});
