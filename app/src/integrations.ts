// what this install has configured, as one line per integration,
// logged when a daemon starts. Everything except a Claude credential is
// optional; a missing one shows up here as "off" rather than as an error the
// first time something reaches for it.
import { existsSync } from "node:fs";
import { conventionsFile, homelabRoot } from "./paths.js";
import { INSTALL_CREDENTIAL_VARS } from "./spawn-env.js";

export function integrationLines(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string[] {
  const install = INSTALL_CREDENTIAL_VARS.find((name) => env[name]);
  const seats = Object.keys(env).filter((key) => key.startsWith("CLAUDE_OAUTH_TOKEN") && env[key]).length;
  const claude = install
    ? `claude: ${install} for runs without a license token var${seats ? `, plus ${seats} seat token(s)` : ""}`
    : seats
      ? `claude: ${seats} seat token(s), only for licenses naming them`
      : "claude: no credential - set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or runs are refused";
  return [
    claude,
    env.GH_TOKEN ? "github: GH_TOKEN set" : "github: off (no GH_TOKEN - runs cannot push or open pull requests)",
    env.EIGHT_BALL_URL && env.EIGHT_BALL_API_KEY
      ? "llm gateway: on"
      : "llm gateway: off (set EIGHT_BALL_URL and EIGHT_BALL_API_KEY for 8ball-executor agents)",
    exists(conventionsFile(env))
      ? `workspace conventions: ${conventionsFile(env)}`
      : `workspace conventions: off (no ${conventionsFile(env)})`,
    exists(`${homelabRoot(env)}/homelab/scripts/deploy-service.sh`)
      ? "deploys: homelab deploy-service.sh"
      : `deploys: off (no ${homelabRoot(env)}/homelab/scripts/deploy-service.sh; a merged task is left for a manual deploy)`,
  ];
}

export function logIntegrations(prefix: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const line of integrationLines(env)) console.log(`${prefix}: ${line}`);
}
