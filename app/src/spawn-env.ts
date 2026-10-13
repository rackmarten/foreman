// A past task (replacing #151's spawn-user.ts): every `claude` foreman spawns
// runs as foreman's own Linux user with its own ~/.claude config. A license
// only decides which OAuth token the spawn gets: its pinboard row names an env
// var (tokenEnvVar, e.g. CLAUDE_OAUTH_TOKEN_PETER) set in .env or synced into
// /app/secrets/global.env by a secret store, and the spawn receives that var's value as
// CLAUDE_CODE_OAUTH_TOKEN. No sudo, no second user's home. Never log the
// token value.
//
// There is no fallback to a stored ~/.claude login: with licenses left at
// tokenEnvVar null, every seat quietly billed whoever owned that login.
//
// a single-seat install with no secret store sets one credential in
// foreman's own environment instead: ANTHROPIC_API_KEY, or
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) for subscription auth.
// It only applies when no license names a token var of its own, so a seat
// with tokenEnvVar set never falls back to it.

export interface SpawnLicense {
  id: number;
  name: string;
  tokenEnvVar?: string | null;
}

// Env overrides a spawn merges on top of process.env.
export type SpawnEnv = Record<string, string>;

export type SpawnEnvResult = { ok: true; env: SpawnEnv } | { ok: false; reason: string };

// The install-wide credential, in precedence order (Claude Code itself prefers
// an API key over an OAuth token too).
export const INSTALL_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

function installCredential(env: NodeJS.ProcessEnv): SpawnEnv | null {
  for (const name of INSTALL_CREDENTIAL_VARS) {
    const value = env[name];
    if (value) return { [name]: value };
  }
  return null;
}

// No license or no tokenEnvVar -> the install-wide credential if one is set,
// else refuse. tokenEnvVar set but empty/missing in env -> refuse; falling
// back to anything else would bill the wrong subscription.
export function resolveSpawnEnv(
  license: SpawnLicense | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SpawnEnvResult {
  const varName = license?.tokenEnvVar?.trim();
  if (!varName) {
    const fallback = installCredential(env);
    if (fallback) return { ok: true, env: fallback };
  }
  if (!license) {
    return {
      ok: false,
      reason:
        "no license resolved for this spawn and neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set - set one in .env, or give the agent a pinboard license with a tokenEnvVar. Not falling back to a stored login.",
    };
  }
  if (!varName) {
    return {
      ok: false,
      reason: `license '${license.name}' (#${license.id}) has no tokenEnvVar and neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set - PATCH /api/licenses/${license.id} in pinboard with the env var holding its OAuth token (see foreman's README, Adding a license), or set one of those in .env. Not falling back to a stored login.`,
    };
  }
  const token = env[varName];
  if (!token) {
    return {
      ok: false,
      reason: `license '${license.name}' (#${license.id}) takes its OAuth token from ${varName}, which is not set in foreman's environment - add it to foreman's .env (or the secret store that writes secrets/global.env) and restart the foreman services. Not falling back to another license's login.`,
    };
  }
  return { ok: true, env: { CLAUDE_CODE_OAUTH_TOKEN: token } };
}

// Throwing variant for the chat paths, which have no rework status to park in.
export function spawnEnvOrThrow(license: SpawnLicense | null | undefined): SpawnEnv {
  const result = resolveSpawnEnv(license);
  if (!result.ok) throw new Error(result.reason);
  return result.env;
}

// The dispatcher's env minus every seat's raw token var
// (CLAUDE_OAUTH_TOKEN*) and the install-wide credential,
// so an agent can't read another seat's token with `env`, and an inherited
// ANTHROPIC_API_KEY can't outrank a seat's own token; the spawn gets back only
// the one resolveSpawnEnv chose. Everything else (the LLM gateway, ...) is inherited
// as-is.
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const install: readonly string[] = INSTALL_CREDENTIAL_VARS;
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("CLAUDE_OAUTH_TOKEN") && !install.includes(key)),
  );
}

export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}
