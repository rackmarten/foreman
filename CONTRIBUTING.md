# Contributing

Thanks for taking the time to help. Bug reports and feature ideas go in
GitHub issues; pull requests are welcome too. For anything larger than a
small fix, open an issue first so we can agree on the approach.

This is the author's own tooling, published in case it is useful, so
changes that only make sense for a very different setup may be declined.

## Installing

foreman is installed together with pinboard: see pinboard's README for the
quickstart. This repo's own `docker-compose.yml` runs the full runner set
(dispatch, chat, pipeline) on a dedicated machine.

## Running the checks

```bash
cd app && npm ci && npm run typecheck && npm test
node --test scripts/*.test.mjs
docker compose build
```

CI (`.github/workflows/security-check.yml`) runs the same tests plus
shellcheck, yamllint, a JSON syntax check, hadolint, a gitleaks secret scan
and an image build on every push and pull request.

See `AGENTS.md` for the conventions agents (and people) follow in this repo.

## Commits

Keep commits focused, and start the subject with one of these prefixes:

| Prefix | Use for |
| --- | --- |
| `Add:` | new functionality or resource |
| `Edit:` | changes to existing functionality |
| `Fix:` | bug fixes |
| `Update:` | dependency, version, configuration or data updates |
| `Remove:` | removing functionality or a resource |
| `Docs:` | documentation-only changes |
| `DevOps:` | CI, packaging and other operational changes |

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
