// scripts/set-github-token.sh against stub curl and ssh, so its
// logic is covered without a real token, secret store or foreman. The stubs log
// every call's argv and stdin, which is how these tests check the token only
// ever travels on stdin and never reaches the terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "set-github-token.sh");
const TOKEN = "ghp_" + "A1b2C3d4".repeat(5);

const CURL_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
let out, method = "GET", url, stdin = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-o") out = argv[++i];
  else if (argv[i] === "-X") method = argv[++i];
  else if (/^https?:/.test(argv[i])) url = argv[i];
}
if (argv.includes("@-")) stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cmd: "curl", argv, method, path: new URL(url).pathname, stdin }) + "\\n");
const responses = JSON.parse(process.env.STUB_RESPONSES || "{}");
const r = responses[method + " " + new URL(url).pathname] || { code: 500, body: "no stub" };
fs.writeFileSync(out, typeof r.body === "string" ? r.body : JSON.stringify(r.body));
process.stdout.write(String(r.code));
`;

const SSH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cmd: "ssh", argv: process.argv.slice(2), stdin }) + "\\n");
process.stdout.write((process.env.STUB_SSH_OUT || "ls-remote ok") + "\\n");
process.exit(Number(process.env.STUB_SSH_EXIT || 0));
`;

const OK = {
  "GET /user": { code: 200, body: { login: "foreman-bot" } },
  "GET /api/secrets/GH_TOKEN": { code: 404, body: { error: "GH_TOKEN is not declared in secrets.keys" } },
  "POST /api/secrets": { code: 201, body: {} },
  "PUT /api/secrets/GH_TOKEN": { code: 200, body: {} },
  "POST /api/sync": { code: 200, body: {} },
};

function run({ args = [], input = TOKEN + "\n", responses = OK, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "set-gh-token-"));
  for (const [name, body] of [["curl", CURL_STUB], ["ssh", SSH_STUB]]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  const log = join(dir, "calls.jsonl");
  const res = spawnSync("bash", [SCRIPT, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      STUB_LOG: log,
      STUB_RESPONSES: JSON.stringify(responses),
      KEYRING_URL: "https://secrets.test",
      GITHUB_API: "https://api.github.test",
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { ...res, calls, output: res.stdout + res.stderr };
}

function assertTokenOnlyOnStdin(r) {
  assert.ok(!r.output.includes(TOKEN), "token reached the terminal");
  for (const call of r.calls) assert.ok(!call.argv.join(" ").includes(TOKEN), `token in ${call.cmd} argv`);
}

test("refuses any argument without repeating it, since it may be the token", () => {
  const r = run({ args: [TOKEN] });
  assert.equal(r.status, 2);
  assert.ok(!r.output.includes(TOKEN));
  assert.equal(r.calls.length, 0);
});

test("rejects input that is not a GitHub PAT at the read step", () => {
  const r = run({ input: "hunter2\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[read\] FAILED/);
  assert.equal(r.calls.length, 0);
});

test("--dry-run checks GitHub, the secret store and the container but stores nothing", () => {
  const r = run({ args: ["--dry-run"] });
  assert.equal(r.status, 0, r.output);
  assertTokenOnlyOnStdin(r);
  assert.deepEqual(
    r.calls.map((c) => (c.cmd === "curl" ? `${c.method} ${c.path}` : "ssh")),
    ["GET /user", "GET /api/secrets/GH_TOKEN", "ssh"],
  );
  assert.equal(r.calls[0].stdin, `Authorization: Bearer ${TOKEN}\n`);
  // The dry run hands the container the token itself, over ssh's stdin.
  assert.equal(r.calls[2].stdin, `${TOKEN}\n`);
  assert.match(r.stdout, /dry run passed/);
});

test("an undeclared GH_TOKEN is declared for foreman, then synced and verified from global.env", () => {
  const r = run();
  assert.equal(r.status, 0, r.output);
  assertTokenOnlyOnStdin(r);
  const declare = r.calls.find((c) => c.method === "POST" && c.path === "/api/secrets");
  assert.deepEqual(JSON.parse(declare.stdin), { name: "GH_TOKEN", group: "foreman-github", hosts: ["foreman"], value: TOKEN });
  const sync = r.calls.find((c) => c.path === "/api/sync");
  assert.deepEqual(JSON.parse(sync.stdin), { hosts: ["foreman"] });
  // A real run verifies what the sync delivered, so ssh gets an empty line.
  assert.equal(r.calls.at(-1).cmd, "ssh");
  assert.equal(r.calls.at(-1).stdin, "\n");
});

test("an already declared GH_TOKEN has its value replaced", () => {
  const r = run({ responses: { ...OK, "GET /api/secrets/GH_TOKEN": { code: 200, body: { name: "GH_TOKEN" } } } });
  assert.equal(r.status, 0, r.output);
  const put = r.calls.find((c) => c.method === "PUT");
  assert.deepEqual(JSON.parse(put.stdin), { value: TOKEN });
  assert.ok(!r.calls.some((c) => c.method === "POST" && c.path === "/api/secrets"));
});

test("a 403 from the secret store names the store step and the admin-only rule", () => {
  const r = run({ responses: { ...OK, "POST /api/secrets": { code: 403, body: { error: "admin only" } } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[store\] FAILED.*admin-only/);
  assert.ok(!r.calls.some((c) => c.path === "/api/sync"));
  assertTokenOnlyOnStdin(r);
});

test("a GitHub rejection stops before the secret store is touched", () => {
  const r = run({ responses: { ...OK, "GET /user": { code: 401, body: { message: "Bad credentials" } } } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[github\] FAILED: GitHub answered HTTP 401/);
  assert.equal(r.calls.length, 1);
});

test("verify failure output is redacted even if something echoes the token", () => {
  const r = run({ args: ["--dry-run"], env: { STUB_SSH_OUT: `bad credentials for ${TOKEN}`, STUB_SSH_EXIT: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[verify\] FAILED/);
  assert.match(r.stderr, /\[redacted\]/);
  assertTokenOnlyOnStdin(r);
});
