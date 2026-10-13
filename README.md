# foreman

The agent runner of the pinboard/foreman pair. It polls
[pinboard](https://github.com/rackmarten/pinboard) for queued tasks, runs
each one as a Claude Code session in its own clone of the repository, opens
a pull request, and then watches CI, merges and deploys according to the
task's autonomy level. It only ever calls out (to pinboard, GitHub and the
machines it deploys to); nothing calls into it.

> **Scope.** This is the author's homelab tooling, published in case it is
> useful.

**Installing:** see pinboard's README. Its quickstart compose runs pinboard
and foreman's `dispatch` loop together from published images. This README
covers foreman's own internals, and the full runner set (`dispatch`, `chat`,
`pipeline`, `housekeeping`) in this repo's `docker-compose.yml` for a
dedicated machine.

This repo's own deployment, for `scripts/deploy.sh` and
`scripts/healthcheck.sh`:

- Hostname: `foreman`
- Working directory: `/app`

## Rebuild foreman from scratch

This rebuilds foreman on any Linux machine with Docker, from this README
alone. Nothing here assumes Proxmox, an LXC, systemd, a tailnet
or a secret store; where the operator's own install adds something, it
says so.

### What foreman is, and what it needs from outside

foreman is the three runner services in `docker-compose.yml` (`dispatch`,
`chat`, `pipeline`) plus a nightly `housekeeping` job, all one image built
from this repo. Everything below is outside it:

| Dependency | What foreman uses it for | Without it |
| --- | --- | --- |
| Docker Engine with the compose plugin, socket at `/var/run/docker.sock` | Runs the services. Agent runs also use this same daemon for their own `docker compose` | Nothing runs |
| A [pinboard](https://github.com/rackmarten/pinboard) instance at `PINBOARD_URL` (default `http://pinboard:8095`), with a project per repo (`localPath`, `repoUrl`) and at least one agent and license | The task queue. All three services poll it; foreman calls out to it, nothing calls in | `healthcheck.sh` fails at `work task list`; no task is ever dispatched |
| A Claude credential: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Every agent run and chat turn | Runs refuse to start, naming the missing variable (`spawn-env.ts`) |
| A GitHub account and a personal access token in `GH_TOKEN` (repo and workflow access to every repo foreman works on) | `gh pr create`, CI status, merge; every `git` fetch and push to GitHub, in the containers and on the host ("GitHub access" below) | Runs finish but cannot push or open a PR; the pipeline cannot merge |
| An SSH key pair in `state/home/.ssh`, public half in `authorized_keys` on every machine foreman deploys to (not on GitHub, a past task) | SSH from `deploy-service.sh`, `work root` | Deploys fail at SSH; ordinary tasks are unaffected |
| A homelab workspace repo at `$WORK_HOMELAB_ROOT/homelab` (default: the `homelab` checkout under whichever `/app/workspace/<org>/` holds one): `AGENTS.md`, `scripts/deploy-service.sh`, `scripts/leak-check.sh`, `public-leak-patterns.txt`, `targets/` | The "read the conventions" prompt line, post-merge deploys, the leak check before pushing to a public repo | No conventions line; a merged task is left for a manual deploy; pushes to a repo in `PUBLIC_GITHUB_ORGS` are blocked |

Optional, homelab-only: `EIGHT_BALL_URL`/`EIGHT_BALL_API_KEY` (only for
agents whose executor is the LLM gateway), `secrets/global.env` rendered by a secret store
(read after `.env`), a host `crontab` (nightly housekeeping and the Claude
rules mirror), a host `~/.claude` to mirror into the containers, and
rootproxy on a Proxmox host for `work root` (`WORK_ROOT_HOST`, default
`root@homelab`). Each is skipped cleanly when absent, and `dispatch`, `chat`
and `pipeline` log one line per integration at startup (`claude:`,
`github:`, `llm gateway:`, `workspace conventions:`, `deploys:`) saying which are
on.

### Configuration: `.env`, mounts and credentials

`.env.example` is the contract; it marks each variable required or
optional. The variables, by who reads them:

| Variable | Required | Read by |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | One of the two, unless every pinboard license names its own `tokenEnvVar` | `spawn-env.ts`; stripped from what agents inherit |
| `CLAUDE_OAUTH_TOKEN_<SEAT>` | Only for a license whose `tokenEnvVar` names it | `spawn-env.ts` |
| `GH_TOKEN` | Yes, for anything beyond dry runs | `gh`, and `git` through it (also on the host, "GitHub access") |
| `PINBOARD_URL` | If pinboard is not at `http://pinboard:8095` | `work`, `deploy.sh`, `sweep-orphaned-worktrees.sh` |
| `DOCKER_GID` | If the host's `docker` group is not gid 991 (`getent group docker \| cut -d: -f3`) | Image build; without the right gid the containers cannot use the socket |
| `WORK_TASK_ROOT` | No (default `/app/tasks`) | Task clones; mounted at the identical path inside and out |
| `FOREMAN_WORKSPACE_DIR` | No (default `./workspace`) | Host path of the workspace clone |
| `WORK_HOMELAB_ROOT` | No (default: the `/app/workspace/<org>` that holds a `homelab` checkout) | Where the homelab repo above is looked up |
| `PUBLIC_GITHUB_ORGS` | No (default `rackmarten`; empty for none) | Leak check and PR text ("Public repositories") |
| `HOMELAB_USER` | No (default `marek`) | SSH user for deploys and releases |
| `CLAUDE_MODEL`, `EIGHT_BALL_URL`, `EIGHT_BALL_API_KEY`, `EIGHT_BALL_PROJECT`, `FOREMAN_MIN_FREE_GB` | No | Model choice, LLM gateway executor (and the pinboard project its outage alert is filed under), disk-space guard |
| `FOREMAN_HOST_SSH`, `HOUSEKEEPING_SCHEDULE`, `CLAUDE_RULES_SCHEDULE` | No | `deploy.sh` when foreman deploys itself, cron schedules |

Bootstrap-only (environment of `scripts/bootstrap-container-state.sh`, not
`.env`): `SSH_KEY`, `GIT_USER_NAME`, `GIT_USER_EMAIL`, `SEED_HOME`,
`CONTAINER_UID`.

Mounts (`docker-compose.yml`), all relative to the checkout unless set
otherwise:

| Host | Container | Holds |
| --- | --- | --- |
| `/var/run/docker.sock` | same | The host's Docker daemon |
| `${WORK_TASK_ROOT:-/app/tasks}` | same path | Per-task clones. Must be the identical path, because agents' own bind mounts resolve on the host |
| `${FOREMAN_WORKSPACE_DIR:-./workspace}` | `/app/workspace` | The workspace clone, `<org>/<repo>` |
| `./state` | `/app/state` | `HOME` (`state/home`): `.claude`, `.ssh`, `.gitconfig`; logs |
| `./secrets` | `/app/secrets` (read-only) | Optional `global.env` |

### Procedure

1. **Host.** Install Docker Engine with the compose plugin, git and crontab
   (optional). Create a user with uid 1000 in the `docker` group; the
   containers run as uid 1000, and running the steps below as that user is
   what gets file ownership right without a `chown`.
2. **Clone** this repo to `/app` (any path works, but `WORK_TASK_ROOT`
   defaults to `/app/tasks`, so pick another checkout path only together
   with setting `WORK_TASK_ROOT`):

       git clone https://github.com/rackmarten/foreman.git /app
       cd /app

3. **Configure.** `cp .env.example .env`, then set the Claude credential,
   `GH_TOKEN`, `PINBOARD_URL` and `DOCKER_GID` (see the table above).
4. **SSH key and git identity.** Put the key pair foreman should use at
   `~/.ssh/id_ed25519` (or export `SSH_KEY=<path>`), and either have a
   global git identity or export `GIT_USER_NAME`/`GIT_USER_EMAIL`. Add the
   public key to every deploy target. GitHub does not need it: git reaches
   GitHub over https with `GH_TOKEN` ("GitHub access" below).
5. **Restore or seed state.** With a backup, restore `state/` and `tasks/`
   (see "State layout" below) first. Then
   `./scripts/bootstrap-container-state.sh` fills in only what is missing:
   `state/home` with the SSH key, `known_hosts`, `.gitconfig` and a copy of
   `~/.claude` (no login), and an empty `workspace/`.
6. **Workspace.** Clone each repo a pinboard project points at as
   `workspace/<org>/<repo>`, matching that project's `localPath`. For deploys
   and the leak check, clone the homelab repo to
   `workspace/<org>/homelab` (or set `WORK_HOMELAB_ROOT`).
7. **Start:** `./scripts/deploy.sh`. It seeds again (a no-op now), builds the
   image, brings `dispatch`, `chat` and `pipeline` up one at a time, and
   installs the cron entries where `crontab` exists. A bare
   `docker compose up -d` also works on a fresh machine, since nothing is
   busy yet.
8. **Verify:** `./scripts/healthcheck.sh` passes when `dispatch` and
   `pipeline` are running and `work task list` reaches pinboard from inside
   the image. Then read the integration lines:
   `docker compose logs dispatch | head -20`. A Claude smoke test:
   `docker compose run --rm dispatch claude -p 'reply with the single word ok'`.

What this rebuild does not bring back: in-flight task attempts whose
`tasks/` was not restored (requeue those tasks in pinboard), and chat sessions
without their transcripts in `state/home/.claude/projects` (they start
fresh rather than resuming).

### Running it anywhere (summary)

Since a past task foreman needs nothing but Docker:

    cp .env.example .env    # set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) and GH_TOKEN
    ./scripts/deploy.sh

- **One required secret pair.** A Claude credential, `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for subscription auth,
  is used by every run whose pinboard license names no token variable of its
  own (`spawn-env.ts`); a license with `tokenEnvVar` set never falls back to
  it. `GH_TOKEN` lets runs push and open pull requests.
- **Everything else is optional.** `dispatch`, `chat` and `pipeline` each
  log one line per integration when they start (`claude:`, `github:`,
  `llm gateway:`, `workspace conventions:`, `deploys:`), saying which are on.
- **Where things live.** The workspace clone is `./workspace` unless
  `FOREMAN_WORKSPACE_DIR` points elsewhere; task workdirs are
  `WORK_TASK_ROOT`. The homelab conventions file and `deploy-service.sh` are
  looked up under `WORK_HOMELAB_ROOT` (default: the
  `/app/workspace/<org>` holding a `homelab` checkout); without them a run skips the conventions
  line and a merged task is left for a manual deploy.
- **Host pieces are skipped when absent.** `scripts/deploy.sh` retires
  systemd units only where they exist, installs its cron entries only where
  `crontab` exists, and mirrors `~/.claude` into the containers only where
  the host has one. On a host that has them all of that still happens, and
  `secrets/global.env` (from a secret store) is still read after `.env`.

## What actually runs here

Since a past task foreman's autonomous runner is a Docker
Compose deployment like the rest of the org: three long-running services
from one locally built image (`foreman-runner:local`), plus a housekeeping
job behind a compose profile.

| Service | Command | Replaced |
| --- | --- | --- |
| `dispatch` | `work dispatch` | `foreman-dispatch.service` |
| `chat` | `work chat daemon` | `foreman-chat.service` |
| `pipeline` | `work pipeline watch` | `foreman-pipeline.service` |
| `housekeeping` (profile, run nightly by a host crontab entry) | `scripts/housekeeping.sh --apply` | `foreman-housekeeping.timer` |

`scripts/deploy.sh` builds the image and brings each service up on it,
one at a time and never while it is busy (see "Deploying" below);
`scripts/healthcheck.sh` checks `dispatch` and `pipeline` are running and
that `work task list` reaches pinboard from the image. No systemd `--user`
unit runs any of this any more; "Rollback to the systemd units" below is
the way back. The image, mounts and state layout are described in
"Container image" below.

Around that, the LXC is still the operator's bare-metal base of operations:

- **Node.js 22** (`~/.local-node`, the official Linux x64 tarball extracted
  under `$HOME`, not apt/NodeSource - deliberately rootless, since `marek`
  on this LXC only has prompted (not passwordless) `sudo`). Added to `PATH`
  via `~/.zshenv` (not `~/.zshrc` - `.zshenv` is sourced for
  non-interactive shells too, which matters for plain `ssh foreman
  '<command>'` invocations and VSCode Remote-SSH tasks, not just an
  interactive login).
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`, installed
  into that same Node tree). This is the second machine in the org with
  Claude Code and Claude credentials on it, after `sandbox` - see the
  workspace `AGENTS.md`'s "Remote access policy" for why. Authentication
  itself is a manual step (`claude setup-token`, run once as `marek` over
  SSH) - not something an agent session can complete for itself.
- **A full clone of the homelab workspace** (`~/projects/<org>/`,
  every org repo cloned as a sibling of `homelab/`) - the "Git clones of
  the org" I2 asked for, structured identically to the WSL desktop's own
  workspace clone so the two stay interchangeable as a base of operations.
- **SSH access to every other LXC** in the org, as `marek` (the same key
  pattern the desktop already uses - `foreman`'s own `~/.ssh/id_ed25519`,
  appended to every other LXC's `authorized_keys` in I2). See
  `lxc-configurator/.env.example`'s `SSH_PUBLIC_KEY` comment - a future
  LXC provisioned from scratch should get both the desktop's and
  foreman's key from day one, not have foreman's appended by hand
  afterward like this first round was.
- **The `work` CLI** (`app/`) - a client for pinboard's API. Read-only:
  `work task list [--project=] [--status=] [--type=] [--executor=]`,
  `work task show <id>`, `work task next`. `task list` also takes
  `--parent=<id>` and `--label=<name>` (the label filter runs client-side).
  On a story, `task show` lists its children in run order (a child after
  every sibling it `depends_on`, then by priority) with status, executor
  and any open blocked-by; on a child it names the story. Grooming (task
  #407): `work task update <id> [--title= --description= --status= --type=
  --executor= --priority= --autonomy= --effort= --parent=<id>|none]`
  PATCHes only the given fields, and `--parent` replaces the existing
  parent relation; `work task label <id> add|remove <name>` resolves the
  label by name and creates it on add; `work task create` takes repeatable
  `--label=<name>` and `--depends-on=<id>`. Zero-autonomy write path (I3):
  `work task claim <id>`, `work task comment <id> <text...>`,
  `work task handoff <id> [--completed=] [--changed=] [--verified=]
  [--problems=] [--discovered=] [--next=] [--effort=] [--cost=]
  [--duration-ms=] [--turns=] [--agent=<agentName>]`,
  `work task complete <id>` - every write stamps `actorType`/`actorName`
  provenance (`WORK_ACTOR_TYPE`/`WORK_ACTOR_NAME` env vars, default
  `human`/the OS username) onto a `task_events` row, per
  pinboard-initial-idea.md's "Agent Users / Provenance". Also
  `work plan sync <project-slug> [--force]`, which writes a minimal
  generated `PLAN.md` (current task, open tasks, latest handoff - nothing
  private) into that project's own repo under
  `~/projects/<localPath>/` (e.g. `~/projects/my-org/pinboard/` -
  `WORK_WORKSPACE_ROOT` overrides the base). Refuses to overwrite a file
  that isn't itself a previous
  `work plan sync` output (checked via a marker comment on the first line)
  unless `--force` is passed - this is what stops it from ever clobbering
  a hand-written plan like this project's or pinboard's own `PLAN.md`.
  The services run the copy built into the image; on the host, `work` is
  an `npm link` for the operator (see "Local development" below). Talks to pinboard over the tailnet
  directly (`PINBOARD_URL`, default `http://pinboard:8095`), not through
  reverse-proxy. `PINBOARD_URL` is the origin; every API call goes to
  `${PINBOARD_URL}/api/...` (a past task).
- **Agent routing** (I12a, `app/src/routing.ts`) picks which agent runs a
  task before the runner below (or the dispatcher) spawns anything.
  `resolveAgentForTask` matches pinboard's `routing_rules` (task type
  and/or label, both nullable = wildcard) against the task, picks the
  highest-`priority` match, ties broken by the matched agent's own
  `routingWeight`, and falls back to `foreman-runner` when nothing matches
  - zero rules configured is a no-op. `work task run <id> --agent=<name>`
  still pins a specific agent directly, skipping routing entirely. Which
  executor actually runs the task depends on the resolved agent's own
  `executor` field: `"cli"` is the `claude -p` pipeline below; `"8ball"`
  (I12b, `app/src/eightball.ts`) is a separate, much simpler path for
  non-code tasks (research summaries, classification, digest writing) -
  no worktree, no git, no PR, just a free-text result from an LLM gateway's
  shared local models posted back as a comment/handoff. Needs
  `EIGHT_BALL_URL`/`EIGHT_BALL_API_KEY` set, in `.env` or in
  `/app/secrets/global.env` (loaded by every service's second `env_file`
  entry, see `docker-compose.yml`); recreate the services after changing
  either -
  without them an 8ball-routed task fails with a clear error and goes to
  `rework`, same as any other misconfigured agent. The budget gate
  (entirely about Claude's own $/window) is deliberately not consulted on
  this path, since a gateway run costs nothing - gating free local work
  during a Claude budget crunch would block it for no reason.
- **The agent runner** (`work task run <id>`, I4a) spawns an unattended
  `claude -p` session against a task and, once it finishes, pushes its
  branch and opens a PR itself (see `app/src/runner.ts`). Since a past task
  that is where the session ends: the runner moves the task to
  `awaiting_ci` and returns, and the post-PR pipeline poller below does
  the rest. Nothing about CI, merging or deploying holds an agent, a
  lease or a concurrency slot any more. A task the pipeline hands back
 comes through this same path as an ordinary `queued` task,
  with the failed stage and its evidence prepended to the prompt - see
  the poller's failure table below. While a session
  is live, pinboard's "Running workers" screen (I4c) can request it stop:
  `stop` sends SIGINT and gives the session up to 30s to exit on its own -
  the runner still tries to parse a real handoff out of that exit, in case
  it managed to wrap up cleanly - before escalating to SIGTERM/SIGKILL;
  `kill` sends SIGKILL immediately. Either way the task ends up back in
  `rework` for a human, since the operator explicitly asked the run to
  stop rather than for another attempt to start. foreman only reaches out
  to pinboard, never the reverse, so this is a poll (every 5s, alongside
  the existing lease renewal) of a `controlAction` field on the task, not
  a push.
- **The dispatcher** (`work dispatch`, I7) removes the last manual step:
  it polls pinboard every 60s (`--interval-seconds` to change) and starts
  whatever the plan says may run.

  As of a past task foreman does not decide that for itself. pinboard's
  `GET /plan/next` returns the task(s) that may start, already gated on the
  $ period budget, the open 5h session window and the concurrency limits
  (see pinboard's README, "the work plan"). The
  ranking and eligibility rules that used to live here - priority order,
  `executorMode`/`autonomyLevel`, the `depends_on` check - moved there with
  it, so the Plan screen the operator reads and the dispatcher that acts
  cannot drift into disagreeing, and the copy that is visible is the one
  that decides.

  What this loop still decides for itself is only what pinboard cannot
  know: which of the offered tasks are already in flight here. A task's
  status flips to `executing` when its claim lands *inside* `runTask`, so
  between starting one and that claim landing pinboard would still offer
  it and would not count it against concurrency - hence `selectStartable`,
  which filters on what is in flight and caps at the plan's own
  concurrency figure.

  When the plan reports that the session window's budget is spent but the
  window has not expired, it hands back a `waitUntil` and the loop sleeps
  until then instead of re-earning the same refusal every 60s
  (`computeSleepMs`, floored at the normal interval and capped at 5
  minutes). The cap is short on purpose: the window is pinboard's estimate,
  and the operator can reset it from the Plan screen when it is wrong, which
  the loop then notices within 5 minutes. Re-polling only asks pinboard,
  never Claude. A refusal is logged
  only when it changes - "nothing runnable in the queue" is this system's
  normal resting state, not an incident worth a line every minute.

  `--override` isn't offered here: an unattended loop never overspends the
  budget on its own, and it never ignores a `depends_on` either - only a
  human running `work task run <id> --override` for one specific task can
  do either (see "Override" below). SIGINT/SIGTERM stop the loop between
  cycles without cutting off a task that's already running.

  `work plan status` prints what the dispatcher is about to see - budget
  left, the open session window, and which task(s) may start or why none
  may. foreman has no UI of its own, so this is how the plan is read from
  the box that acts on it.

- **Override.** `work task run <id> --override` is the operator's explicit
  "run it anyway". It skips the *budget* gates (the period budget and the
  session window) and, on this direct path only, the `depends_on` gate -
  before #140 this path never checked dependencies at all, so routing it
  through the plan would otherwise have silently removed that escape
  hatch. It never skips the concurrency limit: that stops the system running
  more paid agents at once than the operator allowed, whereas overspending
  is a decision the operator is entitled to make.

- **Multi-license spawn (a past task, replacing #151's per-user sudo spawn).**
  An agent belongs to exactly one pinboard `License` (`GET /licenses`).
  Every run and chat turn executes as foreman's own Linux user (`marek`)
  with its own `~/.claude` config; the license only decides which OAuth token
  the `claude` spawn gets. A license's `tokenEnvVar` names an env var (never
  the token itself) set in `.env` or synced into `/app/secrets/global.env`, which
  every foreman unit loads via `EnvironmentFile`. `app/src/spawn-env.ts`
  passes that var's value to the child as `CLAUDE_CODE_OAUTH_TOKEN`, which
  overrides the stored login (a bad token fails with 401, no fallback).
  `runner.ts`, `chat.ts`, `chat-daemon.ts`/`chat-session.ts` all go through
  it, and the child inherits the rest of `process.env` too, so the rest of
  global.env reaches every seat's agent. The one
  exception is the raw `CLAUDE_OAUTH_TOKEN*` vars, which are stripped so an
  agent only ever sees its own seat's token.

  | License | `tokenEnvVar` |
  | --- | --- |
  | 1 (`default`, marek) | `CLAUDE_OAUTH_TOKEN` |
  | 2 (`peter`) | `CLAUDE_OAUTH_TOKEN_PETER` |

  - No license, `tokenEnvVar` null, or the var missing or empty: the task
    run is refused and parked in `rework` with a comment saying what is
    missing (a chat turn errors the same way). It never falls back to a
    stored `~/.claude` login, which would bill the wrong subscription.
    Until 2026-09-29 a null `tokenEnvVar` did fall back, and with both
    licenses left at null every seat's usage landed on marek's login.
  - Sessions all live in one `~/.claude`, so a retained session is
    resumable by any license (`isSessionResumableBy`); `claudeSessionLicenseId`
    is still recorded for accounting.

  **Adding a license:**

  1. As the seat's owner, on any machine with Claude Code: `claude
     setup-token`, and copy the token it prints.
  2. Add it to foreman's environment as `CLAUDE_OAUTH_TOKEN_<NAME>`: in
     `.env`, or in the secret store that renders `/app/secrets/global.env`
     (then sync it to foreman).
  3. Recreate the services so they reload global.env (compose reads
     `env_file` when a container is created, not on restart), each one
     while it is idle:
     `docker compose up -d --no-deps --force-recreate dispatch chat pipeline`.
  4. Create the license in pinboard (or PATCH an existing one) with
     `tokenEnvVar` set to that var's name:
     `curl -X PATCH http://pinboard:8095/api/licenses/<id> -H 'content-type: application/json' -d '{"tokenEnvVar":"CLAUDE_OAUTH_TOKEN_<NAME>"}'`.

  **Rotation:** setup-token tokens last about a year. Rerun `claude
  setup-token` as the owner, update the stored value, sync and restart the
  units as above. The license row doesn't change.

  **Leftovers from the old sudo model, safe to delete by hand on foreman:**
  the `/etc/sudoers.d/foreman-dispatch` drop-in (`sudo rm
  /etc/sudoers.d/foreman-dispatch`); a `CLAUDE_BIN_BY_USER` line in
  `/app/.env` if one was added there; and the two bridge edits in
  `/home/peter` that got peter-runner working under sudo: `env.PATH` in
  peter's `~/.claude/settings.json`, and the npm token export before the
  interactive guard in peter's `~/.bashrc`. The `peter` Linux
  user itself is still needed for peter's own interactive sessions, not for
  foreman runs. `License.linuxUser` is no longer used for spawning.

  Also routing-affecting: `routing.ts`'s `resolveAgentForTask` now filters
  both rule-matched and fallback agents to `agent.autonomyLevel >=
  task.autonomyLevel` and returns `null` (not a degenerate synthetic agent)
  when nothing clears that floor - `runTask` then refuses the task outright
  with a clear error instead of claiming a lease for an agent that was
  always going to fail its own post-hoc autonomy check. The `--agent=`
  explicit path bypasses this filter by design (an operator naming an agent
  by hand is a deliberate override) and still relies on that same post-hoc
  check as its only guard, same as before this task.

  **Model and effort.** Every task run passes `--model` and
  `--effort` explicitly, so nothing is inherited from the run user's
  `~/.claude/settings.json`. Model: the pinboard agent row's `model`, else
  `CLAUDE_MODEL`, else `claude-opus-5-5`. Effort: `CLAUDE_EFFORT`, else
  `medium`. Chat threads use their own `effort` when set and the same default
  otherwise. Both variables go in `foreman-dispatch`'s environment. Opus 5.5
  needs Claude Code 2.1.280 or newer for every run user.

  `WORKSPACE_ROOT` stays shared across every license for this increment -
  every agent, whichever license it runs under, still reads/writes the same
  `~/projects/` checkouts.

- **Dispatching per license.** Having a second seat spawn
  correctly is not the same as having it *start* anything, and until this
  task it never did. `dispatchOnce` asked `GET /plan/next` with no
  `licenseId`, which pinboard answers for its own default license, so every
  cycle read one seat's budget and session window - and any task that then
  routed to the other seat's agent was started on a budget check that had
  never looked at that seat at all. Two things fix it:

  - The loop polls **once per enabled license** (`GET /licenses`, filtered to
    `enabled`), so each seat's own budget period, session window and
    refusal reason are evaluated on their own. `work plan status` prints the
    same thing, a block per seat. When several seats have nothing to start,
    the loop sleeps until the *earliest* of their `waitUntil`s, since
    sleeping past the first one to free up would idle it for no reason. That
    long sleep only happens when *every* seat is waiting: a seat with an
    empty queue, a full concurrency slot or a failed poll keeps the loop on
    the normal interval, so one seat at its 5h limit never holds up work
    the other seat could run. A seat in an infra
    cooldown counts as waiting until its cooldown ends. A
    pinboard with no licenses at all (older than #150) still gets a single
    unscoped poll, exactly as before.
  - `resolveAgentForTask` takes an optional `preferLicenseId`. A routing
    rule still wins whenever it matches - that is the operator's explicit
    intent - but an **unrouted** task now falls back to the *asking* seat's
    own runner rather than always to the global `foreman-runner`. That
    fallback is restricted to `executor: "cli"` agents on that license, so a
    seat's LLM gateway executor (free local inference, deliberately reachable
    only through an explicit rule) and its `cli-host` chat persona are never
    picked up as one. A seat with no eligible `cli` agent starts nothing
    rather than borrowing another seat's.

  Because routing is what decides which seat pays, `dispatchOnce` resolves
  it *before* starting anything (one `GET /tasks/:id` per startable
  candidate, for the task's type and labels, which the plan candidate
  deliberately doesn't carry) and skips a candidate a rule sends to another
  seat's agent - that seat offers it on its own pass. `runTask` then asks
  `GET /plan/gate/:taskId` for the license the **resolved** agent actually
  belongs to, so the gate and the eventual `usage_events` row always name
  the same seat.

  In-flight runs are tracked with the license they belong to, and
  `dispatchCapacity` (which replaced #130's `selectStartable`) allows a seat
  the global concurrency limit less everything in flight, further limited by
  that seat's own limit less what it already holds. Both figures come from
  `/plan/next` (`concurrencyGlobal` and `concurrency`, the latter scoped to
  the asking seat since a past task); either can be the binding one, and a seat
  limit above the global never raises it. Counting foreman's own in-flight
  runs rather than pinboard's claimed ones matters because a task started
  here doesn't become `executing` until its claim lands inside `runTask`. Ownership is resolved *before* that capacity is spent
  rather than after - capping the candidate list first would let the top of a
  shared, deterministically ordered queue (tasks routed to the other seat) eat
  a seat's whole window every cycle and starve it indefinitely. Each seat's
  poll is also independently try/caught, the same way `pollPullRequests`
  isolates each PR, so one seat failing doesn't skip the seats behind it.

  The practical effect: both seats share one backlog and either can take the
  next unrouted task, whichever has budget and a free slot. Since a past task
  two tasks on the same repo no longer serialise either - each run has its
  own clone (see "Task workdirs" below).

  **Deploying.** Runs as the compose `dispatch` service (`restart:
  unless-stopped`, so it survives a reboot with the docker daemon), next to
  `chat` (see below) and `pipeline` (see below).
  They are separate services so deploying one never disturbs the other
  two, and `scripts/deploy.sh` keeps it that way: after `docker compose
  build` it brings them up one at a time with `docker compose up -d
  --no-deps <service>`, and it **skips a service that is in the middle of
  something** and says so ("SKIPPED restarting ... keeps running the
  previously built code"). Recreating a container stops every process in
  it, so it would kill the `claude` child of a running task, a chat turn
  the operator is in the middle of, or a merge or deploy the pipeline is
  halfway through. A service is busy when its `work` process (the child of
  the container's `docker-init`) has a child of its own; re-run
  `scripts/deploy.sh` once it is idle. The decisions live in
  `scripts/lib/runner-services.sh`, tested by
  `scripts/runner-services.test.mjs`.

  **foreman deploys itself.** foreman's `.homelab/deploy.json` is an `lxc`
  step on host `foreman`, so a merged foreman change makes the `pipeline`
  service run `deploy-service.sh foreman`, which SSHes back to this host
  and runs `scripts/deploy.sh` there. Recreating `pipeline` at that point
  would kill the SSH client, and with it the rest of the deploy; and a
  pipeline killed while its task is still in the `deploying` stage would
  deploy again on restart. So when the busy service's own process tree is
  running `deploy-service.sh foreman`, deploy.sh does not skip it but
  starts a detached (`setsid nohup`) `scripts/deploy.sh --when-idle
  pipeline`, returns success, and that waiter recreates `pipeline` once it
  has been idle for two checks in a row (10s apart, up to an hour; log in
  `state/logs/deploy-when-idle.log`). The SSH hop needs foreman's own key
  in its own `authorized_keys` (marek's key, which the containers use per
  decision 4 in #514, already was). If deploy.sh is ever run inside a
  runner container (compose sets `FOREMAN_SERVICE` there), it hands the
  whole deploy to the host over SSH (`FOREMAN_HOST_SSH`, default
  `${HOMELAB_USER:-marek}@foreman`), detached the same way, because the
  image holds no checkout to build from.

  **The cutover (#518).** The first run of this deploy.sh on a host still
  running the systemd units does the move itself, so merging #518 through
  the (then still systemd-run) pipeline cuts foreman over. It builds the
  image, runs `scripts/bootstrap-container-state.sh --migrate-workspace`
  (moves `~/projects` to `/app/workspace` and leaves a symlink; a rename,
  so running processes keep working), then per service: an idle unit is
  stopped, disabled and deleted from `~/.config/systemd/user`, session
  transcripts are refreshed into `state/home`, and the compose service
  starts; if compose cannot start it, the unit is put back. A busy unit
  keeps running and a detached `--when-idle` waiter moves it once idle
  (the dispatcher running a task, the pipeline running this very deploy).
  A service is never on its unit and in compose at once. Until the move is
  finished, `scripts/healthcheck.sh` accepts a service still on its unit
  and says "cutover pending". Check it is done with
  `systemctl --user list-units 'foreman-*'` (should list nothing) and
  `docker compose ps`.

  `chat` needs a different busy test from the other two, and
  getting this wrong was a real bug. The chat daemon holds a
  `claude` child per **open thread**, not per in-flight turn, so the
  child-process test called it busy whenever any thread was open at all:
  the restart was skipped, the daemon kept serving the previously built
  code, and the deploy still printed success - a deploy that looks clean
  and changes nothing, which is the kind that gets debugged twice before
  anyone suspects the deploy. It now asks pinboard instead, for the state
  pinboard already keeps:
  `GET /chat/threads?status=open&awaitingAgent=true&taskId=none`. A thread
  is `awaitingAgent` from the moment a human message is posted until the
  agent's reply lands, which covers a parked permission request and a
  parked question too; `taskId=none` excludes a task's own session thread,
  which that task's runner answers rather than this daemon. No such thread
  means restarting costs nothing - the daemon tears a session down when it
  goes idle anyway and resumes it from its stored `claudeSessionId` on the
  next message. An unreachable pinboard falls back to the child-process
  test, because without an answer there is no way to tell an idle thread
  from a running turn, and cutting a live turn is worse than skipping a
  restart.
  `work task run <id>` still works standalone as a manual override/escape
  hatch - the dispatcher doesn't replace it, only automates the common
  case.

- **A retained session is scoped to the license that created it (task
  #174).** A Claude session id only exists inside the `~/.claude` of the
  Linux user that created it, and #152's per-seat dispatcher made it
  routine for a requeued task to be offered to a *different* seat than the
  one that retained it - exactly what happened live on 2026-09-17, when
  marek's 5h window closed mid-run on tasks #166 and #169 and the
  requeued tasks were picked up by `peter`'s seat instead. `peter-runner`
  tried to resume a session id it had never heard of and failed three
  times in 25 seconds, `is_error: No conversation found with session ID`,
  burning the whole attempt cap on an identical, free, instant failure.
  Two fixes: pinboard's `tasks.claudeSessionLicenseId` now travels with
  `claudeSessionId` as one fact (`setSessionState` writes both, `PATCH
  /tasks/:id` clears the license whenever a caller clears the session
  id), and `prepareAttempt` calls the new `isSessionResumableBy` before
  ever considering a resume - a mismatch (including an unknown owner,
  `null`, which is treated as *not* resumable rather than gambled on)
  starts the attempt fresh instead. As a backstop for the case that check
  can't catch (a session store cleared or vacuumed within a single seat),
  `session-limit.ts` gained a third failure class, `stale_session`, for
  the same "No conversation found" message - the runner drops the stale
  id and retries cold without spending an attempt, the same free-retry
  treatment a past task already gave a session-limit failure.

- **The planning chat poller** (I8, `app/src/chat.ts`) runs as its own
  process - `work chat daemon`, the compose `chat` service -
  polling every 2 seconds for chat threads with `awaitingAgent: true` and
  replying via `claude -p`, in the scoped
  project's own repo checkout (or the workspace root if no project is
  scoped) so the agent can actually read code while discussing it. Tool
  access is deliberately narrower than the task runner's
  (`agent-settings.ts`'s `CHAT_ALLOWED_TOOLS`): read-only plus `Bash(work
  task create:*)` only - this session never commits code, it proposes and,
  once agreed, files the outcome as a task for a later run to execute.
  Tries `claude -p --resume <session-id>` first when a thread already has
  one stored; a resume that errors (a stale session id - Claude Code
  session files aren't kept forever) falls back to a fresh session with
  the prior messages replayed into the prompt for continuity, rather than
  surfacing that as an error to the operator. `work chat poll` runs one
  pass immediately and waits for the turn it starts, for testing a reply
  by hand.

  It shared the dispatcher's loop until a past task, which split it out
  after two distinct failures showed up live in chat thread #26. First,
  the chat poll was `await`ed in front of the next dispatch cycle, so a
  turn parked on an unanswered permission request stopped task dispatch
  for as long as the operator took to answer - up to 30 minutes. Second,
  every deploy restarts `foreman-dispatch`, and systemd's SIGTERM reaches
  the whole control group, killing the `claude` child of whatever chat
  turn was mid-flight; the operator saw the turn's work vanish and a
  `could not parse claude output as JSON` message posted as the agent's
  reply. Two units, restarted independently, remove both.

  Turns are started rather than awaited, so two threads don't block each
  other, and a map of in-flight thread ids stops the 2-second poll from
  spawning a second session for a thread whose turn is still running -
  `awaitingAgent` only clears when the reply is posted, so without that
  guard every tick would start another one. That closes the overlapping-
  session race a past task recorded as a known gap here.
  - **The host agent persona** (a past task, keyed off `isHost` since
    #178/#179) is the one exception to the read-only persona above: a chat
    thread whose `agentId` points at a pinboard `Agent` row with `isHost`
    set gets an unrestricted execution persona instead - `claude -p` runs
    with no `--allowedTools`/`--disallowedTools` at all, i.e. full tool
    access equivalent to an interactive session, expected to actually edit
    files/run commands/commit rather than just discuss and file a task. A
    thread's own `model`/`effort` (set at creation, a past task) still take
    priority over the agent's own `model` over foreman's `DEFAULT_MODEL`,
    for every persona - see `chat.ts`'s `resolvePersona`. `isHost` isn't set
    by this repo; an operator flips it on whichever `Agent` row they want
    this persona available for, via pinboard's Agents UI/API. It's per-agent
    rather than a single hardcoded agent name (the original `foreman-host`
    scheme) because pinboard's `agents.name` is globally unique, which meant
    only one license, ever, could own that name - `isHost` lets each license
    flag its own agent as its host persona.
    - **Auto permission mode with a hard always-ask floor** (tasks #95,
      #145): the host persona has full tool access but never runs under
      `--permission-mode bypassPermissions`. It runs under
      `--permission-mode auto` - the same mode an interactive Claude Code
      session uses, where Claude Code itself decides which calls are risky
      enough to stop and ask about - with two things wired underneath it:

      - `--permission-prompt-tool` pointing at
        `app/src/permission-server.ts`, a small hand-rolled MCP stdio
        server spawned per turn via `--mcp-config` (see `chat.ts`'s
        `hostPermissionMcpConfig`). Anything that does escalate posts a
        message into that same chat thread describing the tool and its
        input, and blocks - polling pinboard, up to 30 minutes - for the
        operator to reply `approve`, `approve always` or `deny` there.
        Pinboard's chat view renders those as tap buttons.
        Denies by default if nothing arrives in that window.
      - A `PreToolUse` hook, `app/src/permission-gate.ts`, registered
        through an inline `--settings` JSON string (`chat.ts`'s
        `hostPermissionSettings`). It matches a Bash call's command
        against a short list of genuinely destructive or outward-facing
        verbs - `git push`, `git reset --hard`, `git clean`,
        `gh pr merge/close`, `gh release`, `gh repo delete/archive`,
        `rm -r`/`rm -f`, `sudo`, service stop/restart, `docker compose
        down`/`prune`, the deploy scripts, any `ssh`/`scp`/`rsync`/`pct` to
        another machine, and any nested `sh -c`/`eval` (whose real command
        is inside a quoted string where no pattern can see it) - and returns
        `permissionDecision: "ask"` for them, forcing them through the
        approval surface above no matter what auto mode thought. A hook
        rather than `--disallowedTools` because a denylist entry refuses
        outright with no way for the operator to say yes, which is not
        what "always ask me about this" means. The match steps over
        wrappers that don't change what a command does - inline env
        assignments (`NODE_ENV=production git push`), `env`/`command`/
        `exec`, and git's own global options (`git -C dir push`) - each of
        which was a real bypass caught in review before this shipped.

      Until a past task this ran as `--permission-mode default` plus
      `HOST_ALLOWED_TOOLS`, a hand-maintained prefix allowlist of
      pre-approved read-only commands. That inverted the problem: anything
      not literally on the list prompted, so chat thread #26 needed a
      separate approval for each of `cd`, `work --help`, `sed -n`,
      `systemctl` and `curl`, and the `approve always` reply keyed on a
      command's first three tokens so it never matched the next command
      either. Naming what must stop is both shorter and safer than trying
      to enumerate everything that may pass; the allowlist is gone.

      Per-turn caps are 45 minutes and $10 (`chat.ts`'s
      `DEFAULT_CHAT_OPTIONS`). The timeout deliberately clears
      `permission-server.ts`'s own 30-minute approval wait - while it was
      10 minutes, the outer kill always fired first, so an approval the
      operator answered slowly could never actually succeed.
    - **A stalled turn says so**. Two things make a turn that
      is going nowhere visible instead of silent. First, the Claude CLI
      reports a failing API call it is about to retry as its own message
      type (`SDKAPIRetryMessage` - `type: "system", subtype: "api_retry"`);
      `chat-session.ts`'s `translateSdkMessage` used to drop every message
      type it did not recognise, so those vanished. They are now posted
      into the thread as an `error` event naming the reason, the HTTP
      status, the attempt and the backoff (`API error - overloaded (HTTP
      529), retry 3/10, next in 2.1s`), and a first-byte timeout says how
      long it waited, since three silent minutes is the shape that reads as
      a freeze. The CLI's own `.jsonl` spells the same event
      `subtype: "api_error"` with camelCase fields, and both are accepted.
      The
      existing `error` kind is reused on purpose: pinboard and the PWA need
      no change, and since the payload has no `interrupted` flag the PWA
      renders it inline and leaves the turn running - a retry is not a
      failed turn. Second, `StallWatchdog` posts `No activity for Nm` after
      five quiet minutes and every five quiet minutes after that, for the
      windows where nothing arrives at all, not even a retry notice.
      `stallNoticeMs` overrides the interval per session.

      Why it matters: on chat thread #40 (2026-09-18/19) the API stopped
      answering for most of two hours and the CLI retried correctly for all
      of it, but the operator saw an empty, unmoving transcript, assumed the
      agent was wedged, and stopped and restarted three turns - about $1.80
      of abandoned work. Note what this does *not* do: there is still no
      hard per-turn time cap. The retry ladder is right, the 30-minute
      `IdleTimer` still catches a session that goes truly silent, and
      whether to wait out an outage or interrupt is now an informed
      operator decision rather than a guess.

    - **A question reaches the operator as option cards**.
      `AskUserQuestion` did not work in a chat session at all: it was
      auto-allowed and then ran with nothing to answer it, so it returned
      "The user did not answer the questions". The agent noticed, retyped
      its questions as prose, and carried on - twice, for $0.84, on chat
      thread #32. `canUseTool` now takes its own branch for the tool:
      it posts a `question` event carrying the questions and their options,
      parks on `PendingAnswers` (the same wait a permission request uses,
      keyed by the SDK's own request id), and returns the operator's picks
      as `updatedInput.answers`, which the CLI's own AskUserQuestion
      implementation reads back out of its input. The model keeps seeing
      the built-in tool with its built-in schema - nothing is aliased and
      no tool is re-implemented.

      Two properties are deliberate. The wait ends in an **allow**, not a
      deny: the tool then reports that nobody answered and the agent
      carries on, because a question the operator misses must never strand
      a turn. And a question with no answerable options is never posted at
      all - a card with nothing to tap would hold the session to its
      30-minute deadline with no way to answer it. (The escape hatch if a
      question is posted and the operator does not want to answer it is the
      Stop button, which aborts the wait the same way.)

    - **A turn ends when it is really over**. Two emit bugs
      that #149's transcript made visible:

      A `thinking_delta` with an empty `thinking` string is the API's
      *redacted-thinking* phase, where it streams only pings and the SDK
      digests the counters into its own `thinking_tokens` message. Those
      blanks used to be posted as `thinking` events - 39 of thread #32's 82
      - rendering as nothing while still spending the per-thread
      2000-event retention cap, which pushed real transcript out. They are
      dropped, and `thinking_tokens` becomes one progress event every five
      seconds (`THINKING_PROGRESS_INTERVAL_MS`) carrying `estimatedTokens`,
      which the PWA renders as a single row counting up.

      And a turn that launches an **async** subagent gets a `result` as
      soon as the main model's reply is done, while the subagent is still
      working. Thread #32's turn 2 "ended" at $0.11 and then streamed 40
      more events before really finishing at $0.40 - so the working
      indicator stopped early, the per-turn cost shown was the figure as of
      the subagent starting, and `postUsage` charged the turn twice. The
      SDK's `background_tasks_changed` message reports the live set of
      background tasks (a level signal: replace the set on each payload
      rather than pairing start/stop edges), and a result arriving while
      that set is non-empty is treated as **interim** - its `cost` tick
      still lands, flagged `interim`, but no `turn_end` does, and the
      result is held. It is released by the later real result, by
      `session_state_changed: idle` (which the SDK documents as the
      authoritative turn-over signal), by the operator's next message, by
      the session closing, or - as a backstop for a CLI that reports
      background tasks but never idle - by a 60-second drain fuse armed
      once the background set empties and re-armed by any further message.
      So a turn can legitimately sit "running" for up to a minute after the
      last visible activity before the fuse closes it.

      A turn is closed out exactly once (`endTurn`). The fuse and the SDK's
      own final result are on different call stacks, so without that guard
      a result landing just after the fuse fired would post a second agent
      reply and charge the turn's cost twice; a late result's cost tick is
      still recorded, since it is the more accurate figure, but it does not
      end the turn again.

    - **Chat spend is charged to the budget**: each turn's
      `total_cost_usd`/`duration_ms` is posted to pinboard's
      `POST /chat/threads/:id/usage`, which adds it to the thread's running
      total and appends a `chat`-source row to `usage_events` - the same 5h
      session window a task run is charged against. That route had existed
      since a past task but nothing here ever called it, so until this landed
      every chat thread read `totalCostUsd: "0"` and the work planner
      silently under-counted every conversation. A failed resume that is
      retried fresh is charged for both attempts, because both cost money.
      A turn that dies without producing a result JSON at all (hard
      timeout, killed process) still carries no figure to report and goes
      uncharged; closing that needs the streamed events, which is task
      #148.
- **The post-PR pipeline poller** (a past task, `app/src/pipeline.ts`) runs as
  its own process - `work pipeline watch`, the compose `pipeline`
  service - polling `GET /pipeline/next` every 30
  seconds and driving each task it finds through the stages pinboard
  added in 
  | Stage | What the poller does |
  | --- | --- |
  | `awaiting_ci` | `gh run list --repo <org>/<repo>` for the PR's branch, per repo, where `<org>` is read from that PR's own URL (`github.com/<org>/<repo>/pull/n`), since a task's PRs can live in another org than its project; only a URL that does not parse falls back to the first path segment of the task's project `localPath`, then the directory name of `WORK_HOMELAB_ROOT`. A failed run's evidence is `--log-failed`, then each non-passing job's API log, then the run URL with every non-passing job's conclusion - never an empty block. Green and the project has `autoDeployAllowed` -> `awaiting_merge`; green but the diff touches a drizzle migration (or its diff could not be read at all) -> `awaiting_review`; green with no auto-deploy opt-in, or a `production` repo -> `review`, PR left open for a human. |
  | `awaiting_review` | Nothing - this is a human hold. Approving it in pinboard's review queue moves it to `awaiting_merge`. A task in `review` (green CI, no auto-deploy) approved there takes the same route. |
  | `awaiting_merge` | `gh pr merge --squash --delete-branch`, per repo, marking each PR merged in pinboard as it goes. Then `deploying` whatever the project's `autoDeployAllowed` says, because a merge reached from a review approval has that approval as its consent; or `review` if no repo involved has an LXC to deploy to (a library repo - see that repo's AGENTS.md "Close-out"). |
  | `deploying` | `homelab/scripts/deploy-service.sh <repo>` under that repo's deploy lock, then `verifying`. Targets come from the repo's deploy declaration (`.homelab/deploy.json`, or `homelab/targets/<repo>.json` for a repo outside the workspace's own org; see homelab/AGENTS.md "Deploy declarations"). An empty step list goes straight to `review` as "nothing to deploy"; a missing or invalid one parks the task in `rework`. Repos with an `npm` step (libraries, today homelab-kit) deploy first so the version their consumers need is published before those consumers build; the rest keep their order. **Secret store before its consumers:** a repo whose workspace clone has a `keyring.json` at its root is the secret store. When a task merges a PR there, that repo deploys first, then every host whose rendered variable set changed in that PR's `keyring.json` (diffed across its squash commit: a host that gained or lost a group, a group that gained or lost a name, a new host) is synced through the store's agent API (`<repo>/scripts/agent-api.sh POST /api/sync`, which needs `KEYRING_AGENT_TOKEN` in foreman's `.env`), and only then does any other repo in the task deploy. So a secret-store PR and its consumer's PR can land in one task with no handoff note about ordering. A failed sync, or a diff that cannot be read, parks the task in `rework` with the failure as repair context and deploys nothing else. `deploy-service.sh` itself does not sync: a human who merges a `keyring.json` change by hand syncs the affected hosts before deploying them, same as before. The workspace clones involved (the repo and `homelab`) are fast-forwarded first when on their default branch and clean, since nothing else pulls them. |
  | `verifying` | The repo's own `scripts/healthcheck.sh` over SSH, independently of the one `deploy-service.sh` already ran, retried once per poll for up to 5 minutes. Then an `executorMode=agent` task goes straight to `done` ("Closed automatically (executor agent)", a past task), and the dispatcher's workdir sweep removes its workdir like any other finished task; `human+agent` and anything else goes to `review`. |

  Every 10 minutes the same loop also syncs pinboard's PR rows with GitHub
  (`pull-requests.ts`, moved here from the dispatch loop in a past task): each
  row still `open` is read with `gh pr view --json state` and patched to
  `merged`/`closed`, and a `done` task whose PR GitHub still has open gets a
  single `Done but PR still open: <url>` comment. Each pass logs one
  `pr-sync: checked N open PR(s), ...` line.

  This is the work that used to run inside `runTask` as `mergeAndDeploy`,
  where it held the task's Claude session, its lease and the single agent
  concurrency slot for the ten-plus minutes CI plus a deploy takes - none
  of which it needs. Splitting it out is what frees the agent slot at the
  PR (a past task).

  The poller keeps no state of its own: every decision comes from
  `/pipeline/next`'s payload (including `stageEnteredAt`, which is the
  clock for every timeout, so restarting this process does not give a
  wedged stage a fresh budget), and every move goes back through `POST
  /tasks/:id/pipeline`, which refuses anything the state machine does not
  allow. Killing and restarting it mid-pipeline loses nothing.

  A task that has PRs in more than one repo (a past task's cross-repo
  support) is driven across all of them: the repo set comes from the
  task's own PR list filtered to this attempt's branch, and a stage only
  advances once every repo has cleared it.

  **Releases probe and Deploy now** (a past task, `app/src/releases.ts`)
  ride on the same loop, since they need the same SSH and `gh` access and
  the same per-repo deploy lock. After each pipeline pass it claims at most
  one Deploy-now request from pinboard (`POST /releases/requests/claim`),
  runs `deploy-service.sh <repo>` with `DEPLOY_ACTOR=agent:foreman-releases`
  and `DEPLOY_REQUEST_ID`, waiting up to 10 minutes for a busy lock, then
  reports the output and re-probes that project. Every
  `--probe-interval-seconds` (default 1800; a full pass takes about 2
  minutes and holds up pipeline stages meanwhile) it probes every project: reads
  each declared step's checkout sha over SSH (`/app`, or
  `/app/projects/<app>` for an `app` step), the default branch's sha from
  `gh api repos/<org>/<repo>/commits/HEAD`, and the commits in between from
  GitHub's compare API, then `PUT /releases/targets/:projectId`. A repo whose
  steps name the `production` host is never deployed from Deploy now.
  `work releases probe` and `work releases deploy-next` run either step by
  hand.

  **Production releases** (a past task, `runRelease` in `app/src/releases.ts`)
  come through the same claim, as a request with `kind: release`. They run
  only from that human click; the declaration's `release` block is parsed by
  `deployStepsFor` but is never a step, so the post-merge pipeline cannot
  reach it. In a scratch dir, `/app/tasks/.releases/request-<id>` (removed on
  success, kept on failure for inspection), it:
  1. clones the app repo, checks the release branch is an ancestor of the
     default branch, bumps every `versionFiles` entry (they must agree) by
     the requested bump, refuses if tag `v<version>` already exists, commits
     `Update: release v<version> (pinboard release request #<id>)` and pushes
     it to the default branch;
  2. fast-forwards the release branch to that commit;
  3. polls `gh run list --workflow <workflow> --branch <branch>` every 15s,
     up to 30 minutes, for the run on that commit, and needs it to succeed;
  4. clones `<composeRepo>` (from the org of its workspace clone), rewrites every declared image's
     pinned tag in `composeFile`, commits and pushes;
  5. runs `deploy-service.sh --release <repo>` under the repo's deploy lock,
     with `DEPLOY_SHA` set to the bump commit.

  Nothing here is atomic. Each failure message says what was already
  pushed: a bump that reached the default branch stays there (the next
  release bumps past it), and after step 4 the new tag is pinned but may not
  be running (`deploy-service.sh --release <repo>` by hand finishes it). The
  probe reports the release target from the tag the host's compose file
  pins, resolved to a commit with `gh api repos/<org>/<repo>/commits/<tag>`.
  The pipeline loop is blocked while a release runs, mostly on the image
  build (a few minutes).

  **A failed stage either hands back to an agent or parks for a human**
. The dividing line is whether another agent run would have
  anything to act on:

  | Failure | What happens |
  | --- | --- |
  | CI failed | Handback, `ci_failed`. The evidence is `Failing steps: <job> / <step>` plus the failing step's own log: `gh run view --log-failed`, or, when that prints nothing (reusable-workflow runs do), each failed job's raw log via `gh api .../actions/jobs/<id>/logs` cut from the failing step's `##[group]Run` header to its `##[error]` line. If neither yields anything the comment says so and links the run. The PR stays open and takes the fix as more commits on the same branch. |
  | CI failed, same run as last handback | Park in `rework`. Each `ci_failed` handback comment ends with a `Failed CI run: <repo> <run id> (head <sha>)` marker; if the next CI check finds that same run id, the agent pushed nothing new and another run would read the same failure. |
  | CI failed, default branch already red on the same step | Park in `rework` with "main of <repo> is already failing <step> (<run url>); not caused by this task". Checked against the latest completed run on the repo's default branch, matching bare step names. No attempt is spent. A red main on a different step still hands back. |
  | `gh pr merge` refused | The poller first rebases the task's own clone onto `origin/main` and force-pushes it, then retries the merge on the next poll - the usual cause is the branch having fallen behind while it sat in CI, and a rebase costs nothing where an agent run does not. Only if the rebase itself fails, finds the branch already current with main (so staleness was not the problem), or the merge is still failing 5 minutes in, does it hand back as `merge_conflict` with git's own output. A rebase that would change nothing is never pushed, so a merge failing for some other reason cannot re-trigger CI on every poll. |
  | Deploy script failed | Handback, `deploy_failed`, with the script's output. The change is already on main at this point, so the repair run is told to fix forward rather than re-land it. |
  | Healthcheck never passed | Retried once per poll for 5 minutes (a just-recreated service can legitimately fail its own check for a few seconds), then handback, `deploy_failed`. |
  | No PR recorded, no branch recorded, CI unreadable for the whole timeout, deploy lock never freed | Park in `rework`. None of these is something an agent run in a repo checkout can fix. |

  A handback is `POST /tasks/:id/pipeline {to: "queued", repairReason,
  repairContext}`. Pinboard refuses a handback that carries no reason, and
  deliberately does **not** reset `attemptCount` (a plain human requeue
  does) - so the runner's own attempt cap is what ends a repair loop. A
  task whose CI keeps failing gets its remaining attempts and then parks
  in `rework` like any other, rather than being handed back forever.

  **Only an autonomous task is handed back**. A "handback" in
  the table above applies to an `executorMode: agent` task. A
  `human+agent` task has a person on it, and a second agent started behind
  them would race whatever they are doing, so the same failure parks it in
  `rework` instead (`routeHandback` in `app/src/pipeline.ts`), with the
  same `repairReason`/`repairContext` attached and the same failure
  notification. When the human requeues it from `rework`, pinboard keeps
  those fields, so the run they start reads the failure exactly as an
  autonomous repair would. A pinboard too old to send `executorMode` gets
  the park, never the handback.

  The resumed run is an ordinary dispatch of a `queued` task: it resumes
  that task's own Claude session in its own clone, on its own branch,
  rebased onto main by `prepareAttempt` as any resume is. What makes it a
  repair is `buildPrompt`, which prepends the reason and the evidence
  (`repairPromptLines`) to the task's normal prompt - including which of
  the three situations the change is in, since that decides where the fix
  goes: a red PR is still open and takes more commits, a merged-then-
  failed deploy needs a new change on top of main.

  `work pipeline poll` runs a single pass and prints what moved, for
  driving a stage by hand. It is safe to run while the service is up -
  every decision is re-derived from pinboard and every transition is
  checked there.

- **Mid-task clarifying questions** (I9, `app/src/ask.ts`) let the task
  runner's own session (not the planning-chat poller above - this is the
  privileged session actually doing the work) pause and ask the operator
  something instead of guessing. `work task ask <id> "<question>"` is a
  Bash tool the running session calls itself (see `agent-settings.ts`'s
  `DEFAULT_ALLOWED_TOOLS`): it posts the question to a chat thread scoped
  to that task (reusing I8's `chat_threads` table, `taskId` set instead of
  `projectId`) and blocks up to `--wait-seconds` (default 90, deliberately
  short and safely re-callable rather than risking Claude Code's own Bash
  tool timeout killing a longer single wait) for a reply, printing it once
  it arrives. No reply in time prints a message telling the session to
  call again to keep waiting or proceed with its own judgment - a retry
  with the same question text finds its own pending question (or an
  answer that arrived after a prior call's wait window already gave up)
  rather than posting a duplicate; a genuinely different question always
  posts fresh. The task runner's hard `timeoutMs` pauses while a question
  is outstanding (`runner.ts`'s `advanceTimeoutTracker`/`hasTimedOut`), so
  an overnight dispatch run waiting on the operator doesn't burn its whole
  timeout budget doing nothing.

  A past task narrowed when a run asks. The runner prompt's
  autonomy policy (`runner.ts`'s `autonomyPolicy`) has it decide reversible,
  in-scope choices itself and record them with `work task assume <id>
  "<decision>" --why="<text>"`, which stores a pinboard ask of kind
  `assumption` and returns at once; the operator can accept or veto it later.
  `work task ask` is kept for irreversible/destructive, production-impacting,
  secrets, scope-change, money, or task-contradicting decisions, and takes
  `--context=`, 2-4 `--option="<label>|<rationale>"` and `--recommended=<n>`
  (1-based). Each ask is also posted to pinboard's `POST /tasks/:id/asks` with
  the chat thread's id, so answering it in the asks view posts the answer
  into that thread and the waiting call picks it up; a plain `work task ask
  <id> "<question>"` is stored as a free-text question with no options. The
  next attempt's prompt lists every answered ask and assumption
  (`askHistoryLines`), so a run resumed after `needs_input` starts from the
  answers. The handoff has a `summary` (a TL;DR of at most 5 lines plus a
  "Needs you:" line when something is left for a human) and a `howToVerify`;
  `work task handoff --summary=` sets the former by hand. The PR body
  (`formatPrBody`) leads with the summary, then `Closes pinboard task #id`, a
  short `## Changed` (the files the branch touches) and `## How to verify`,
  with the full Completed/Changed/Verified/Problems/Discovered collapsed
  under "Agent detail".
  Pinboard `work task answer <askId> <option|text...>` answers an
  open ask (`POST /asks/:id/answer`, requeueing a `needs_input` task); a
  leading number is the 1-based option. It is on the planning chat allowlist,
  so a thread seeded by pinboard's "Resolve in chat" can settle its asks.

- **Failure classification** (a past task, `app/src/session-limit.ts`) decides
  whether a failed attempt should cost an attempt at all. The loop used to
  treat every non-terminal failure as "try again", which is right for a
  flaky test and wrong for the two failures that actually happen:
  - *Session limit.* Claude prints `You've hit your session limit - resets
    <time> (UTC)`. The reset time is parsed (a bare UTC clock time, resolved
    to its next occurrence), posted to pinboard's `POST /plan/session-limit`,
    and the task goes back to `queued` with its attempt **refunded** - not to
    `rework`. Nothing a retry does clears a 5h window; only waiting does. The
    requeue and the attempt count are sent in one PATCH on purpose, because
    pinboard resets `attemptCount` to 0 for any status change to `queued`
    that doesn't name the count itself.
  - *Budget exhausted.* A run whose cost reached its `--max-budget-usd` cap
    stops immediately and goes to `rework` with "ran out of budget at $X".
    Retrying is pointless: every attempt gets a *fresh* cap, so a task
    needing more than the cap just buys the same wall again at full price.
  - *Infrastructure* (a past task, `app/src/infra.ts`): workdir preparation
    failing with `No space left on device`/ENOSPC, the CLI-version error
    (`does not support this model; version ... or newer is required. Run
    'claude update'`), or a claude auth/login error. These never spend an
    attempt: the task goes back to `queued` with the attempt refunded, gets
    one comment naming the cause, and the dispatcher stops claiming for that
    seat (a full disk: for every seat) for `FOREMAN_INFRA_COOLDOWN_MS`
    (default 30 min). The cooldown is in memory, so restarting
    `foreman-dispatch` after fixing the cause clears it. An outdated CLI first
    gets one `claude update` (every seat shares foreman's own install since
    a past task); if the version changed, the task retries at once.
  - *Everything else* retries as before, up to `--attempts`.

  **Disk preflight**: before claiming anything, each poll checks
  free space on the filesystem holding `/app/tasks`. Below
  `FOREMAN_MIN_FREE_GB` (default 3) it runs the workdir sweep immediately; if
  still below, it claims nothing, logs `dispatch: preflight refused ...` and
  cools down. It logs `dispatch: preflight ok ...` once after start and again
  whenever the state changes. Nothing is claimed, so no task gets a comment.

  **Operator alerts** (a past task, `app/src/health.ts`): the conditions above
  that only a person can fix also reach pinboard's notification bell, via
  `POST /api/health/report` (actor `system:foreman`). Checks: `8ball` (an
  8ball-executor run could not get an answer, filed under the pinboard
  project `EIGHT_BALL_PROJECT` names, none if unset),
  `seat:<licenseId>` (auth or outdated CLI that `claude update` did not fix)
  and `disk` (preflight refused after a sweep), both project `foreman`. Only
  transitions are sent: one "is failing" entry, then one "recovered" entry on
  the next good gateway run, next seat run that is not an infra failure, or
  next passing preflight. State is in-memory, so after a restart a still-
  failing check reports once more. A report pinboard does not accept is
  logged (`health: could not report ...`) and retried on the next
  observation. To test: run an 8ball-executor task with a bad
  `EIGHT_BALL_URL`, and the bell shows `foreman: 8ball is failing`.

  The dispatcher needs no separate mechanism for any of this: the reported
  reset reaches it as the `waitUntil` that `GET /plan/next` already returns
  and `computeSleepMs` already sleeps on.

  The concrete history, from tasks #117 and #115 on 2026-09-17: #117's
  attempts 2 and 3 cost $0 each, ~15s apart, against a session limit, and
  the attempt cap then sent a perfectly good task to rework; #115 repeated
  it unaided minutes later. Separately #117 spent $2.0203 and then $2.0379
  against a $2 cap - $6 to prove the cap was too small.
- **Per-run budget** comes from pinboard's gate, not from a constant here.
  `GET /plan/gate/:taskId` returns `budgetUsd`, sized from that task's own
  cost estimate (2x the estimate, floored at $2, capped at $10). An explicit
  `--budget-usd` from the operator still wins. `DEFAULT_RUN_OPTIONS.budgetUsd`
  survives only as the fallback for callers that never reach the gate.

## Public repositories

A past task, an earlier story. A repo whose GitHub org (`repoOrgFor`, read from the
workspace clone's `origin`) is in `PUBLIC_GITHUB_ORGS` (comma-separated,
default `rackmarten`, set in `docker-compose.yml`; an empty value means no
repo is public) gets nothing foreman or its agents write to GitHub that
points back at private infrastructure. Decided per repo, so one task can
push to a private and a public repo at once.

- **Agent prompt.** When any repo in the run is public, the prompt adds a
  "Public repository rules" block naming those repos: no `task #<n>` or
  pinboard links, private service or host names, CTIDs/LAN addresses,
  private domains or private-repo links in commits, PR text, CHANGELOG,
  comments or docs there. Handoffs and pinboard comments stay private and
  detailed.
- **PR text.** A public repo's PR title is the branch's first commit subject
  (a private repo keeps `<task title> (pinboard #<id>)`), and its body is
  the handoff summary, the changed files and how-to-verify, without the
  "Closes pinboard task" line or the collapsed agent detail. The squash
  merge passes its own `--subject` (the PR title without a `(pinboard #<id>)`
  suffix, plus `(#<PR number>)`), so a PR opened before its repo went public
  still merges clean. Foreman posts no other comments on GitHub. Branch names
  stay `task-<n>`; squash merges keep them off `main`.
- **Pre-push leak gate** (`app/src/leak-gate.ts`). Before pushing a task
  branch to a public repo, foreman runs homelab's `scripts/leak-check.sh`
  from the workspace clone with `--patterns public-leak-patterns.txt --log
  origin/<base>..HEAD --stdin`, feeding it the added lines of `git diff
  origin/<base>...HEAD` and the PR title and body. Stdin hits are mapped back
  to `<file>:<line>` or the PR title/body, and diff hits matching the repo's
  `.leak-allow` are dropped. Any remaining hit, exit 3 (no patterns), a
  missing script or pattern file, or a script error blocks the push: the task
  goes to `rework` with a comment listing pattern ids and locations, never
  the matched text. Private repos skip the gate entirely.

Check the resolved value with `docker compose config | grep PUBLIC_GITHUB_ORGS`
or `docker compose exec dispatch printenv PUBLIC_GITHUB_ORGS`.

## Task workdirs

Every agent run works in its own directory tree under `/app/tasks`, created
by the runner and removed by its sweep:

    /app/tasks/task-<id>/repos/<repo>    one local clone per repo the task may write to
    /app/tasks/.locks/<repo>.deploy.lock a held deploy lock (see below)

- **One clone per task, not a shared worktree**. Before this, a
  run got a `git worktree` inside the single workspace checkout of that repo
  (`~/projects/<org>/<repo>/.claude/worktrees/`), which is why
  pinboard refused to start two tasks whose repos overlapped: they would have
  been writing the same directory tree. A clone shares nothing, so that rule
  is gone and two tasks on one repo can now run at the same time, on either
  seat.
- **Why `/app/tasks`.** Every other service in this org keeps its state in
  `/app` on its own LXC, which is what makes an LXC rebuildable; foreman has
  drifted from that, and new state is placed the way the rest should
  eventually be (a past task tracks pulling the rest back in). The
  directory is gitignored, created by `scripts/deploy.sh` as mode 2775 owned
  by group `marek`, because a second license's runs are spawned as their own
  Linux user and must be able to create their own task directories.
  `WORK_TASK_ROOT` (set in both systemd units) overrides the location.
- **Cloned from the workspace checkout**, so no network fetch
  (`git clone --local --no-hardlinks` - hardlinking is impossible here,
  because the shared workspace clone holds objects owned by the *other*
  operator's Linux user and `fs.protected_hardlinks` forbids linking a
  read-only file you neither own nor can write), then `origin` is
  repointed at GitHub and
  the task's branch (`task-<id>`) is cut from `origin/main` - not from the
  workspace checkout's own `main`, which can be days stale.
- **node_modules is copied, not installed**, for each package directory whose
  `package-lock.json` is byte-identical to the workspace checkout's. A real
  copy (`cp -a`), never a hardlink: a tool that rewrites a file in place
  would otherwise corrupt the workspace checkout's own dependencies. A
  mismatched lockfile just means the session runs its own `npm ci`.
- **The sandbox follows cwd.** The session is spawned with its cwd at the
  task's own clone of its project's repo and no `--worktree` flag; a related
  repo's clone is a sibling directory, so it is granted explicitly with
  `--add-dir`. Everything outside the task's workdir stays denied to
  Bash/Edit/Write exactly as before (the Read tool is exempt, as it always
  was).
- **A repo related mid-run.** When the agent runs
  `work task add-related-repo <id> <project>` inside its own session (the
  task has a workdir under `TASK_ROOT`), the CLI records the relation and
  also clones that repo into `repos/<repo>` on the task branch, the same
  `ensureTaskClone` a pre-declared related repo gets, and prints the path.
  The session's `--add-dir` grant covers the task's whole `repos/`
  directory, so the new clone is writable without restarting. The CLI may
  run as the other seat's user, whose `$HOME` is not the dispatcher's, so the
  runner writes its workspace root to `<workdir>/workspace-root` for the CLI
  to clone from. After the session the runner re-reads the task's related
  projects before pushing, so that repo gets its own PR like any other. Run
  on a workstation (no task workdir), the command only records the relation.
  The agent still has no `git clone`: where and on which branch a repo is
  cloned stays the runner's decision.
- **Retention**: a workdir survives until its task reaches done/rejected,
  or is in `review` with every PR row merged (a past task, nothing left to
  resume there), or has sat untouched for three days, so a rework or a
  resumed session still finds its checkout and its `claude` session id.
  Queued, in-progress, rework and pipeline-stage tasks only ever lose theirs
  to the three-day rule. The sweep is
  now one recursive delete instead of removing a worktree and its branch in
  each repo.
- **Deploy lock.** Since two tasks can now merge to the same repo at once,
  the one step that must not overlap is the deploy: the pipeline poller's
  `deploying` stage takes `/app/tasks/.locks/<repo>.deploy.lock` before
  running `deploy-service.sh`, and takes over a lock whose holder is dead
  or older than 30 minutes. It is a file, not an in-process mutex, because
  a manual `work task run` is a different process from the poller. Since
  a past task a task that cannot get the lock waits across polls instead of
  blocking on it (5 seconds per attempt, so other tasks' stages keep
  moving), and only gives up - saying so on the task, leaving the deploy
  to a human - once it has been in `deploying` for 30 minutes.

Known limitation: the sweep prunes the stale `~/.claude.json` trust entries
only in the *dispatcher's own* home. A second license's runs are spawned as
their own Linux user and write trust entries into that user's `~/.claude.json`
instead, which marek cannot read (`/home/peter` is 0770), so that file grows by
one entry per task per repo until it is tidied by hand from that account.

Worktrees created before a past task are no longer touched by anything; run
`scripts/sweep-orphaned-worktrees.sh --apply` once to clear the ones whose
tasks are finished.

## Housekeeping

A past task, after the disk hit 98% of 32G on 2026-09-28 (docker images,
build cache and anonymous volumes from agent test runs, plus the npm cache).
Since a past task it is the compose `housekeeping` service (profile
`housekeeping`, so `up` never starts it), run nightly at 04:30 by a host
crontab entry that `scripts/install-housekeeping-cron.sh` writes (deploy.sh
runs it every time; `HOUSEKEEPING_SCHEDULE` overrides the schedule). It
runs `scripts/housekeeping.sh --apply`, which:

- prints `df` for `/` and `docker system df` before and after;
- prunes stopped containers older than 24h, unused images and build cache
  older than 72h, and anonymous volumes (named volumes are never touched).
  This is the HOST's docker daemon, through the mounted socket, which is
  the one agent runs fill up;
- runs `npm cache verify`;
- reports the image's `claude --version` against the newest published
  `@anthropic-ai/claude-code`, and prints a `WARNING` when the image is
  behind. `claude update` no longer applies: the CLI comes from the image,
  so the fix is bumping `CLAUDE_CODE_VERSION` in the Dockerfile and
  deploying. An outdated CLI is an infra failure (#440), so it should not
  go unnoticed.

Without `--apply` the script is a dry run that only prints the commands and
current versions. Each step's failure is logged and the rest still run.

    docker compose --profile housekeeping run --rm housekeeping   # run once now
    tail -n 50 state/logs/housekeeping.log                      # the nightly runs
    crontab -l                                                  # the schedule

Task workdirs are not part of this; the dispatcher's own sweep handles those
(see "Task workdirs").

## Container image

Story #514 moved the runner from the systemd `--user` units into Docker
Compose: a past task added the image and compose file, #517 the state layout,
#518 the cutover. Deploy with `scripts/deploy.sh` rather than a bare
`docker compose up`, which would recreate a busy service. One-off
`docker compose run --rm dispatch <command>` is always safe.

- `Dockerfile`: `node:22-bookworm-slim` (pinned by digest) plus git, gh,
  openssh-client, curl, python3, procps, sudo and the docker CLI with the
  compose and buildx plugins (no daemon: the host's socket is mounted).
  Claude Code is installed globally at a pinned version
  (`CLAUDE_CODE_VERSION` build arg, auto-updater off), so updating it means
  bumping that arg and rebuilding, not `claude update`. `app/` is built in
  the image and `work` is a symlink on PATH, so there is no `npm link`.
  User `marek` (uid/gid 1000) is in a `docker` group whose gid is the
  `DOCKER_GID` build arg (991 on foreman) and has passwordless sudo inside
  the container (decision 5 in #514).
- `docker-compose.yml`: `dispatch`, `chat` and `pipeline`, plus
  `housekeeping` behind the `housekeeping` profile. Stop grace periods match
  the old units' `TimeoutStopSec`. Each service sets `FOREMAN_SERVICE` to
  its own name. `env_file` is `.env` then
  `secrets/global.env`, both optional. Mounts: the docker socket,
  `${WORK_TASK_ROOT}` at the identical path, `./workspace` (holding
  `<org>/<repo>`, what pinboard's `localPath` is relative to),
  `./state` and `./secrets` read-only. No published ports.
- `.env.example` lists every variable the containers read.

Build and smoke-test (every dependency comes from the public npm registry,
so the build needs no token; the image is about 2GB):

    docker compose build
    docker compose run --rm dispatch work task list
    docker compose run --rm -e CLAUDE_CODE_OAUTH_TOKEN dispatch claude -p 'reply with the single word ok'

`claude -p` works in a fresh container with no `~/.claude` at all and only
`CLAUDE_CODE_OAUTH_TOKEN` set: no onboarding, trust or settings file is
needed, including with the runner's `--permission-mode bypassPermissions`
and through the agent SDK the chat daemon uses. What a cold `~/.claude`
does lack is behaviour, not function, and the state-consolidation child has
to seed it into the persistent HOME: `settings.json` (notably
`attribution`/`includeCoAuthoredBy` off, or runs add Claude trailers to
commits and PRs, plus permissions), `CLAUDE.md`, `agents/` and `skills/`
(the shared config from homelab's `claude-config/`), `projects/` (session
transcripts, needed to `--resume` a retained session across restarts),
plus `~/.ssh` and `~/.gitconfig`.

### GitHub access

Every fetch and push to GitHub from foreman goes over https and
authenticates with `GH_TOKEN`; the SSH key is only for reaching
the LXCs. Remotes stay `git@github.com:<org>/<repo>`, git rewrites them:

- **Containers:** the image's `/etc/gitconfig` sets
  `url.https://github.com/.insteadOf` for `git@github.com:` and
  `ssh://git@github.com/`, and the credential helper
  `gh auth git-credential`, which reads `GH_TOKEN` from the env_file.
- **Host** (the workspace clone the systemd `--user` timers fetch, e.g. the
  weekly version check): `scripts/setup-host-git.sh`, run by every
  `deploy.sh`, puts the same `insteadOf` entries in the invoking user's
  `~/.gitconfig`, with `scripts/git-credential-github.sh` as the helper. It
  reads `GH_TOKEN` from the environment, else `secrets/global.env`, else
  `.env` (the same token the containers use, no second secret). With no
  token it gives no credential and the fetch fails; it never falls back to
  SSH or to a `gh` login.

The token needs `repo` (push) on every org foreman works in, for
example both a private org and a public one, plus `workflow` for repos with Actions.
Check one repo with `gh api repos/<org>/<repo> --jq .permissions.push`.

### State layout and rebuild procedure

All of the runner's mutable state lives under `/app`, so rebuilding foreman
means restoring these directories, not recreating a home directory from
memory:

| Path (host = container) | What | Back up? |
| --- | --- | --- |
| `/app/state/home` | `HOME` for every container process: `.claude/` (settings, CLAUDE.md, agents, skills, session transcripts in `projects/`), `.claude.json` (workspace trust), `.ssh/` (key + `known_hosts`), `.gitconfig` | **Yes.** Transcripts are what `--resume` needs; the rest can be re-seeded by the bootstrap script |
| `/app/workspace` | THE workspace clone, `<org>/<repo>` (decision 2); the operator's `~/projects` is a symlink to it | Optional: everything is on GitHub, but a re-clone takes a while and unpushed operator work lives here |
| `/app/tasks` | Per-task clones, mounted at the identical path inside and out | **Yes** while tasks are in flight: an unpushed attempt's commits exist only here |
| `/app/secrets` | `global.env`, rendered by a secret store, mounted read-only | No: the secret store re-syncs it |
| `/app/.env` | Local config (`.env.example` is the contract) | Yes (small, not in git) |
| image, `node_modules`, `state/home/.npm` | Build output and caches | No, disposable |

`HOME` is set explicitly in compose, and the image's `marek` has
`/app/state/home` as its passwd home too, because ssh reads `~/.ssh` from
passwd and ignores `$HOME`. Every path the `work` CLI derives from HOME goes
through `app/src/paths.ts` (`workspaceRoot()`, `claudeConfigPath()`); compose
sets `WORK_WORKSPACE_ROOT=/app/workspace`, so a project's `localPath`
(`my-org/foreman`) resolves to `/app/workspace/my-org/foreman`.
`CLAUDE_BIN` is pinned to the image's `claude`.

**Seeding** is `scripts/bootstrap-container-state.sh`, run on the host as
uid 1000 (not root, so ownership is right without a chown). It is
idempotent: an existing non-empty file is never overwritten without
`--force`, a second run reports `0 change(s)`, and it never prints a file's
contents. It:

- creates `state/home` (mode 700) and `workspace/`;
- copies the key pair and `known_hosts` from `SSH_KEY` (default
  `~/.ssh/id_ed25519`; decision 4 keeps the operator's key for now);
- writes `user.name`/`user.email` from `GIT_USER_NAME`/`GIT_USER_EMAIL`,
  falling back to the invoking user's own `git config --global`;
- copies `~/.claude` except the stored login (`.credentials.json`; the
  containers use `CLAUDE_CODE_OAUTH_TOKEN`) and per-process runtime state,
  plus `~/.claude.json`. Files the user cannot read (a few of peter's
  pre-#477 transcripts on foreman) are reported and skipped;
- with `--migrate-workspace` (by hand only since a past task; `deploy.sh` no
  longer passes it), renames `~/projects` to `/app/workspace` and
  leaves a symlink, and aliases the old path's transcript directories under
  the new path's name so chat sessions started there still resume;
- with `--refresh-sessions`, updates transcripts that are newer on the host.
  Run it at the cutover after the units stop, so a session that kept going
  after the first seed resumes from its end.
- with `--merge-seed <tarball>`, does only this and stops: merges
  a tarball of another seat's `~/.claude/projects` (top-level dir
  `projects/`) into `state/home/.claude` with GNU tar's `--skip-old-files`
  (no existing file is overwritten) and `--keep-directory-symlink` (the
  `-app-workspace-*` aliases stay symlinks), then aliases the seed's
  `-home-marek-projects-*` directories. Set
  `SEED_WORKSPACE=/home/marek/projects`, the path those sessions ran in, when
  running it from inside a container. Used once on 2026-09-30 to bring over
  peter's pre-cutover license-2 transcripts (203 files), so a rework of a
  task like #500 can `--resume` its retained session.

**Claude rules mirror.** The bootstrap copied `~/.claude` once,
so later rule edits never reached the containers. Now four entries are a
mirror of marek's `~/.claude`: `CLAUDE.md`, `settings.json`, `agents/` and
`skills/` (including `skills/synced`). Nothing else is mirrored: not the
login, not `projects/`, `plugins/` or runtime state.
`scripts/sync-claude-rules.sh` does it: a dry run by default, `--apply` to
write. A file that differs is replaced atomically (temp file in the same
directory, then `mv`), so a claude process starting mid-sync never reads half
a file; anything under the destination's `agents/`/`skills/` that is gone
from the source is deleted. It never prints file contents, and refuses any
uid but 1000 and any run with `FOREMAN_SERVICE` set (inside a container).
It runs every 15 minutes from marek's host crontab
(`scripts/install-claude-rules-cron.sh`, log `state/logs/sync-claude-rules.log`)
and on every host `scripts/deploy.sh`. So a shared-rule change flows
homelab's `claude-config/` -> `sync-claude-config.sh` -> marek's
`~/.claude` -> the containers within 15 minutes. Edit the rules in
`claude-config/` (or marek's `~/.claude` for settings.json), never in
`state/home/.claude`: the next run overwrites it. Tests:
`scripts/sync-claude-rules.test.mjs`.

**On a fresh machine:** follow "Rebuild foreman from scratch" at the top of
this README.

**GitHub token (#516):** `scripts/set-github-token.sh` is run by the
operator from their own device (setting a value in the secret store is
admin-only, and admin means a request through its admin proxy at
`KEYRING_URL`, which the script requires; an agent gets 403). It reads the PAT from stdin only (hidden prompt, or a
pipe), never echoes it, checks it against GitHub, declares `GH_TOKEN` in a
new `foreman-github` group for foreman (or replaces the value if declared),
syncs foreman, then runs `gh auth status` and an https `git ls-remote` in a
one-off container over `ssh foreman`. `--dry-run` does everything except
the store write and sync, handing the token to the test container over
ssh's stdin instead. A failure names the step (`read`, `github`, `store-check`,
`store`, `sync`, `verify`) and never quotes the token. Tests:
`scripts/set-github-token.test.mjs` (run by `cd app && npm test`).

## Root access for agent runs (`work root`)

A task labelled `root-access` in pinboard, with a CTID scope, can be granted
temporary root on those containers: the operator picks a TTL when queueing it,
and pinboard records the grant. The host side is rootproxy
(`homelab/rootproxy/`, a past task), a forced command on root's
`authorized_keys` that re-checks the grant on every call. `work root` (task
#266, `app/src/root.ts`) is how the run itself uses it:

    work root status|start|shutdown|reboot <ctid>
    work root exec <ctid> '<shell command>'
    work root set <ctid> <key> <value>
    work root exec --detach <ctid> '<shell command>'   ->  job id
    work root wait <ctid> <job-id>

- **Task id.** Read from `WORK_TASK_ID`, which the runner sets on every spawn.
  If it is missing (runs before a past task went through `sudo -u`, whose
  `env_reset` dropped it), `work root` falls back to the task id in its cwd
  (`/app/tasks/task-<id>/...`).
- **Refuses locally before touching the host** when the task has no
  `root-access` label, no active grant, an expired grant (said as "expired",
  so the agent stops instead of retrying), a CTID outside the grant, or a verb
  or `set` key rootproxy would not accept anyway. Exit 2 for a local refusal;
  the proxy's own refusals come back as exit 77, and ssh failures as 255.
  This side is defence in depth only: the grant check that matters is the
  one on the host.
- **Prompt.** A `root-access` task's prompt lists the CTIDs in scope, the
  expiry and the verbs (`rootAccessLines` in `runner.ts`). No other task's
  prompt mentions root.
- **SSH.** `ssh -o BatchMode=yes root@homelab <task> <verb> <ctid> ...`,
  using the calling user's default key. Both seats' Linux users on foreman
  hold the same key, which is the one installed in root's `authorized_keys`
  as rootproxy's forced command. `WORK_ROOT_HOST` overrides the destination
  (tests only, in practice).
- **Slow commands run detached.** `exec --detach` starts the command under
  `nohup setsid` inside the container, with output and exit code in
  `/root/rootjobs/<job>.{log,rc}`, so it survives the ssh connection dropping
  (the router kills long-lived connections, and an apt upgrade killed midway
  is the worst outcome here). `work root wait` is one proxy `exec` that
  blocks inside the container for up to 29 minutes, then prints the log tail
  and exits with the job's code, or 75 if it is still running. Waiting
  inside one tool call costs no tokens; only the agent's turns do. The first
  #206 run backgrounded its upgrade itself and ended its session while apt
  was still running, which is what this replaces.
- **Long waits are not counted against the run.** The runner passes
  `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` of 30 minutes (in the env
  and again through `--settings`), and
  its hard timeout pauses while `/app/tasks/task-<id>/.root-wait` names a
  live `work root wait` process, the same way it pauses for an unanswered
  question.
- **Audit.** Every call, allowed or refused, is in the host journal
  (`journalctl -t rootproxy`), `/var/log/rootproxy.log`, and a comment on the
  task.
- **No commits is not a failure here.** A session that commits nothing
  normally goes to rework ("made no commits"). A task labelled `root-access`
  or `no-repo-change` (a past task, `decideNoCommitOutcome` in `runner.ts`)
  goes to review with a success comment instead, as long as its handoff
  fills in both Completed and Verified; a blank one still goes to rework.
  Review rather than done, since no PR, CI or deploy backs the claim up.
  Any task, labelled or not, can also end with the handoff's `outcome` set:
  `already_done` (the work was already on main, an alert had already
  cleared) closes it as done if Verified is filled in, and `rejected` (a task
  that says to reject it when it does not apply, such as an npm consumer
  bump) closes it as rejected if Completed gives the reason. Without that
  evidence it goes to rework as before. These used to sit in rework until a
  human closed them, which stalled stories behind them.

## Access modes

Matches `pinboard-initial-idea.md`'s "Two access modes": at a desk, VSCode
Remote-SSH into this LXC (`ssh foreman` already works from the desktop -
point Remote-SSH at host `foreman`, no extra config needed); away from
one, Claude remote access. The WSL desktop keeps its own repo clones and
SSH access to every LXC as a fallback, per the workspace `AGENTS.md`.

## Local development

    cd app
    npm install
    npm run typecheck
    npm test          # also runs scripts/*.test.mjs

The services never run a host build: `work` is compiled into the image, so
what runs is exactly what `scripts/deploy.sh` last built from `/app`. The
old "two clones, one `npm link`" gotcha (the global `work` pointed at
whichever checkout last ran `npm link`, so a rebuild in the other one
silently changed nothing) no longer affects the runner.

For the operator's own `work` on the host, `npm link` from `app/` in the
workspace clone (`/app/workspace/<org>/foreman`, which
`~/projects` points at) after `npm run build`; `docker compose exec
dispatch work <args>` works without any host install.

## Rollback to the systemd units

The unit files stay in `systemd/` for this, with
`scripts/install-dispatch-service.sh` to install them. `scripts/deploy.sh`
retires any unit it finds installed, so roll the code back first:

1. Revert the #518 merge on `main` and pull it into `/app` (`git revert
   <merge sha> && git push`, then `git pull` in `/app`). Do not run the
   old deploy.sh yet.
2. Stop the containers, each once idle (`docker compose ps`, then
   `docker compose stop dispatch chat pipeline`; `down` also works).
3. `scripts/install-dispatch-service.sh`, which copies the three units into
   `~/.config/systemd/user` and `enable --now`s them. The old deploy.sh
   rebuilds the host's `/app/app` build they run from: `cd /app/app && npm
   ci && npm run build && npm link`.
4. The housekeeping timer's units were deleted in #518; restore them with
   `git show <merge sha>^:systemd/foreman-housekeeping.timer` (and
   `.service`, and `scripts/install-housekeeping-timer.sh`), and remove the
   `# foreman-housekeeping` lines from `crontab -e`.

`~/projects` stays a symlink to `/app/workspace`; the units work through it
unchanged.

## Secrets

`.claude/settings.json` denies Claude Code from reading or editing
`.env`/`.env.*`. When adding a credential, put the real value in `.env`
and reference it as `${VAR}`.

Do not run a recursive `chown` on `/app`.
