// I12b: the non-code executor path. An agent whose `executor` is "8ball"
// (routed to by I12a's routing rules, or picked with an explicit --agent=)
// runs here instead of runner.ts's claude -p worktree/commit/PR pipeline -
// a task result is free-form text written back as a comment/handoff, no
// repo/worktree/PR/commit involved at all. Good for research summaries,
// classification, and digest-style writing - not code changes.
//
// Reuses @rackmarten/server-kit's EightBallClient rather than
// reimplementing the gateway's submit-and-poll protocol.

import { EightBallClient } from "@rackmarten/server-kit";
import type { TaskDetail } from "./pinboard.js";

export class EightBallNotConfiguredError extends Error {
  constructor() {
    super(
      "EIGHT_BALL_URL/EIGHT_BALL_API_KEY are not set - required to run a task via an 8ball-executor agent. " +
        "See .env.example and (for the always-on dispatcher) systemd/foreman-dispatch.service's EnvironmentFile.",
    );
    this.name = "EightBallNotConfiguredError";
  }
}

export function createEightBallClient(requester: string): EightBallClient {
  const baseUrl = process.env.EIGHT_BALL_URL;
  const apiKey = process.env.EIGHT_BALL_API_KEY;
  if (!baseUrl || !apiKey) throw new EightBallNotConfiguredError();
  return new EightBallClient({ baseUrl, apiKey, requester });
}

// Deliberately plain text, no code/repo framing - the model here never sees
// a checkout and has no tools, just the task's own title/description.
export function buildEightBallPrompt(task: Pick<TaskDetail, "title" | "description" | "taskType">): string {
  return [
    `You are producing a written result for a pinboard task (type: ${task.taskType}), to be read by a human reviewer.`,
    "This is not a code task - there is no repository, no tools, nothing to commit. Respond with plain text only.",
    "",
    `Title: ${task.title}`,
    task.description ? `Description:\n${task.description}` : "(no description provided)",
  ].join("\n");
}
