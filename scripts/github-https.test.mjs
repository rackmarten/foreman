// scripts/git-credential-github.sh and scripts/setup-host-git.sh,
// run against a throwaway APP_DIR and HOME so no real token or git config is
// touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const HELPER = join(SCRIPTS, "git-credential-github.sh");
const SETUP = join(SCRIPTS, "setup-host-git.sh");
const GITHUB = "protocol=https\nhost=github.com\n\n";

function appDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-https-"));
  mkdirSync(join(dir, "secrets"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function helper({ args = ["get"], input = GITHUB, env = {}, files = {} } = {}) {
  const res = spawnSync("bash", [HELPER, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, APP_DIR: appDir(files), ...env },
  });
  return res;
}

test("answers github.com with GH_TOKEN from the environment", () => {
  const res = helper({ env: { GH_TOKEN: "ghp_env" } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_env\n");
});

test("global.env wins over .env, quotes and export are stripped", () => {
  const res = helper({
    files: { ".env": "GH_TOKEN=ghp_dotenv\n", "secrets/global.env": "OTHER=1\nexport GH_TOKEN=\"ghp_old\"\nGH_TOKEN='ghp_global'\n" },
  });
  assert.match(res.stdout, /^password=ghp_global$/m);
});

test("falls back to .env when global.env has no token", () => {
  const res = helper({ files: { ".env": "GH_TOKEN=ghp_dotenv\n", "secrets/global.env": "OTHER=1\n" } });
  assert.match(res.stdout, /^password=ghp_dotenv$/m);
});

test("prints nothing for another host, protocol or operation", () => {
  for (const opts of [
    { input: "protocol=https\nhost=gitlab.com\n\n" },
    { input: "protocol=http\nhost=github.com\n\n" },
    { args: ["store"] },
    { args: ["erase"] },
  ]) {
    const res = helper({ ...opts, env: { GH_TOKEN: "ghp_env" } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  }
});

test("no token anywhere: no credential, a note on stderr, exit 0", () => {
  const res = helper();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /no GH_TOKEN/);
  assert.doesNotMatch(res.stderr, /ghp_/);
});

function setup(home) {
  return spawnSync("bash", [SETUP], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function globalConfig(home) {
  return spawnSync("git", ["config", "--global", "--list"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout;
}

test("setup-host-git: installs helper and insteadOf, keeps other config, idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "gh-https-home-"));
  writeFileSync(
    join(home, ".gitconfig"),
    '[init]\n\tdefaultBranch = main\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
  );
  const first = setup(home);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /3 change\(s\)/);
  const cfg = globalConfig(home);
  assert.match(cfg, /^init.defaultbranch=main$/m);
  assert.deepEqual(
    cfg.split("\n").filter((l) => l.startsWith("credential.")),
    ["credential.https://github.com.helper=", `credential.https://github.com.helper=!${HELPER}`],
  );
  assert.deepEqual(
    cfg.split("\n").filter((l) => l.startsWith("url.")),
    ["url.https://github.com/.insteadof=git@github.com:", "url.https://github.com/.insteadof=ssh://git@github.com/"],
  );

  const second = setup(home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already uses https/);
  assert.equal(globalConfig(home), cfg);
});

test("setup-host-git: a git@ remote resolves to https", () => {
  const home = mkdtempSync(join(tmpdir(), "gh-https-home-"));
  assert.equal(setup(home).status, 0);
  const res = spawnSync("git", ["ls-remote", "--get-url", "git@github.com:my-org/foreman.git"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(res.stdout.trim(), "https://github.com/my-org/foreman.git");
});
