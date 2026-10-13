# Changelog

All notable changes to `foreman` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/foreman` at that version.

## [Unreleased]

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
