# Changelog

Notable changes to `foreman`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (Added/Changed/
Fixed/Removed), grouped by date rather than version: `main` deploys on every
push with `scripts/deploy.sh`, so there is no release boundary to version
against.

## 2026-10-13

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
