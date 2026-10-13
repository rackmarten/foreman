// scripts/sync-claude-rules.sh against temp dirs, standing in for
// marek's ~/.claude (SEED_HOME) and foreman's checkout (APP_DIR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-claude-rules.sh");

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-claude-rules-"));
  const src = join(root, "seed", ".claude");
  const dest = join(root, "app", "state", "home", ".claude");
  put(join(src, "CLAUDE.md"), "# rules\n");
  put(join(src, "settings.json"), "{}\n");
  put(join(src, "agents", "tester.md"), "tester\n");
  put(join(src, "skills", "increment", "SKILL.md"), "increment\n");
  put(join(src, "skills", "synced", "dataviz", "SKILL.md"), "dataviz\n");
  put(join(src, "projects", "x", "session.jsonl"), "{}\n");
  put(join(src, ".credentials.json"), "{}\n");
  return { root, src, dest };
}

function run(f, args = ["--apply"], env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: join(f.root, "seed"),
      APP_DIR: join(f.root, "app"),
      CONTAINER_UID: String(process.getuid()),
      ...env,
    },
  });
  const m = r.stdout.match(/done: (\d+) change/);
  return { code: r.status, out: r.stdout, err: r.stderr, changes: m ? Number(m[1]) : null };
}

test("mirrors the four entries and nothing else, then a second run changes nothing", () => {
  const f = fixture();
  const first = run(f);
  assert.equal(first.code, 0, first.err);
  assert.ok(first.changes > 0);
  assert.equal(readFileSync(join(f.dest, "CLAUDE.md"), "utf8"), "# rules\n");
  assert.ok(existsSync(join(f.dest, "skills", "synced", "dataviz", "SKILL.md")));
  assert.ok(!existsSync(join(f.dest, "projects")));
  assert.ok(!existsSync(join(f.dest, ".credentials.json")));
  const second = run(f);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.changes, 0);
});

test("a changed file is updated, and never printed", () => {
  const f = fixture();
  run(f);
  put(join(f.src, "agents", "tester.md"), "tester v2 secret-ish\n");
  const r = run(f);
  assert.equal(r.changes, 1);
  assert.match(r.out, /~ agents\/tester\.md/);
  assert.doesNotMatch(r.out, /secret-ish/);
  assert.equal(readFileSync(join(f.dest, "agents", "tester.md"), "utf8"), "tester v2 secret-ish\n");
  assert.deepEqual(
    spawnSync("ls", ["-A", join(f.dest, "agents")], { encoding: "utf8" }).stdout.trim().split("\n"),
    ["tester.md"],
    "no temp file left behind",
  );
});

test("a skill removed from the source is deleted, and so is a stray file", () => {
  const f = fixture();
  run(f);
  rmSync(join(f.src, "skills", "increment"), { recursive: true });
  put(join(f.dest, "agents", "stray.md"), "stray\n");
  const r = run(f);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.changes, 2);
  assert.ok(!existsSync(join(f.dest, "skills", "increment")));
  assert.ok(!existsSync(join(f.dest, "agents", "stray.md")));
  assert.ok(existsSync(join(f.dest, "skills", "synced", "dataviz", "SKILL.md")));
  assert.equal(run(f).changes, 0);
});

test("a dry run lists changes but writes nothing", () => {
  const f = fixture();
  const r = run(f, []);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.changes > 0);
  assert.ok(!existsSync(f.dest));
});

test("refuses the wrong uid", () => {
  const f = fixture();
  const r = run(f, ["--apply"], { CONTAINER_UID: String(process.getuid() + 1) });
  assert.equal(r.code, 1);
  assert.match(r.err, /run this as uid/);
  assert.ok(!existsSync(f.dest));
});

test("refuses to run inside a container (FOREMAN_SERVICE set)", () => {
  const f = fixture();
  const r = run(f, ["--apply"], { FOREMAN_SERVICE: "dispatch" });
  assert.equal(r.code, 1);
  assert.match(r.err, /FOREMAN_SERVICE/);
  assert.ok(!existsSync(f.dest));
});
