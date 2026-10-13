import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostsNeedingSync, parseSyncResponse, renderedNames, type KeyringConfig } from "./keyring-sync.js";
import { keyringHostsForPr, runDeploySequence, type DeploySequenceDeps, type PipelineRepo } from "./pipeline.js";

const before: KeyringConfig = {
  groups: { ai: ["EIGHT_BALL_URL"], mail: ["SMTP_PASSWORD"], identity: ["HOMELAB_TOKEN_KEYS"], vpn: ["VPN_KEY"] },
  hosts: { "vpn-box": ["vpn"], media: ["ai", "mail"], dash: ["identity"], backup: ["identity"] },
};
// vpn-box gains two groups, media loses one, dash and backup are
// unchanged (backup's group list is reordered, which renders the same names).
const after: KeyringConfig = {
  groups: before.groups,
  hosts: { "vpn-box": ["vpn", "mail", "identity"], media: ["ai"], dash: ["identity"], backup: ["identity", "identity"] },
};

test("renderedNames is the union of a host's groups", () => {
  assert.deepEqual([...renderedNames(after, "vpn-box")].sort(), ["HOMELAB_TOKEN_KEYS", "SMTP_PASSWORD", "VPN_KEY"]);
  assert.equal(renderedNames(after, "nope").size, 0);
});

test("hostsNeedingSync: a host that gained a group and one that lost one, not the unchanged ones", () => {
  assert.deepEqual(hostsNeedingSync(before, after), ["media", "vpn-box"]);
  assert.deepEqual(hostsNeedingSync(after, after), []);
});

test("hostsNeedingSync: a group gaining a name affects every host subscribed to it; new hosts sync, removed ones do not", () => {
  const grown: KeyringConfig = { groups: { ...before.groups, identity: ["HOMELAB_TOKEN_KEYS", "NEW"] }, hosts: { ...before.hosts, push: ["ai"] } };
  assert.deepEqual(hostsNeedingSync(before, grown), ["backup", "dash", "push"]);
  const shrunk: KeyringConfig = { groups: before.groups, hosts: { media: ["ai", "mail"] } };
  assert.deepEqual(hostsNeedingSync(before, shrunk), []);
});

test("parseSyncResponse reads agent-api.sh's body + HTTP line", () => {
  assert.deepEqual(parseSyncResponse('{"ok":true,"exitCode":0,"output":"synced vpn-box"}\nHTTP 200\n'), { ok: true, detail: "synced vpn-box" });
  assert.deepEqual(parseSyncResponse('{"ok":false,"exitCode":1,"output":"ssh: vpn-box unreachable"}\nHTTP 200\n'), {
    ok: false,
    detail: "ssh: vpn-box unreachable",
  });
  assert.equal(parseSyncResponse('{"error":"unauthorized"}\nHTTP 401\n').ok, false);
  assert.equal(parseSyncResponse("garbage\nHTTP 200\n").ok, false);
});

test("keyringHostsForPr diffs keyring.json across the PR's merge commit", () => {
  const root = mkdtempSync(join(tmpdir(), "keyring-sync-"));
  try {
    const repo = join(root, "secrets");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "keyring.json"), JSON.stringify(before));
    git("add", ".");
    git("commit", "-qm", "before");
    writeFileSync(join(repo, "keyring.json"), JSON.stringify(after));
    git("commit", "-qam", "after");
    const sha = git("rev-parse", "HEAD");
    const exec = (cmd: string, args: string[]) => {
      if (cmd === "gh") return { ok: true, stdout: `${sha}\n`, stderr: "" };
      try {
        return { ok: true, stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" }), stderr: "" };
      } catch (err) {
        return { ok: false, stdout: "", stderr: String((err as { stderr?: string }).stderr ?? err) };
      }
    };
    assert.deepEqual(keyringHostsForPr("https://github.com/x/secrets/pull/1", "secrets", exec, root), ["media", "vpn-box"]);
    assert.ok("error" in (keyringHostsForPr("pr", "secrets", () => ({ ok: false, stdout: "", stderr: "gh down" }), root) as object));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Acceptance criterion 2: the sequencing itself (the secret store's PR and
// the consumer's PR merged in the same pass, consumer listed first).
const repos: PipelineRepo[] = [
  { repoSlug: "vpn-box", prUrl: "https://github.com/x/vpn-box/pull/2", prId: 2 },
  { repoSlug: "secrets", prUrl: "https://github.com/x/secrets/pull/1", prId: 1 },
];

function recorder(overrides: Partial<DeploySequenceDeps> = {}) {
  const events: string[] = [];
  const deps: DeploySequenceDeps = {
    deploy: async (slug) => {
      events.push(`deploy ${slug}`);
      return { ran: true, value: { ok: true, stdout: "", stderr: "" } };
    },
    isSecretStore: (slug) => slug === "secrets",
    keyringHosts: () => ["vpn-box"],
    syncHosts: (hosts) => {
      events.push(`sync ${hosts.join(",")}`);
      return { ok: true, detail: "" };
    },
    ...overrides,
  };
  return { events, deps };
}

test("runDeploySequence deploys the secret store first, syncs its affected hosts, then deploys the rest", async () => {
  const { events, deps } = recorder();
  const outcome = await runDeploySequence(repos, 0, deps);
  assert.equal(outcome.moved, "verifying");
  assert.deepEqual(events, ["deploy secrets", "sync vpn-box", "deploy vpn-box"]);
});

test("runDeploySequence skips the sync when keyring.json's change affects no host, and without a secret store", async () => {
  const none = recorder({ keyringHosts: () => [] });
  await runDeploySequence(repos, 0, none.deps);
  assert.deepEqual(none.events, ["deploy secrets", "deploy vpn-box"]);
  const plain = recorder();
  await runDeploySequence([repos[0]], 0, plain.deps);
  assert.deepEqual(plain.events, ["deploy vpn-box"]);
});

test("a failed secret store sync parks the task with the failure as repair context and deploys nothing else", async () => {
  const { events, deps } = recorder({
    syncHosts: (hosts) => {
      events.push(`sync ${hosts.join(",")}`);
      return { ok: false, detail: "ssh: connect to host vpn-box: timed out" };
    },
  });
  const outcome = await runDeploySequence(repos, 0, deps);
  assert.deepEqual(events, ["deploy secrets", "sync vpn-box"]);
  assert.equal(outcome.moved, "rework");
  assert.equal(outcome.repair?.reason, "deploy_failed");
  assert.match(outcome.repair?.context ?? "", /vpn-box: timed out/);
  assert.match(outcome.comment ?? "", /deploy-service\.sh vpn-box/);
});

test("an unreadable keyring.json diff parks too", async () => {
  const { events, deps } = recorder({ keyringHosts: () => ({ error: "no merge commit" }) });
  const outcome = await runDeploySequence(repos, 0, deps);
  assert.deepEqual(events, ["deploy secrets"]);
  assert.equal(outcome.moved, "rework");
  assert.match(outcome.repair?.context ?? "", /no merge commit/);
});
