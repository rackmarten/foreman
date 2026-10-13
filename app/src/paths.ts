// the filesystem locations foreman derives from its environment,
// in one place. work.ts, runner.ts, chat.ts and pipeline.ts each used to
// compute WORKSPACE_ROOT on their own; they now all call workspaceRoot().
//
// In the container HOME is /app/state/home and compose sets
// WORK_WORKSPACE_ROOT=/app/workspace, so a project's localPath (org/name)
// resolves to /app/workspace/<org>/<name>. On the bare-metal units neither
// is set and the old defaults (~/projects, ~/.claude.json) still apply.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One level above the org clones: a project's localPath is always org/name
// An empty WORK_WORKSPACE_ROOT counts as unset.
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.WORK_WORKSPACE_ROOT || join(home, "projects");
}

// Where the operator's workspace-wide repos live (deploy-service.sh, the
// conventions file agents read first, the secret store's checkout):
// WORK_HOMELAB_ROOT, else the one org directory in the workspace that holds a
// `homelab` checkout (the first by name if several do). An install without
// one gets a path with nothing in it, which turns those features off.
export function homelabRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.WORK_HOMELAB_ROOT) return env.WORK_HOMELAB_ROOT;
  const root = workspaceRoot(env, home);
  let orgs: string[] = [];
  try {
    orgs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "homelab")))
      .map((d) => d.name)
      .sort();
  } catch {
    // No workspace yet.
  }
  return join(root, orgs[0] ?? "homelab-org");
}

// Workspace conventions an agent run is told to read before anything else.
export function conventionsFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(homelabRoot(env, home), "homelab", "AGENTS.md");
}

// Claude Code's user config, where runner.ts patches workspace trust (task
// #138). homedir() follows $HOME, so this moves with HOME into /app/state.
export function claudeConfigPath(home: string = homedir()): string {
  return join(home, ".claude.json");
}
