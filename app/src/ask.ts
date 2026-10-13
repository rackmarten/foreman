// I9: lets a task's own running `claude -p` session (spawned by runner.ts,
// full DEFAULT_ALLOWED_TOOLS privileges - this is the task-runner session
// itself, not I8's read-only planning chat) pause mid-run and ask the
// operator a question, blocking until a reply arrives. Called as
// `work task ask <id> "<question>"` - a Bash tool the running session
// invokes itself, see agent-settings.ts's DEFAULT_ALLOWED_TOOLS.
//
// Each call blocks for at most `waitSeconds` (default well under what
// Claude Code's own Bash tool is likely to allow before its own timeout
// kills the call - not confirmed exactly where that cap is in this build,
// so this stays safely short rather than guessing) and then returns either
// the reply or a "no reply yet" message telling the model to call again.
// That makes the tool naturally re-callable and resumable regardless of
// the Bash tool's actual cap: a retried call (same question text) finds
// its own still-pending question (see findQuestionMessage) rather than
// posting a duplicate - and if the operator's reply arrived after a prior
// call's own wait window already gave up, the retry finds that reply
// immediately instead of losing it. Asking a genuinely different question
// (different text) always posts fresh.

import {
  createAsk,
  createChatThread,
  getChatMessages,
  getTask,
  getTaskChatThread,
  postChatMessage,
  type Actor,
  type ChatMessage,
  type NewAskInput,
} from "./pinboard.js";

export interface AskOptions {
  waitSeconds: number;
  pollIntervalSeconds: number;
}

export const DEFAULT_ASK_OPTIONS: AskOptions = {
  waitSeconds: 90,
  pollIntervalSeconds: 5,
};

// The most recent agent message with this exact question text, if any -
// matched by text (not just "last message") so a retry finds its own
// question even if a human reply already landed after it (which would
// otherwise be the last message), and so a genuinely different question
// never gets confused with an old one.
export function findQuestionMessage(messages: ChatMessage[], questionText: string): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "agent" && messages[i].body === questionText) return messages[i];
  }
  return undefined;
}

export function findReply(messages: ChatMessage[], askedMessageId: number): ChatMessage | undefined {
  return messages.find((m) => m.id > askedMessageId && m.role === "human");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// a structured ask's options, as parsed from
// `--option="<label>|<rationale>"` flags. `recommended` is the 0-based index.
export interface AskStructure {
  context?: string;
  options: { label: string; rationale?: string }[];
  recommended?: number;
  actor?: Actor;
}

// The chat message body for an ask - the question text plus its context and
// numbered options, so an operator reading the thread sees the same choices
// the asks view offers. Deterministic, since a retry finds its own earlier
// message by exact body (findQuestionMessage).
export function formatAskMessage(question: string, s?: AskStructure): string {
  if (!s || (!s.context && s.options.length === 0)) return question;
  const lines = [question];
  if (s.context) lines.push("", s.context);
  if (s.options.length) {
    lines.push("");
    s.options.forEach((o, i) => {
      const mark = i === s.recommended ? " (recommended)" : "";
      lines.push(`${i + 1}. ${o.label}${mark}${o.rationale ? ` - ${o.rationale}` : ""}`);
    });
  }
  return lines.join("\n");
}

export function askInput(question: string, threadId: number, s?: AskStructure): NewAskInput {
  return {
    ...(s?.actor ?? {}),
    kind: "question",
    question,
    ...(s?.context ? { context: s.context } : {}),
    options: (s?.options ?? []).map((o, i) => ({
      label: o.label,
      ...(o.rationale ? { rationale: o.rationale } : {}),
      recommended: i === s?.recommended,
    })),
    threadId,
  };
}

export async function askQuestion(
  taskId: number,
  question: string,
  opts: AskOptions = DEFAULT_ASK_OPTIONS,
  structure?: AskStructure,
): Promise<string> {
  let thread = await getTaskChatThread(taskId);
  if (!thread || thread.status !== "open") {
    const task = await getTask(taskId);
    thread = await createChatThread({ taskId, title: `Task ${taskId}: ${task.title}` });
  }

  const body = formatAskMessage(question, structure);
  let messages = await getChatMessages(thread.id);
  const existingQuestion = findQuestionMessage(messages, body);
  let askedMessageId: number;
  if (existingQuestion) {
    askedMessageId = existingQuestion.id;
  } else {
    const posted = await postChatMessage(thread.id, "agent", body);
    askedMessageId = posted.id;
    messages = [...messages, posted];
    // also record it as a pinboard ask, which is what the asks
    // view and phone notification answer from. Its answer lands in this same
    // thread as a human message, so the wait below is unchanged. Best
    // effort: the chat question alone still works if this is refused.
    try {
      await createAsk(taskId, askInput(question, thread.id, structure));
    } catch (err) {
      console.error(`could not record the ask in pinboard: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deadline = Date.now() + opts.waitSeconds * 1000;
  for (;;) {
    const reply = findReply(messages, askedMessageId);
    if (reply) return reply.body;
    if (Date.now() >= deadline) {
      // previously suggested proceeding on best judgment after a
      // single wait window - that let a session talk itself past a real
      // blocking question instead of actually waiting for the operator, the
      // functional equivalent of auto-merging without an answer. This
      // question is meant to stay blocking: keep calling back. Other queued
      // tasks aren't held up by this wait - see governor.ts's
      // getExecutingSnapshot, which excludes a task parked here from the
      // concurrency count.
      return `No reply yet after ${opts.waitSeconds}s. Call \`work task ask ${taskId} ...\` again with the same arguments to keep waiting - this is a real blocking question, don't proceed without an answer.`;
    }
    await sleep(opts.pollIntervalSeconds * 1000);
    messages = await getChatMessages(thread.id);
  }
}

// the question a session left unanswered, if any - the thread is
// still open and its last message is the agent's own. The runner uses this
// to park a no-commit session in needs_input instead of rework.
export function pendingQuestion(
  thread: { status: string } | null,
  messages: ChatMessage[],
): string | null {
  if (!thread || thread.status !== "open" || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  return last.role === "agent" ? last.body : null;
}
