import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { claudeConfigPath, workspaceRoot } from "./paths.js";

test("workspaceRoot: the container's WORK_WORKSPACE_ROOT wins over HOME", () => {
  assert.equal(workspaceRoot({ WORK_WORKSPACE_ROOT: "/app/workspace" }, "/app/state/home"), "/app/workspace");
});

test("workspaceRoot: unset or empty falls back to ~/projects (the bare-metal units)", () => {
  assert.equal(workspaceRoot({}, "/home/marek"), "/home/marek/projects");
  assert.equal(workspaceRoot({ WORK_WORKSPACE_ROOT: "" }, "/home/marek"), "/home/marek/projects");
});

test("claudeConfigPath: lives directly in HOME", () => {
  assert.equal(claudeConfigPath("/app/state/home"), "/app/state/home/.claude.json");
});

// The defaults rely on os.homedir() following $HOME, which is what moves
// every derived path into /app/state when compose sets HOME=/app/state/home.
test("defaults follow $HOME, as compose sets it", () => {
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const p = await import(${JSON.stringify(new URL("./paths.ts", import.meta.url).href)});
       console.log(JSON.stringify([p.workspaceRoot(), p.claudeConfigPath()]));`,
    ],
    { env: { PATH: process.env.PATH, HOME: "/app/state/home", WORK_WORKSPACE_ROOT: "/app/workspace" }, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(out), ["/app/workspace", "/app/state/home/.claude.json"]);
});

test("homelabRoot: WORK_HOMELAB_ROOT wins, else the org directory holding a homelab checkout", async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { homelabRoot } = await import("./paths.js");
  const ws = mkdtempSync(join(tmpdir(), "paths-"));
  assert.equal(homelabRoot({ WORK_WORKSPACE_ROOT: ws, WORK_HOMELAB_ROOT: "/elsewhere" }), "/elsewhere");
  assert.equal(homelabRoot({ WORK_WORKSPACE_ROOT: ws }), join(ws, "homelab-org"));
  mkdirSync(join(ws, "other-org", "app"), { recursive: true });
  mkdirSync(join(ws, "my-org", "homelab"), { recursive: true });
  assert.equal(homelabRoot({ WORK_WORKSPACE_ROOT: ws }), join(ws, "my-org"));
});
