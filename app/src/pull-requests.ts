// I15: keeps pinboard's linked-PR state (open/merged/closed) fresh by
// polling `gh pr view` for every PR still recorded as open - pinboard itself
// never talks to GitHub, so this is the only place that state gets updated
// after creation. Each PR is handled independently so one bad PR can't block
// the rest of the pass.
//
// runs from the pipeline loop (every PR_SYNC_INTERVAL_MS) rather
// than the dispatch loop, and flags a `done` task whose PR GitHub still has
// open - once per PR, by the comment's own text.
//
// After the state sync the same pass restacks stacked PRs whose parent moved
// or merged (see restack.ts): a parent's new head is only seen here, every
// PR_SYNC_INTERVAL_MS, while a merge the pipeline does itself restacks at
// once.

import { execFileSync } from "node:child_process";
import { restackOpenPrs, type RestackOutcome } from "./restack.js";
import {
  addComment,
  getComments,
  getTask,
  listOpenPullRequests,
  listPullRequests,
  updatePullRequestState,
  type Actor,
  type PullRequest,
} from "./pinboard.js";

export const PR_SYNC_INTERVAL_MS = 10 * 60 * 1000;

const PR_SYNC_ACTOR: Actor = { actorType: "agent", actorName: "foreman-pipeline" };

export interface PollPullRequestsResult {
  checked: number;
  updated: number;
  flagged: number;
  restacked: RestackOutcome[];
}

export type GhPrState = "open" | "merged" | "closed";

export function parseGhPrState(raw: string): GhPrState | null {
  try {
    const state = String(JSON.parse(raw).state).toLowerCase();
    return state === "open" || state === "merged" || state === "closed" ? state : null;
  } catch {
    return null;
  }
}

// GitHub's state for one PR, or why it couldn't be read (gh missing, PR
// deleted, auth hiccup, transient network error, unexpected output).
export function ghStateOrReason(url: string): GhPrState | { reason: string } {
  try {
    const raw = execFileSync("gh", ["pr", "view", url, "--json", "state"], { stdio: "pipe" }).toString();
    return parseGhPrState(raw) ?? { reason: `unexpected gh output for ${url}` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") return { reason: "gh is not installed" };
    const stderr = e.stderr?.toString().trim().split("\n")[0];
    return { reason: `gh pr view ${url} failed: ${stderr || e.message}` };
  }
}

// The sync pass leaves the stored state as-is on any gh failure and retries
// on the next pass.
function ghState(url: string): GhPrState | null {
  const state = ghStateOrReason(url);
  return typeof state === "string" ? state : null;
}

export function doneButOpenComment(url: string): string {
  return `Done but PR still open: ${url}`;
}

// Pure: what one open PR row turns into, given GitHub's answer. `taskStatus`
// and `comments` are only needed (and only fetched) when GitHub says open.
export function decidePrSync(input: {
  pr: Pick<PullRequest, "url" | "state">;
  ghState: GhPrState | null;
  taskStatus?: string;
  comments?: readonly { body: string }[];
}): { patch: GhPrState | null; comment: string | null } {
  const { pr, ghState, taskStatus, comments } = input;
  if (!ghState) return { patch: null, comment: null };
  if (ghState !== pr.state) return { patch: ghState, comment: null };
  if (ghState === "open" && taskStatus === "done") {
    const body = doneButOpenComment(pr.url);
    if (!(comments ?? []).some((c) => c.body.includes(body))) return { patch: null, comment: body };
  }
  return { patch: null, comment: null };
}

export async function pollPullRequests(
  state: (url: string) => GhPrState | null = ghState,
  restack: () => Promise<RestackOutcome[]> = () => restackOpenPrs(),
): Promise<PollPullRequestsResult> {
  const openPrs = await listOpenPullRequests();
  let updated = 0;
  let flagged = 0;
  for (const pr of openPrs) {
    try {
      const gh = state(pr.url);
      let taskStatus: string | undefined;
      let comments: { body: string }[] | undefined;
      if (gh === "open") {
        taskStatus = (await getTask(pr.taskId)).status;
        if (taskStatus === "done") comments = await getComments(pr.taskId);
      }
      const decision = decidePrSync({ pr, ghState: gh, taskStatus, comments });
      if (decision.patch) {
        await updatePullRequestState(pr.taskId, pr.id, decision.patch);
        updated++;
      }
      if (decision.comment) {
        await addComment(pr.taskId, PR_SYNC_ACTOR, decision.comment);
        flagged++;
      }
    } catch (err) {
      console.error(`pr-sync: ${pr.url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let restacked: RestackOutcome[] = [];
  try {
    restacked = await restack();
  } catch (err) {
    console.error(`pr-sync: restack failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const r of restacked) if (r.result !== "skipped" && r.result !== "current") console.log(`restack: ${r.prUrl} ${r.result}: ${r.note}`);
  return { checked: openPrs.length, updated, flagged, restacked };
}

function prLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : url;
}

export interface PrSyncDeps {
  listPrs: (taskId: number) => Promise<PullRequest[]>;
  updateState: (taskId: number, prId: number, state: GhPrState) => Promise<{ status: number }>;
  ghState: (url: string) => GhPrState | { reason: string };
}

// `work task complete`: pinboard refuses to complete a task while a linked PR
// row is still open, and only the sync pass above moves a row to merged, up
// to PR_SYNC_INTERVAL_MS after a merge done outside foreman (`gh pr merge`).
// So ask GitHub about each open row first and record a merge or close it
// already has. A PR GitHub still has open is left alone and pinboard's 409
// stands; if gh can't answer, the 409 carries the reason.
export async function completeWithPrSync<T>(
  taskId: number,
  complete: () => Promise<T>,
  deps: PrSyncDeps = { listPrs: listPullRequests, updateState: updatePullRequestState, ghState: ghStateOrReason },
): Promise<{ result: T; notes: string[] }> {
  const notes: string[] = [];
  const reasons: string[] = [];
  let prs: PullRequest[] = [];
  try {
    prs = await deps.listPrs(taskId);
  } catch (err) {
    reasons.push(`could not list the task's PRs: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const pr of prs) {
    if (pr.state !== "open") continue;
    const gh = deps.ghState(pr.url);
    if (typeof gh !== "string") {
      reasons.push(gh.reason);
      continue;
    }
    if (gh === "open") continue;
    try {
      const { status } = await deps.updateState(taskId, pr.id, gh);
      if (status >= 400) throw new Error(`pinboard answered ${status}`);
      notes.push(`${prLabel(pr.url)} was ${gh} on GitHub; synced before completing`);
    } catch (err) {
      reasons.push(`could not record ${prLabel(pr.url)} as ${gh}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    return { result: await complete(), notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(reasons.length ? `${message} (GitHub check skipped: ${reasons.join("; ")})` : message, { cause: err });
  }
}
