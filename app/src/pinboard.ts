// Client for pinboard's API (see ../../pinboard/app/src/routes.ts for the
// source of truth). foreman is the only consumer with no auth beyond
// tailnet-trust, same as every other internal service-to-service call in
// this org - reached over the tailnet hostname directly, not through
// reverse-proxy.

import { SseParser, type SseEvent } from "./sse.js";

const BASE_URL = process.env.PINBOARD_URL ?? "http://pinboard:8095";
// Pinboard PINBOARD_URL is the origin; the JSON API lives under /api.
const API_URL = `${BASE_URL}/api`;

// the three stages that hand a task back to an agent rather than
// to a human. pinboard refuses a handback to `queued` that carries no reason,
// so a stage that fails in a way no agent can fix (a wedged deploy lock, a PR
// that was never recorded) parks in `rework` instead of handing back.
export type RepairReason = "ci_failed" | "merge_conflict" | "deploy_failed";

export interface Task {
  id: number;
  projectId: number;
  title: string;
  description: string | null;
  taskType: string;
  status: string;
  executorMode: string;
  priority: number;
  autonomyLevel: number | null;
  estimatedEffort: number | null;
  actualCostUsd: string | null;
  actualDurationMs: number | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  controlAction: "stop" | "kill" | null;
  controlRequestedAt: string | null;
  // last `claude -p` session id for this task's coding attempts,
  // and the workdir it's still sitting in - see setSessionState below for why
  // the column kept the `worktree` name after a past task, and runner.ts's
  // prepareAttempt for how both are used. The branch is derived from the task
  // id (`task-<id>`), not from this field.
  claudeSessionId: string | null;
  // which license's `~/.claude` the session id above lives in. A
  // session is only resumable by the Linux user that created it, so this is
  // what prepareAttempt checks before handing it to `claude --resume`. Null
  // means the owner is unknown (a session retained before this field
  // existed, on a pinboard that predates it), which is treated as
  // not-resumable rather than assumed to be ours.
  claudeSessionLicenseId: number | null;
  activeWorktreeName: string | null;
  // other pinboard projects this task's agent run may read/write
  // directly, on top of whatever its own project.relatedProjectIds already
  // grants - see schema.ts's comment on the column for the full effective-
  // repo-set formula and runner.ts's relatedRepoLines for how it's used.
  relatedProjectIds: number[];
  // why the pipeline handed this task back to `queued` for another
  // agent run, and the evidence that run needs (the failing CI step's log,
  // git's conflict output, the deploy/healthcheck stderr). Set only by POST
  // /tasks/:id/pipeline, cleared by the next transition out of `queued` and
  // by any human requeue - see runner.ts's repairPromptLines.
  repairReason: RepairReason | null;
  repairContext: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  labels: { id: number; name: string; color: string | null }[];
  // Pinboard open asks and those answered in the last 7 days.
  // Optional so an older pinboard that doesn't return it still parses.
  asks?: TaskAsk[];
}

// a run's structured question or assumption (pinboard's
// task_asks row, see its asks.ts).
export interface AskOption {
  label: string;
  rationale: string | null;
  recommended: boolean;
}

export interface TaskAsk {
  id: number;
  taskId: number;
  threadId: number | null;
  kind: "question" | "assumption";
  context: string | null;
  question: string;
  options: AskOption[];
  status: "open" | "answered" | "vetoed" | "accepted";
  answerOption: number | null;
  answerText: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface NewAskInput extends Partial<Actor> {
  kind: "question" | "assumption";
  question: string;
  context?: string;
  options?: { label: string; rationale?: string; recommended?: boolean }[];
  threadId?: number;
}

export function createAsk(taskId: number, input: NewAskInput): Promise<TaskAsk> {
  return post(`/tasks/${taskId}/asks`, input);
}

// Pinboard answers an open ask, same as the inbox's Answer button -
// pinboard posts the answer into the task's thread and requeues a task parked
// in needs_input.
export function answerAsk(
  askId: number,
  input: Partial<Actor> & { option?: number; text?: string },
): Promise<{ ask: TaskAsk; taskStatus: string | null }> {
  return post(`/asks/${askId}/answer`, input);
}

export interface Comment {
  id: number;
  taskId: number;
  authorType: string;
  authorName: string;
  body: string;
  createdAt: string;
}

// I15: structured PR/MR tracking, paired to the task instead of a plain-text
// comment - see pinboard/app/src/db/schema.ts's pullRequests.
export interface PullRequest {
  id: number;
  taskId: number;
  url: string;
  repoSlug: string;
  branchName: string | null;
  state: "open" | "merged" | "closed";
  attemptNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  // Path to the project's local checkout, relative to WORKSPACE_ROOT
  // (default ~/projects) - always org/name, e.g. "my-org/pinboard".
  localPath: string | null;
  // I13: explicit per-project opt-in for autonomous merge + deploy.
  autoDeployAllowed: boolean;
  // other pinboard projects whose repos an agent run for this
  // project needs write access to, beyond its own localPath - see
  // pinboard's schema.ts for the full explanation.
  relatedProjectIds: number[];
}

export interface TaskEvent {
  id: number;
  taskId: number;
  eventType: string;
  actorType: string;
  actorName: string;
  payload: unknown;
  createdAt: string;
}

export interface Handoff {
  id: number;
  taskId: number;
  agentId: number | null;
  completed: string | null;
  changed: string | null;
  verified: string | null;
  problems: string | null;
  discovered: string | null;
  next: string | null;
  estimatedNextEffort: number | null;
  costUsd: string | null;
  durationMs: number | null;
  numTurns: number | null;
  permissionDenials: unknown;
  createdAt: string;
  // Set on GET /tasks rows (pinboard derives it from the child relation).
  parentTaskId?: number | null;
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`);
  if (!resp.ok) {
    throw new Error(`${API_URL}${path} -> ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${API_URL}${path} -> ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return resp.json() as Promise<T>;
}

// Distinct from post()'s error handling: a 409 here is an expected, callable
// outcome (the task is leased to a live run), not a hard failure - callers
// branch on resp.status themselves rather than getting an exception.
async function patch<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as T;
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`${API_URL}${path} -> ${resp.status} ${JSON.stringify(data)}`);
  }
  return { status: resp.status, data };
}

// pinboard uses DELETE for a revoke (the row stays, revokedAt is
// set) rather than a hard delete, so this returns the updated row like the
// others rather than nothing.
async function del<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, { method: "DELETE" });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${API_URL}${path} -> ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return resp.json() as Promise<T>;
}

// For endpoints that answer 204 No Content, where post()/del() would choke
// parsing an empty body as JSON.
async function sendNoContent(method: string, path: string, body?: unknown): Promise<void> {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${API_URL}${path} -> ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`);
  }
}

export interface TaskFilter {
  projectId?: number;
  status?: string;
  taskType?: string;
  executorMode?: string;
  hasActiveWorktree?: boolean;
  parentTaskId?: number;
}

export function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filter.projectId) params.set("projectId", String(filter.projectId));
  if (filter.status) params.set("status", filter.status);
  if (filter.taskType) params.set("taskType", filter.taskType);
  if (filter.executorMode) params.set("executorMode", filter.executorMode);
  if (filter.hasActiveWorktree) params.set("hasActiveWorktree", "true");
  if (filter.parentTaskId) params.set("parentTaskId", String(filter.parentTaskId));
  const qs = params.toString();
  return get(`/tasks${qs ? `?${qs}` : ""}`);
}

export function getTask(id: number): Promise<TaskDetail> {
  return get(`/tasks/${id}`);
}

// a task's root grant, as rootproxy on the Proxmox host sees it.
// `ctids` is the task's labelled scope even when no grant is active.
export interface RootGrant {
  taskId: number;
  active: boolean;
  ctids: number[];
  expiresAt: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
}

export function getRootGrant(taskId: number): Promise<RootGrant> {
  return get<RootGrant>(`/tasks/${taskId}/root-grant`);
}

export function getComments(taskId: number): Promise<Comment[]> {
  return get(`/tasks/${taskId}/comments`);
}

// I10/I20: parent | child | related | depends_on - see pinboard's
// schema.ts comment on taskRelations. otherTask is null only if the linked
// task was deleted after the relation was created.
export interface TaskRelation {
  id: number;
  fromTaskId: number;
  toTaskId: number;
  relationType: "parent" | "child" | "related" | "depends_on";
  direction: "from" | "to";
  otherTask: { id: number; title: string; status: string } | null;
}

export function getTaskRelations(taskId: number): Promise<TaskRelation[]> {
  return get(`/tasks/${taskId}/relations`);
}

// lets the planning chat wire a `depends_on` (or other)
// relation between two already-created tasks - parent/child is also a
// taskRelations row (relationType "child", fromTaskId the parent), created
// via CreateTaskInput.parentTaskId's `work task create --parent=` path
// instead of this function directly, but the two share the same table.
export function createTaskRelation(
  taskId: number,
  input: { toTaskId: number; relationType: "parent" | "child" | "related" | "depends_on" },
): Promise<TaskRelation> {
  return post(`/tasks/${taskId}/relations`, input);
}

export async function deleteTaskRelation(taskId: number, relationId: number): Promise<void> {
  await sendNoContent("DELETE", `/tasks/${taskId}/relations/${relationId}`);
}

// fields `work task update` may PATCH. Unlike patch()'s other
// callers, a 409 here (task leased to a live run) is a plain failure.
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: string;
  taskType?: string;
  executorMode?: string;
  priority?: number;
  autonomyLevel?: number;
  estimatedEffort?: number;
}

export async function updateTask(taskId: number, input: UpdateTaskInput): Promise<Task> {
  const { status, data } = await patch<Task>(`/tasks/${taskId}`, input);
  if (status === 409) throw new Error(`task ${taskId} is leased to a live run: ${JSON.stringify(data)}`);
  return data;
}

export interface Label {
  id: number;
  name: string;
  color: string | null;
}

export function listLabels(): Promise<Label[]> {
  return get("/labels");
}

export function createLabel(name: string): Promise<Label> {
  return post("/labels", { name });
}

export async function addLabelToTask(taskId: number, labelId: number): Promise<void> {
  await sendNoContent("POST", `/tasks/${taskId}/labels`, { labelId });
}

export async function removeLabelFromTask(taskId: number, labelId: number): Promise<void> {
  await sendNoContent("DELETE", `/tasks/${taskId}/labels/${labelId}`);
}

export function listProjects(): Promise<Project[]> {
  return get("/projects");
}

// lets a running agent grant itself write access to a repo it
// discovers it needs mid-task, without stopping to ask a human first -
// fetches the task's current relatedProjectIds (another attempt or a human
// may have added one since this session started) and unions in the new id
// rather than overwriting, since PATCH /tasks/:id replaces the whole array.
export async function addRelatedProjectToTask(taskId: number, projectId: number): Promise<Task> {
  const task = await getTask(taskId);
  const relatedProjectIds = Array.from(new Set([...task.relatedProjectIds, projectId]));
  const { data } = await patch<Task>(`/tasks/${taskId}`, { relatedProjectIds });
  return data;
}

// I12a: agent definitions and routing rules - see pinboard's routes.ts and
// routing.ts for how these are resolved to pick which agent runs a task.
export interface Agent {
  id: number;
  name: string;
  role: string | null;
  provider: string;
  model: string | null;
  executor: string;
  autonomyLevel: number;
  credentialRef: string | null;
  routingWeight: number;
  enabled: boolean;
  // which license this agent runs under - determines
  // the OAuth token its `claude` spawn gets (license.tokenEnvVar, see
  // spawn-env.ts) and the budget/usage/concurrency scope its runs count
  // against.
  licenseId: number;
  // grants this agent's chat threads the unrestricted host
  // persona (see chat.ts's resolvePersona) instead of the restricted
  // read-only planning persona every other agent gets. Per-agent rather than
  // a single hardcoded agent name, so each license can flag its own.
  isHost: boolean;
}

// an account/seat under a provider (e.g. a second person's
// own Claude subscription) - see pinboard's schema.ts for the full comment.
export interface License {
  id: number;
  name: string;
  provider: string;
  linuxUser: string;
  // name of the env var holding this seat's OAuth token (never
  // the value). null = foreman's own login. Optional: older pinboards lack it.
  tokenEnvVar?: string | null;
  sessionBudgetUsd: string | null;
  concurrencyLimit: number | null;
  enabled: boolean;
}

export function listLicenses(): Promise<License[]> {
  return get("/licenses");
}

export interface RoutingRule {
  id: number;
  taskType: string | null;
  labelName: string | null;
  agentId: number;
  priority: number;
  enabled: boolean;
}

export function listAgents(): Promise<Agent[]> {
  return get("/agents");
}

export function listRoutingRules(): Promise<RoutingRule[]> {
  return get("/routing-rules");
}

export function getEvents(taskId: number): Promise<TaskEvent[]> {
  return get(`/tasks/${taskId}/events`);
}

export interface ProjectHandoff extends Handoff {
  taskTitle: string;
}

export function getProjectHandoffs(projectId: number, limit = 20): Promise<ProjectHandoff[]> {
  return get(`/projects/${projectId}/handoffs?limit=${limit}`);
}

export interface Actor {
  actorType: string;
  actorName: string;
}

export function claimTask(taskId: number, actor: Actor): Promise<Task> {
  return post(`/tasks/${taskId}/claim`, actor);
}

// leaseSeconds makes this the I4a agent-runner claim: fails with a 409
// (returned, not thrown - the runner treats "already leased" as a normal
// outcome to report and back off from) if the task is currently leased to
// another live run. See pinboard's routes.ts claim handler.
export async function claimTaskWithLease(
  taskId: number,
  actor: Actor,
  leaseSeconds: number,
): Promise<{ leased: true; task: Task } | { leased: false; reason: string; leaseExpiresAt?: string }> {
  const resp = await fetch(`${API_URL}/tasks/${taskId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...actor, leaseSeconds }),
  });
  const data = (await resp.json()) as Task & { error?: string; leaseExpiresAt?: string };
  // I6: a 409 here isn't only "already leased" any more - it can also be a
  // concurrency-limit refusal (see pinboard's routes.ts claim handler),
  // which carries no leaseExpiresAt. `reason` covers both.
  if (resp.status === 409) {
    return { leased: false, reason: data.error ?? "task is leased to a live agent run", leaseExpiresAt: data.leaseExpiresAt };
  }
  if (!resp.ok) throw new Error(`${API_URL}/tasks/${taskId}/claim -> ${resp.status} ${JSON.stringify(data)}`);
  return { leased: true, task: data as Task };
}

export function renewLease(taskId: number, leaseSeconds: number): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() });
}

export function releaseLease(taskId: number): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { leaseExpiresAt: null });
}

export function setAttemptCount(taskId: number, attemptCount: number): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { attemptCount });
}

export function setTaskStatus(taskId: number, status: string): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { status });
}

// requeue and set the attempt count in the SAME patch, on purpose.
// pinboard's PATCH /tasks/:id resets attemptCount to 0 whenever status becomes
// "queued" and the body does not name attemptCount itself (it has to: a task
// requeued from rework with its old count would otherwise re-hit the cap
// immediately). Calling setAttemptCount and then setTaskStatus would therefore
// have the reset silently undo the first call - so a session-limit refund of
// one attempt would become a full reset, handing a genuinely struggling task a
// fresh cap it has not earned.
export function requeueWithAttemptCount(taskId: number, attemptCount: number): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { status: "queued", attemptCount });
}

// persists (or clears, passing null) the session and the workdir a
// later attempt can try to `--resume` into - see runner.ts's prepareAttempt.
// The column is still called activeWorktreeName: a past task replaced worktrees
// with per-task clones but left the name alone, since a rename would have
// been a migration that changes nothing. What it holds is the task workdir's
// directory name (`task-<id>`), and it stays the flag the sweep filters on.
export function setSessionState(
  taskId: number,
  fields: { claudeSessionId: string | null; claudeSessionLicenseId: number | null; activeWorktreeName: string | null },
): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, fields);
}

// I4c: the runner polls this itself between control checks (see
// runner.ts's runOneAttempt) and clears it once a stop/kill request has
// been acted on, so a stale flag doesn't re-trigger on the next attempt.
export function clearControl(taskId: number): Promise<{ status: number; data: Task }> {
  return patch(`/tasks/${taskId}`, { controlAction: null, controlRequestedAt: null });
}

export interface CreateTaskInput {
  projectId: number;
  title: string;
  description?: string;
  taskType?: string;
  status?: string;
  executorMode?: string;
  priority?: number;
  autonomyLevel?: number;
  estimatedEffort?: number;
  // tasks.parentTaskId was dropped in favor of taskRelations
  // (the single source of truth foreman's runner.ts already reads for
  // subtask context) - createTask wires this up as a "child" relation
  // (fromTaskId: parentTaskId, toTaskId: the new task) after the task
  // itself is created, rather than as a column on the insert.
  parentTaskId?: number;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const { parentTaskId, ...body } = input;
  const task = await post<Task>("/tasks", body);
  if (parentTaskId !== undefined) {
    await createTaskRelation(parentTaskId, { toTaskId: task.id, relationType: "child" });
  }
  return task;
}

export function completeTask(taskId: number, actor: Actor): Promise<Task> {
  return post(`/tasks/${taskId}/complete`, actor);
}

export function addComment(taskId: number, actor: Actor, body: string): Promise<Comment> {
  return post(`/tasks/${taskId}/comments`, { authorType: actor.actorType, authorName: actor.actorName, body });
}

// I19: turn-by-turn activity from a running headless session, tailed from
// `claude -p`'s stream-json output by runner.ts - see pinboard's routes.ts
// for why this always lands as eventType "activity".
export function recordActivity(taskId: number, actor: Actor, payload: Record<string, unknown>): Promise<void> {
  return post(`/tasks/${taskId}/events`, { actorType: actor.actorType, actorName: actor.actorName, payload });
}

export function addPullRequest(
  taskId: number,
  input: { url: string; repoSlug: string; branchName?: string; attemptNumber?: number },
): Promise<PullRequest> {
  return post(`/tasks/${taskId}/pull-requests`, input);
}

export function listOpenPullRequests(): Promise<PullRequest[]> {
  return get(`/pull-requests?state=open`);
}

// checked before pushing a resumed attempt's branch, so a PR
// already open for it (mergeAndDeploy's CI check failed last time, PR never
// merged) doesn't get a duplicate `gh pr create` on top of it.
export function listPullRequests(taskId: number): Promise<PullRequest[]> {
  return get(`/tasks/${taskId}/pull-requests`);
}

export function updatePullRequestState(
  taskId: number,
  prId: number,
  state: "open" | "merged" | "closed",
): Promise<{ status: number; data: PullRequest }> {
  return patch(`/tasks/${taskId}/pull-requests/${prId}`, { state });
}

// A past task: the post-PR pipeline. pinboard
// owns the state machine and refuses an illegal move (see its own
// pipeline.ts); foreman's poller (pipeline.ts here) owns the doing. The
// payload is everything a stateless poller needs in one round trip, so it
// never has to keep its own idea of what a task is in the middle of.
export type PipelineStage = "awaiting_ci" | "awaiting_merge" | "awaiting_review" | "deploying" | "verifying";

export interface PipelineTask {
  taskId: number;
  title: string;
  stage: PipelineStage;
  stageEnteredAt: string | null;
  attemptCount: number;
  projectId: number;
  projectSlug: string;
  // Full "org/name" path, like Project.localPath - the bare repo name that
  // `gh --repo` and deploy-service.sh take is its basename.
  localPath: string | null;
  autoDeployAllowed: boolean;
  // A past task. Optional because foreman and pinboard deploy separately: a
  // pinboard that predates the field sends none, which routeHandback treats
  // as "not autonomous" and parks - the safe side of a race between agents.
  executorMode?: string;
  prUrl: string | null;
  prBranch: string | null;
  prRepoSlug: string | null;
}

export function getPipelineNext(): Promise<PipelineTask[]> {
  return get(`/pipeline/next`);
}

export function advancePipeline(
  taskId: number,
  actor: Actor,
  to: string,
  repair?: { reason: RepairReason; context?: string },
): Promise<Task> {
  return post(`/tasks/${taskId}/pipeline`, {
    ...actor,
    to,
    ...(repair ? { repairReason: repair.reason, repairContext: repair.context } : {}),
  });
}

export interface HandoffInput extends Actor {
  agentName?: string;
  completed?: string;
  changed?: string;
  verified?: string;
  problems?: string;
  discovered?: string;
  next?: string;
  // markdown TL;DR (at most 5 lines, plus a "Needs you:" line).
  summary?: string;
  estimatedNextEffort?: number;
  costUsd?: string;
  durationMs?: number;
  numTurns?: number;
  permissionDenials?: unknown;
}

export function submitHandoff(taskId: number, input: HandoffInput): Promise<Handoff> {
  return post(`/tasks/${taskId}/handoff`, input);
}

// PLAN.md's I6 governor - see pinboard's governor.ts for the full model.
export type GovernorState = "unconfigured" | "healthy" | "over_rate" | "danger" | "critical";

export interface Observation {
  id: number;
  scope: "week" | "session";
  percentRemaining: number;
  note: string | null;
  observedAt: string;
  createdAt: string;
}

interface ScopeStatus {
  scope: "week" | "session";
  latestObservation: Observation | null;
  ageMs: number | null;
  availablePercent: number | null;
  state: GovernorState;
  costSinceObservationUsd: number | null;
  impliedDollarsPerPercent: number | null;
}

export interface ExecutingTask {
  taskId: number;
  projectId: number;
  actorName: string | null;
  provider: string | null;
}

export interface GovernorStatus {
  week: ScopeStatus;
  session: ScopeStatus;
  state: GovernorState;
  reserveFloorPercent: number;
  thresholds: { overRatePercent: number; dangerPercent: number; criticalPercent: number; priorityGate: number };
  nextWeeklyResetAt: string;
  hoursUntilWeeklyReset: number;
  concurrency: {
    limits: { global: number; perAgent: number; perProject: number; perProvider: number };
    executing: ExecutingTask[];
  };
}

export function getGovernorStatus(): Promise<GovernorStatus> {
  return get("/governor/status");
}

// the $-based work plan replaced the governor's %-of-allowance
// model as what actually gates work (a past task). foreman no longer
// ranks the queue or evaluates a budget itself - it asks pinboard what may run
// and does that, so the Plan screen and the dispatcher can never disagree
// about what is allowed.
//
// getGovernorStatus above survives only for `work usage status`, which still
// reports the % history. Nothing gates on it.

export interface PlanCandidate {
  taskId: number;
  title: string;
  projectId: number;
  priority: number;
  estimatedCostUsd: number;
  estimateBasis: string;
  running: boolean;
}

export interface PlanNext {
  tasks: PlanCandidate[];
  // Set when the session window's budget is spent but the window hasn't
  // expired: the right move is to sleep until this, not to keep re-asking.
  waitUntil: string | null;
  reason: string | null;
  periodConfigured: boolean;
  periodRemainingUsd: number;
  sessionRemainingUsd: number;
  // this seat's own limit (its override, else the global default).
  concurrency: number;
  // The cross-seat cap. Both apply, and either can be the binding one.
  concurrencyGlobal: number;
  // How much of its own limit this seat is already using, as pinboard sees it
  // (claimed tasks). foreman's own in-flight map is the authority between a
  // start and its claim landing - see dispatchOnce.
  seatRunning: number;
}

// `override` is the operator's explicit "run it anyway" (`work task run
// --override`). It skips the budget gates only - concurrency and the
// repo-conflict rule are never bypassable, since those stop two agents
// writing the same checkout rather than protecting a budget.
//
// `licenseId` is which seat is asking. Omitting it makes pinboard
// answer for its own default license, which is what every caller did before a
// second license existed - and was the bug this task fixed, since a run that
// would spend peter's budget was still gated on marek's. The dispatch loop now
// asks once per enabled license; `work task run` asks for whichever license
// the task's resolved agent belongs to.
export function getPlanNext(licenseId?: number, override = false): Promise<PlanNext> {
  return get(`/plan/next${planQuery(licenseId, override)}`);
}

function planQuery(licenseId: number | undefined, override: boolean): string {
  const params = new URLSearchParams();
  if (licenseId !== undefined) params.set("licenseId", String(licenseId));
  if (override) params.set("override", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export interface PlanGate {
  ok: boolean;
  reason: string | null;
  waitUntil: string | null;
  // the `--max-budget-usd` this run may spend, derived from the
  // task's own cost estimate. Replaces DEFAULT_RUN_OPTIONS.budgetUsd's flat
  // $2, which no task's actual size ever influenced - see runner.ts.
  budgetUsd: number;
}

// "May this specific task start now?" - for the direct `work task run <id>`
// path, which picks its own task rather than taking one from the plan.
export function getPlanGate(taskId: number, licenseId?: number, override = false): Promise<PlanGate> {
  return get(`/plan/gate/${taskId}${planQuery(licenseId, override)}`);
}

// tell pinboard where Claude actually drew the 5h session
// boundary, parsed out of a failed run's error text. pinboard has no other
// source for this - it otherwise infers the boundary from spend, which can
// believe a window has expired while the real one is still running, and then
// hands out task after task into a wall.
//
// Reporting is best-effort at the call site: a run that hit the limit must
// still be requeued and the attempt still refunded even if this POST fails,
// because the alternative is losing the task to rework over a network blip.
export function reportSessionLimit(args: {
  resetsAt: Date;
  licenseId?: number;
  taskId?: number;
  rawError?: string;
}): Promise<{ id: number; resetsAt: string }> {
  return post("/plan/session-limit", {
    resetsAt: args.resetsAt.toISOString(),
    licenseId: args.licenseId,
    taskId: args.taskId,
    rawError: args.rawError,
  });
}

export function recordObservation(scope: "week" | "session", percentRemaining: number, note?: string): Promise<Observation> {
  return post("/governor/observations", { scope, percentRemaining, note });
}

// PLAN.md's I8: planning chat passthrough - see pinboard's routes.ts for
// the source of truth. I9 reuses the same table/API for task-scoped
// session chat (taskId set instead of/alongside projectId).
export interface ChatThread {
  id: number;
  projectId: number | null;
  taskId: number | null;
  agentId: number | null;
  title: string;
  status: "open" | "closed";
  awaitingAgent: boolean;
  claudeSessionId: string | null;
  // per-thread overrides of the agent's own model, plus a
  // reasoning-effort hint - null keeps foreman's own defaults.
  model: "sonnet" | "opus" | null;
  effort: "medium" | "high" | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  role: "human" | "agent";
  body: string;
  createdAt: string;
}

export function listChatThreads(
  filter: { taskId?: number | "none"; awaitingAgent?: boolean; status?: string } = {},
): Promise<ChatThread[]> {
  const params = new URLSearchParams();
  if (filter.taskId !== undefined) params.set("taskId", String(filter.taskId));
  if (filter.awaitingAgent !== undefined) params.set("awaitingAgent", String(filter.awaitingAgent));
  if (filter.status) params.set("status", filter.status);
  const qs = params.toString();
  return get(`/chat/threads${qs ? `?${qs}` : ""}`);
}

export interface CreateChatThreadInput {
  projectId?: number;
  taskId?: number;
  title: string;
}

export function createChatThread(input: CreateChatThreadInput): Promise<ChatThread> {
  return post("/chat/threads", input);
}

// I9: the task's current session chat thread, if any - null on 404 rather
// than throwing, since "no thread yet" is a normal, common outcome for
// both `work task ask` (create one) and the runner's own pause check.
export async function getTaskChatThread(taskId: number): Promise<ChatThread | null> {
  const resp = await fetch(`${API_URL}/tasks/${taskId}/chat-thread`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`${API_URL}/tasks/${taskId}/chat-thread -> ${resp.status} ${resp.statusText}`);
  return resp.json() as Promise<ChatThread>;
}

// exists since I8 - the daemon reads one thread when a message
// arrives for it, rather than listing every thread and filtering.
export function getChatThread(threadId: number): Promise<ChatThread> {
  return get(`/chat/threads/${threadId}`);
}

export function getChatMessages(threadId: number): Promise<ChatMessage[]> {
  return get(`/chat/threads/${threadId}/messages`);
}

export function postChatMessage(threadId: number, role: "human" | "agent", body: string): Promise<ChatMessage> {
  return post(`/chat/threads/${threadId}/messages`, { role, body });
}

// a chat turn's own cost, added to the thread's running total and
// appended to pinboard's usage_events as a `chat`-source row (see pinboard's
// routes.ts). The route has existed since a past task but nothing here ever
// called it, so every chat thread read totalCostUsd "0" and the 5h session
// window silently under-counted every conversation - which defeated the
// operator's main reason for chatting in pinboard rather than in an IDE.
export function postChatUsage(
  threadId: number,
  usage: { costUsd: number; durationMs: number },
): Promise<ChatThread> {
  return post(`/chat/threads/${threadId}/usage`, usage);
}

export function patchChatThread(
  threadId: number,
  fields: Partial<Pick<ChatThread, "claudeSessionId" | "status">>,
): Promise<{ status: number; data: ChatThread }> {
  return patch(`/chat/threads/${threadId}`, fields);
}

// ---------------------------------------------------------------------------
// the live-session chat surface.
//
// The I8 bridge above (messages + usage + awaitingAgent) stays exactly as it
// is - a thread's transcript is still a list of `messages`, and the PWA's
// history still reads it. What is new is everything that happens *during* a
// turn: a live Claude session emits tool calls, text deltas and permission
// requests continuously, and none of that fits "one row when the turn is
// over". Those go to `events` (append-only, trimmed by pinboard), and the
// operator's side of the conversation comes back over an SSE subscription
// foreman holds open - foreman still accepts no inbound connections, so this
// is the same outbound-only shape the poller had, just without the polling.
// ---------------------------------------------------------------------------

export type ChatEventKind =
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "thinking"
  | "permission_request"
  | "permission_decision"
  // AskUserQuestion's option cards and the operator's picks. A
  // question is NOT a permission request - the session is not deciding
  // whether a tool may run, it is waiting for the tool's own answer - so it
  // is its own kind rather than an overloaded permission_request.
  | "question"
  | "question_answer"
  | "cost"
  | "error"
  | "turn_start"
  | "turn_end";

export interface ChatEventInput {
  kind: ChatEventKind;
  payload: unknown;
  // Which turn of the thread this belongs to, and its order within the batch
  // - both foreman's own numbering, since a live session produces events far
  // faster than a row id can meaningfully order them for a replaying client.
  turn?: number;
  seq?: number;
}

export interface ChatEvent extends ChatEventInput {
  id: number;
  threadId: number;
  createdAt: string;
}

// Deliberately never rejects. A chat event is a progress notification: losing
// one to a pinboard restart or a network blip is a cosmetic gap in the live
// view, while throwing would take down the session that is mid-tool-call and
// cost the operator the whole turn. The authoritative record of a turn is
// still the agent message posted at the end (postChatMessage), which does
// throw and is retried by its caller.
export async function postChatEvents(
  threadId: number,
  events: ChatEventInput[],
): Promise<{ inserted: number; trimmed: number } | null> {
  if (events.length === 0) return { inserted: 0, trimmed: 0 };
  try {
    return await post<{ inserted: number; trimmed: number }>(`/chat/threads/${threadId}/events`, { events });
  } catch (err) {
    console.error(
      `chat: thread #${threadId} dropped ${events.length} event(s): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function listChatEvents(
  threadId: number,
  opts: { since?: number; limit?: number } = {},
): Promise<ChatEvent[]> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return get(`/chat/threads/${threadId}/events${qs ? `?${qs}` : ""}`);
}

// A "don't ask again" the operator granted, persisted so it survives a
// foreman restart - the SDK's own updatedPermissions only live as long as the
// session process does (destination "session"), which is exactly what made
// permission-server.ts's rememberedThisTurn forget everything between turns.
export interface ChatPermissionRule {
  id: number;
  threadId: number;
  toolName: string;
  ruleContent: string | null;
  behavior: "allow" | "deny" | "ask";
  scope: "thread" | "turn";
  turn: number | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ChatPermissionRuleInput {
  toolName: string;
  ruleContent?: string;
  behavior: "allow" | "deny" | "ask";
  scope: "thread" | "turn";
  turn?: number;
}

// `?turn=` is not optional in practice: without it pinboard applies
// activeRulesForTurn's thread-scoped-only filter and a turn-scoped "allow for
// this turn" grant the operator just made would silently not come back, so
// the very next tool call would ask again. `includeRevoked` is for showing
// history, never for deciding anything.
export function listPermissionRules(
  threadId: number,
  opts: { turn?: number; includeRevoked?: boolean } = {},
): Promise<ChatPermissionRule[]> {
  const params = new URLSearchParams();
  if (opts.turn !== undefined) params.set("turn", String(opts.turn));
  if (opts.includeRevoked) params.set("includeRevoked", "true");
  const qs = params.toString();
  return get(`/chat/threads/${threadId}/permission-rules${qs ? `?${qs}` : ""}`);
}

// Revokes (sets revokedAt on) one of the thread's rules - how a "stop
// always-allowing X" survives a restart, since the SDK's own removeRules
// update only ever applies to the live session.
export function revokePermissionRule(threadId: number, ruleId: number): Promise<ChatPermissionRule> {
  return del(`/chat/threads/${threadId}/permission-rules/${ruleId}`);
}

export function postPermissionRule(
  threadId: number,
  rule: ChatPermissionRuleInput,
): Promise<ChatPermissionRule> {
  return post(`/chat/threads/${threadId}/permission-rules`, rule);
}

// The operator's half of a live conversation, pushed rather than polled.
export type ChatStreamEvent =
  | { type: "human_message"; threadId: number; message: string }
  | {
      type: "permission_decision";
      threadId: number;
      requestId: string;
      behavior: "allow" | "deny";
      updatedPermissions?: unknown[];
    }
  | {
      type: "question_answer";
      threadId: number;
      requestId: string;
      answers: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    }
  | { type: "interrupt"; threadId: number };

// A past task. The two shapes an answer payload carries, validated here rather
// than trusted, because whatever comes back is fed straight into the tool's
// own input - a stray non-string would reach the model as `[object Object]`.
function plainStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

function readAnnotations(value: unknown): Record<string, { preview?: string; notes?: string }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, { preview?: string; notes?: string }> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { preview, notes } = entry as { preview?: unknown; notes?: unknown };
    const cleaned = {
      ...(typeof preview === "string" ? { preview } : {}),
      ...(typeof notes === "string" ? { notes } : {}),
    };
    if (Object.keys(cleaned).length > 0) out[key] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Exported for its own unit test: everything that can go wrong with an SSE
// payload (a name foreman doesn't handle, malformed JSON, a missing
// threadId) has to be a dropped event rather than a thrown error, because
// there is nothing above this worth killing the subscription for.
export function parseChatStreamEvent(raw: SseEvent): ChatStreamEvent | null {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.data);
    if (!parsed || typeof parsed !== "object") return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const threadId = typeof payload.threadId === "number" ? payload.threadId : Number(payload.threadId);
  if (!Number.isFinite(threadId)) return null;

  if (raw.event === "human_message") {
    // pinboard publishes the chat_messages row itself, whose text column is
    // `body` - the same field name POST /chat/threads/:id/messages takes and
    // the same one every other read path here uses. `message` is accepted as
    // a fallback only because an earlier draft of the contract named it that;
    // found live on 2026-09-17, when the first real turn through the daemon
    // silently did nothing at all, because requiring `message` made every
    // genuine event parse to null and be dropped without a log line.
    const text =
      typeof payload.body === "string" ? payload.body : typeof payload.message === "string" ? payload.message : null;
    if (text === null) return null;
    // Defensive: pinboard only publishes this event for human messages, but
    // an agent's own reply arriving here would be fed straight back into the
    // session as if the operator had said it.
    if (payload.role !== undefined && payload.role !== "human") return null;
    return { type: "human_message", threadId, message: text };
  }
  if (raw.event === "permission_decision") {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    const behavior = payload.behavior === "allow" || payload.behavior === "deny" ? payload.behavior : null;
    if (requestId === null || behavior === null) return null;
    return {
      type: "permission_decision",
      threadId,
      requestId,
      behavior,
      updatedPermissions: Array.isArray(payload.updatedPermissions) ? payload.updatedPermissions : undefined,
    };
  }
  if (raw.event === "question_answer") {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId === null) return null;
    // An answer with no picks at all is dropped rather than delivered: the
    // session would treat it as "answered" and hand the tool an empty map,
    // which reads to the model exactly like the operator ignoring the
    // question - except it would have stopped waiting for a real reply.
    const answers = plainStringMap(payload.answers);
    if (answers === null || Object.keys(answers).length === 0) return null;
    const annotations = readAnnotations(payload.annotations);
    return {
      type: "question_answer",
      threadId,
      requestId,
      answers,
      ...(annotations === null ? {} : { annotations }),
    };
  }
  if (raw.event === "interrupt") return { type: "interrupt", threadId };
  return null;
}

// Holds one outbound SSE subscription open until the stream ends or the
// signal aborts, calling onEvent for each event foreman understands.
// Resolving (rather than looping internally) is deliberate: reconnect and
// backoff are chat-daemon.ts's job, so this stays a single connection's
// lifetime and nothing else.
export async function subscribeChatStream(
  onEvent: (event: ChatStreamEvent) => void,
  opts: { signal?: AbortSignal; threadId?: number } = {},
): Promise<void> {
  const qs = opts.threadId === undefined ? "" : `?threadId=${opts.threadId}`;
  const resp = await fetch(`${API_URL}/chat/stream${qs}`, {
    headers: { accept: "text/event-stream" },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`${API_URL}/chat/stream -> ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error(`${API_URL}/chat/stream -> no response body to stream`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseChatStreamEvent(raw);
        if (event) onEvent(event);
      }
    }
  } finally {
    // An aborted signal already tore the body down; cancel is a no-op then and
    // the right cleanup when the caller simply stopped caring.
    await reader.cancel().catch(() => undefined);
  }
}

// the releases view (see releases.ts). These routes answer 204
// for "nothing to return", which the json helpers above cannot parse.
async function send(method: string, path: string, body: unknown): Promise<Response> {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-pinboard-actor": "agent:foreman-releases" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${API_URL}${path} -> ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return resp;
}

export async function putDeployTargets(projectId: number, targets: unknown[]): Promise<void> {
  await send("PUT", `/releases/targets/${projectId}`, { targets });
}

export interface ClaimedDeployRequest {
  id: number;
  projectId: number;
  slug: string;
  localPath: string | null;
  requestedBy: string;
  // "release" is a production release bumping the version by
  // `bump`. Absent from a pinboard that predates it, which means "deploy".
  kind?: "deploy" | "release";
  bump?: "patch" | "minor" | "major" | null;
}

export async function claimDeployRequest(): Promise<ClaimedDeployRequest | null> {
  const resp = await send("POST", "/releases/requests/claim", {});
  return resp.status === 204 ? null : ((await resp.json()) as ClaimedDeployRequest);
}

export async function finishDeployRequest(id: number, ok: boolean, output: string, version?: string): Promise<void> {
  await send("POST", `/releases/requests/${id}/finish`, version ? { ok, output, version } : { ok, output });
}

// see health.ts. Sent only on a transition; 204, no body.
export type HealthStatus = "failing" | "recovered";

export async function reportHealth(report: { check: string; status: HealthStatus; project: string; detail: string | null }): Promise<void> {
  const resp = await fetch(`${API_URL}/health/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pinboard-actor": "system:foreman" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`${API_URL}/health/report -> ${resp.status} ${resp.statusText}`);
}
