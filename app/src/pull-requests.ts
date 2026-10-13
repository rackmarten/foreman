// I15: keeps pinboard's linked-PR state (open/merged/closed) fresh by
// polling `gh pr view` for every PR still recorded as open - pinboard itself
// never talks to GitHub, so this is the only place that state gets updated
// after creation. Each PR is handled independently so one bad PR can't block
// the rest of the pass.
//
// runs from the pipeline loop (every PR_SYNC_INTERVAL_MS) rather
// than the dispatch loop, and flags a `done` task whose PR GitHub still has
// open - once per PR, by the comment's own text.

import { execFileSync } from "node:child_process";
import { addComment, getComments, getTask, listOpenPullRequests, updatePullRequestState, type Actor, type PullRequest } from "./pinboard.js";

export const PR_SYNC_INTERVAL_MS = 10 * 60 * 1000;

const PR_SYNC_ACTOR: Actor = { actorType: "agent", actorName: "foreman-pipeline" };

export interface PollPullRequestsResult {
  checked: number;
  updated: number;
  flagged: number;
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

function ghState(url: string): GhPrState | null {
  try {
    return parseGhPrState(execFileSync("gh", ["pr", "view", url, "--json", "state"], { stdio: "pipe" }).toString());
  } catch {
    // PR deleted, gh auth hiccup, transient network error, etc. - leave the
    // stored state as-is and retry on the next pass.
    return null;
  }
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

export async function pollPullRequests(state: (url: string) => GhPrState | null = ghState): Promise<PollPullRequestsResult> {
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
  return { checked: openPrs.length, updated, flagged };
}
