# Changelog

All notable changes to `foreman` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/foreman` at that version.

## [Unreleased]

### Added
- README documents foreman's own SSH key (`state/home/.ssh/foreman_ed25519`)
  and its fingerprint, installed next to the operator's key on every service
  container so its access can be revoked separately.
- Pinboard watchdog in the dispatch process: probes pinboard's `/health` and
  `/api/plan` every 30s, pushes an ntfy alert after 10 minutes of continuous
  failure and again on recovery, and tracks repair-run bounds (one per
  outage, two per rolling 24h) in a state file that survives restarts. The
  repair hook is a no-op for now and only logs `repair would start`.
- The pipeline retries a post-merge deploy that failed on Docker Hub's pull
  rate limit instead of handing the task back to an agent: it stays in
  `deploying` and is retried after 30, 60 and 120 minutes, with a comment per
  retry saying when the next attempt is. The retry state is read back from
  those comments, so it survives a restart. A fourth rate-limited failure
  falls back to the usual `deploy_failed` handback.
- `FOREMAN_CI_TIMEOUT_MINUTES` sets how long the pipeline waits for a PR's
  CI run.

### Changed
- The pipeline's CI wait defaults to 30 minutes (was 10), so a cold build on
  a slow runner is no longer read as a CI failure.

### Fixed
- Dispatch skipped a queued task silently when no enabled seat had an
  eligible agent for it (for example, the only agent's executor was not
  `cli`), leaving it in `queued` forever. It now logs
  `dispatch: task <id> has no eligible agent (...)` once per task per process,
  naming what the task needs. Tasks owned by another seat are still skipped
  quietly.

## [0.1.0] - 2026-10-13

### Added
- First public release. foreman is the agent runner behind pinboard: a
  TypeScript `work` CLI whose `dispatch`, `chat` and `pipeline` loops run as
  Docker Compose services. It picks up queued pinboard tasks, runs Claude Code
  in a fresh per-task clone (plus any related repos) under a permission gate
  and per-seat credentials, pushes a branch and opens a pull request, then
  waits for CI, merges, deploys and health-checks when the project allows it,
  handing failures back to an agent with the evidence. Planning chats,
  agent questions to the operator, budget gating, a leak gate for repos in
  public orgs and an optional LLM gateway executor for non-code tasks round it
  out. `.env` with a Claude credential and a GitHub token is enough to start;
  every other integration logs whether it is on.

[Unreleased]: https://github.com/rackmarten/foreman/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rackmarten/foreman/releases/tag/v0.1.0
