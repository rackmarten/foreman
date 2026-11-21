// `work now`'s text output: every active story, grouped by project, sized
// for a phone-width terminal. Pure, so it is unit-tested without pinboard.

import type { NowFinishedSession, NowResponse, NowStory } from "./pinboard.js";

export const NOW_WIDTH = 50;

// Cut `text` so it fits in `max` characters, ending in an ellipsis when cut.
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// `prefix` and `suffix` are kept whole; the text between them is cut to fit.
function fit(prefix: string, text: string, suffix = "", width = NOW_WIDTH): string {
  return `${prefix}${truncate(text, width - prefix.length - suffix.length)}${suffix}`.trimEnd();
}

export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// A long path keeps its tail (the part that names the repo), cut from the left.
function shortPath(cwd: string, max: number, home: string | undefined): string {
  const path = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  return path.length > max ? `…${path.slice(path.length - max + 1)}` : path;
}

function storyLines(story: NowStory, now: Date, home: string | undefined): string[] {
  const cost = story.interactiveCostUsd > 0 ? ` $${story.interactiveCostUsd.toFixed(2)}` : "";
  const lines = [fit(`  #${story.id} `, story.title, ` (${story.progress.done}/${story.progress.total})${cost}`)];
  for (const task of story.running) lines.push(fit(`    ▶ #${task.id} `, task.title));
  for (const wait of story.waiting) {
    const text = wait.kind === "ask" ? (wait.question ?? wait.title) : wait.title;
    lines.push(fit(`    ! ${wait.kind} #${wait.taskId} `, text));
  }
  if (story.next) lines.push(fit(`    next #${story.next.id} `, story.next.title));
  for (const session of story.sessions) {
    const prefix = `    session ${session.sessionId.slice(0, 8)} `;
    const suffix = ` (${ago(session.lastSeenAt, now)})`;
    lines.push(`${prefix}${shortPath(session.cwd, NOW_WIDTH - prefix.length - suffix.length, home)}${suffix}`);
  }
  return lines;
}

function finishedLine(session: NowFinishedSession, home: string | undefined): string {
  const prefix = `  ${session.sessionId.slice(0, 8)} `;
  const ids = session.stories.map((s) => `#${s.id} ${s.status}`).join(", ");
  const suffix = ` (${ids})`;
  const room = NOW_WIDTH - prefix.length - suffix.length;
  // Many stories leave no room for the path; then the story list is cut.
  if (room < 10) return fit(`${prefix}${shortPath(session.cwd, 20, home)} (`, ids, ")");
  return `${prefix}${shortPath(session.cwd, room, home)}${suffix}`;
}

// Projects and stories that wait on a human come first; otherwise pinboard's
// order is kept (Array.prototype.sort is stable).
export function formatNow(response: NowResponse, now = new Date(), home = process.env.HOME): string {
  const waits = (s: NowStory): number => (s.waiting.length > 0 ? 0 : 1);
  const groups = new Map<string, NowStory[]>();
  for (const story of [...response.stories].sort((a, b) => waits(a) - waits(b))) {
    const slug = story.project.slug;
    groups.set(slug, [...(groups.get(slug) ?? []), story]);
  }
  const blocks = [...groups].map(([slug, group]) =>
    [truncate(slug, NOW_WIDTH), ...group.flatMap((s) => storyLines(s, now, home))].join("\n"),
  );
  if (blocks.length === 0) blocks.push("Nothing active.");
  // Missing on an older pinboard.
  const finished = response.finishedSessions ?? [];
  if (finished.length) blocks.push(["Can archive:", ...finished.map((s) => finishedLine(s, home))].join("\n"));
  return blocks.join("\n\n");
}
