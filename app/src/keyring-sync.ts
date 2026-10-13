// a merged keyring.json scope change reaches a host only when the secret
// store syncs that host's /app/secrets/global.env. Nothing did that between
// the merge and the consumer's deploy, so a consumer once deployed with its
// new vars empty and failed. The pipeline now syncs every host whose rendered
// name set changed, after the secret store itself deploys (its service renders
// from its own checkout) and before any other repo in the same task deploys.

export interface KeyringConfig {
  groups?: Record<string, string[]>;
  hosts?: Record<string, string[]>;
}

// The variable names the secret store renders for a host: the union of its groups.
// An unknown group contributes nothing here; render.mjs rejects it at sync.
export function renderedNames(config: KeyringConfig, host: string): Set<string> {
  const groups = config.groups ?? {};
  const names = new Set<string>();
  for (const group of config.hosts?.[host] ?? []) {
    for (const name of groups[group] ?? []) names.add(name);
  }
  return names;
}

// Every host in `after` whose rendered name set differs from `before`: a host
// that gained or lost a group, a group that gained or lost a name, a new host.
// A host removed from keyring.json has nothing left to render, so it is not
// synced (its old global.env stays until someone cleans it up by hand).
export function hostsNeedingSync(before: KeyringConfig, after: KeyringConfig): string[] {
  const changed: string[] = [];
  for (const host of Object.keys(after.hosts ?? {})) {
    const was = renderedNames(before, host);
    const now = renderedNames(after, host);
    if (was.size !== now.size || [...now].some((name) => !was.has(name))) changed.push(host);
  }
  return changed.sort();
}

// agent-api.sh prints the response body, then `HTTP <code>` on its own line.
// The sync route answers {ok, exitCode, output}; anything else is a failure.
export function parseSyncResponse(stdout: string): { ok: boolean; detail: string } {
  const match = /\nHTTP (\d{3})\s*$/.exec(stdout);
  const status = match ? Number(match[1]) : 0;
  const body = match ? stdout.slice(0, match.index) : stdout;
  if (status !== 200) return { ok: false, detail: `HTTP ${status || "?"}: ${body.trim()}` };
  try {
    const parsed = JSON.parse(body) as { ok?: boolean; output?: string };
    return { ok: parsed.ok === true, detail: (parsed.output ?? "").trim() };
  } catch {
    return { ok: false, detail: `unreadable response: ${body.trim()}` };
  }
}
