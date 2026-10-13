import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claudeBin, inheritedEnv, resolveSpawnEnv, spawnEnvOrThrow } from "./spawn-env.js";

const peter = { id: 2, name: "peter", tokenEnvVar: "CLAUDE_OAUTH_TOKEN_PETER" };

test("a license with tokenEnvVar set passes that var's value as CLAUDE_CODE_OAUTH_TOKEN", () => {
  const result = resolveSpawnEnv(peter, { CLAUDE_OAUTH_TOKEN_PETER: "tok-2", CLAUDE_OAUTH_TOKEN: "tok-1" });
  assert.deepEqual(result, { ok: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-2" } });
});

test("no license or no tokenEnvVar refuses instead of falling back to a stored login", () => {
  assert.equal(resolveSpawnEnv(undefined, { CLAUDE_OAUTH_TOKEN: "x" }).ok, false);
  for (const tokenEnvVar of [null, undefined, "", "  "]) {
    const result = resolveSpawnEnv({ id: 1, name: "default", tokenEnvVar }, { CLAUDE_OAUTH_TOKEN: "x" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("tokenEnvVar"));
  }
  // process.env may carry an install credential (an agent run does); clear it.
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    assert.throws(() => spawnEnvOrThrow({ id: 1, name: "default", tokenEnvVar: null }), /no tokenEnvVar/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("tokenEnvVar set but missing or empty refuses, naming the var but never a value", () => {
  for (const env of [{}, { CLAUDE_OAUTH_TOKEN_PETER: "" }]) {
    const result = resolveSpawnEnv(peter, { ...env, CLAUDE_OAUTH_TOKEN: "other-seat-token" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("CLAUDE_OAUTH_TOKEN_PETER"));
    assert.ok(!result.ok && !result.reason.includes("other-seat-token"));
  }
  const prev = process.env.CLAUDE_OAUTH_TOKEN_PETER;
  delete process.env.CLAUDE_OAUTH_TOKEN_PETER;
  try {
    assert.throws(() => spawnEnvOrThrow(peter), /CLAUDE_OAUTH_TOKEN_PETER/);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_OAUTH_TOKEN_PETER = prev;
  }
});

test("inheritedEnv drops every seat's raw token var and the install credential, and keeps the rest", () => {
  const env = inheritedEnv({
    CLAUDE_OAUTH_TOKEN: "a",
    CLAUDE_OAUTH_TOKEN_PETER: "b",
    ANTHROPIC_API_KEY: "k",
    CLAUDE_CODE_OAUTH_TOKEN: "o",
    EIGHT_BALL_URL: "u",
    PATH: "/bin",
  });
  assert.deepEqual(env, { EIGHT_BALL_URL: "u", PATH: "/bin" });
});

test("without a license token var, the install-wide credential is used", () => {
  assert.deepEqual(resolveSpawnEnv(undefined, { ANTHROPIC_API_KEY: "k" }), { ok: true, env: { ANTHROPIC_API_KEY: "k" } });
  assert.deepEqual(resolveSpawnEnv({ id: 1, name: "default", tokenEnvVar: null }, { CLAUDE_CODE_OAUTH_TOKEN: "o" }), {
    ok: true,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "o" },
  });
  // An API key outranks an OAuth token, as in Claude Code itself.
  assert.deepEqual(resolveSpawnEnv(undefined, { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" }), {
    ok: true,
    env: { ANTHROPIC_API_KEY: "k" },
  });
});

test("a license with its own token var never falls back to the install credential", () => {
  assert.deepEqual(resolveSpawnEnv(peter, { CLAUDE_OAUTH_TOKEN_PETER: "tok-2", ANTHROPIC_API_KEY: "k" }), {
    ok: true,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-2" },
  });
  const missing = resolveSpawnEnv(peter, { ANTHROPIC_API_KEY: "k" });
  assert.equal(missing.ok, false);
});

test("claudeBin is CLAUDE_BIN or plain claude, never a per-user path", () => {
  const prev = process.env.CLAUDE_BIN;
  delete process.env.CLAUDE_BIN;
  try {
    assert.equal(claudeBin(), "claude");
  } finally {
    if (prev !== undefined) process.env.CLAUDE_BIN = prev;
  }
});

test("no spawn path wraps claude in sudo", () => {
  for (const file of ["runner.ts", "chat.ts", "chat-session.ts", "infra.ts", "spawn-env.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /["']sudo["']/, `${file} spawns sudo`);
    assert.doesNotMatch(source, /wrapSpawnForUser|CLAUDE_BIN_BY_USER/, file);
  }
});
