# Agent Instructions

> **This repository is public.** Everything committed here, including commit
> messages, PR titles and descriptions, is world-readable. Don't name private
> hosts, services, task numbers or personal addresses; the CI leak check fails
> on them.

## Project

foreman is the agent runner of the pinboard/foreman pair: a TypeScript CLI
(`work`, `app/src`) whose long-running loops (`dispatch`, `chat`,
`pipeline`) run as Docker Compose services built from this repo's
`Dockerfile`. It is installed together with pinboard (see pinboard's
README); this repo's README covers its internals.

## General rules

- Read the project documentation before making changes.
- Do not modify `.env` or other local configuration files unless explicitly requested.
- Do not commit secrets, credentials, tokens, private keys, or local configuration.
- Prefer small, focused changes and preserve existing conventions.
- Run the tests before considering a change complete:
  `cd app && npm run typecheck && npm test`, and `node --test scripts/*.test.mjs`.
- Commit subjects start with `Add:`, `Edit:`, `Fix:`, `Update:`, `Remove:`,
  `Docs:` or `DevOps:` (see CONTRIBUTING.md). Record what shipped in
  CHANGELOG.md under a dated heading.
- This repository is public: no private host names, addresses, internal
  ticket numbers or personal details in code, comments, docs or commit
  messages. CI runs a leak check (`.github/scripts/leak-check.sh`).
- Text foreman writes to GitHub for a repo in `PUBLIC_GITHUB_ORGS` goes
  through `formatPrTitle`/`formatPrBody`/`squashMergeArgs`; keep new
  GitHub-facing text behind the same `isPublicRepo` check.

## Secrets

`.claude/settings.json` denies reading or editing `.env`. Do not work around
that. A new credential goes into `.env` and is referenced as `${VAR}`.

foreman is privileged by design: it holds a Claude credential, a GitHub
token and, where it deploys, SSH keys. Treat changes to what agents may run
(`agent-settings.ts`, `permission-gate.ts`, `spawn-env.ts`) with matching
care.

## Ownership

Never run a recursive `chown` on the checkout: `state/` and task workdirs
are owned by the container's UID 1000.

## Deployment and health

Do not deploy unless explicitly asked. Deploy with `./scripts/deploy.sh`,
never a bare `docker compose up` on a running install: it skips a busy
service and handles foreman deploying itself. `./scripts/healthcheck.sh`
verifies it.
