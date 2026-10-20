// the pre-push leak gate for public repos. Before a task branch
// is pushed to a repo in a public GitHub org (pipeline.ts's isPublicRepo),
// homelab's scripts/leak-check.sh runs over the branch's new commits
// (--log origin/<base>..HEAD) and, on stdin, the added lines of
// `git diff origin/<base>...HEAD` followed by the PR title and body (and the
// branch name, when the push creates the branch). A hit,
// a missing pattern file or script, or exit 3 (no patterns) blocks the push.
//
// leak-check.sh reports stdin hits as "stdin:<n>", so the stdin text is built
// here with a location per line, mapped back to "<file>:<line>" or the PR
// title/body, and filtered through the repo's .leak-allow the way the
// script's own --tree mode filters tracked files. Output never carries the
// matched text, only pattern ids and locations.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOMELAB_ROOT } from "./pipeline.js";

export const LEAK_CHECK_SCRIPT = join(HOMELAB_ROOT, "homelab", "scripts", "leak-check.sh");
export const LEAK_PATTERNS_FILE = join(HOMELAB_ROOT, "homelab", "public-leak-patterns.txt");

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

// The "+" lines of a unified diff with their new-file line numbers.
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (file === null || raw.startsWith("--- ")) continue;
    if (raw.startsWith("+")) out.push({ file, line: next++, text: raw.slice(1) });
    else if (raw.startsWith(" ")) next++;
  }
  return out;
}

export interface ScanLocation {
  // Set for a diff line, so .leak-allow can match its path.
  file: string | null;
  label: string;
}

export function buildScanInput(
  added: readonly AddedLine[],
  title: string,
  body: string,
  branchName: string | null = null,
): { text: string; locations: ScanLocation[] } {
  const lines: string[] = [];
  const locations: ScanLocation[] = [];
  if (branchName !== null) {
    lines.push(branchName);
    locations.push({ file: null, label: "branch name" });
  }
  for (const a of added) {
    lines.push(a.text);
    locations.push({ file: a.file, label: `${a.file}:${a.line}` });
  }
  lines.push(title);
  locations.push({ file: null, label: "PR title" });
  body.split("\n").forEach((text, i) => {
    lines.push(text);
    locations.push({ file: null, label: `PR body line ${i + 1}` });
  });
  return { text: lines.join("\n") + "\n", locations };
}

// "<path-glob>:<id>" per line, # comments allowed - the format leak-check.sh
// reads for --tree.
export function parseLeakAllow(content: string): Array<{ glob: string; id: string }> {
  return content
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() && !/^\s*#/.test(l))
    .map((l) => ({ glob: l.slice(0, l.lastIndexOf(":")), id: l.slice(l.lastIndexOf(":") + 1) }))
    .filter((e) => e.glob && e.id);
}

// Bash `[[ $path == $glob ]]` semantics: `*` matches across slashes.
function globMatches(glob: string, path: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(path);
}

export function isAllowed(path: string, id: string, allow: ReadonlyArray<{ glob: string; id: string }>): boolean {
  return allow.some((e) => e.id === id && globMatches(e.glob, path));
}

export interface LeakHit {
  id: string;
  location: string;
}

// leak-check.sh's stdout ("<id> stdin:<n>", "<id> commit <sha>") as hits,
// stdin lines mapped back to their source and allowlisted diff lines dropped.
export function mapLeakOutput(
  stdout: string,
  locations: readonly ScanLocation[],
  allow: ReadonlyArray<{ glob: string; id: string }>,
): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const line of stdout.split("\n")) {
    const stdin = /^(\S+) stdin:(\d+)$/.exec(line.trim());
    if (stdin) {
      const loc = locations[Number(stdin[2]) - 1];
      if (!loc) hits.push({ id: stdin[1], location: `scanned line ${stdin[2]}` });
      else if (!(loc.file && isAllowed(loc.file, stdin[1], allow))) hits.push({ id: stdin[1], location: loc.label });
      continue;
    }
    const commit = /^(\S+) commit ([0-9a-f]+)$/.exec(line.trim());
    if (commit) hits.push({ id: commit[1], location: `commit message ${commit[2].slice(0, 12)}` });
  }
  return hits;
}

export type LeakGateResult =
  | { blocked: false }
  | { blocked: true; hits: LeakHit[]; reason: string };

export interface LeakGateOptions {
  script?: string;
  patterns?: string;
  // Injected in tests: runs `bash <args>` in cwd with input, returns exit code and output.
  exec?: (args: string[], cwd: string, input: string) => { status: number | null; stdout: string; stderr: string };
  git?: (args: string[], cwd: string) => string;
  // The branch about to be created on origin. Left out for a branch origin
  // already has, since its name is public by then and a later push changes
  // nothing about it.
  branchName?: string | null;
}

function defaultExec(args: string[], cwd: string, input: string) {
  const r = spawnSync("bash", args, { cwd, input, encoding: "utf8", env: { ...process.env, LEAK_PATTERNS: "", LEAK_PATTERNS_FILE: "" } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error?.message ?? "") };
}

function defaultGit(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || r.error?.message}`);
  return r.stdout;
}

// Null when the push may go ahead: always for a private repo, and for a
// public one only when leak-check.sh exits 0 or every hit is allowlisted.
export function leakGateForPush(
  repoPath: string,
  base: string,
  isPublic: boolean,
  title: string,
  body: string,
  opts: LeakGateOptions = {},
): LeakGateResult {
  if (!isPublic) return { blocked: false };
  const script = opts.script ?? LEAK_CHECK_SCRIPT;
  const patterns = opts.patterns ?? LEAK_PATTERNS_FILE;
  if (!existsSync(script)) return { blocked: true, hits: [], reason: `leak-check script not found at ${script}` };
  if (!existsSync(patterns)) return { blocked: true, hits: [], reason: `no leak patterns: ${patterns} not found` };

  const git = opts.git ?? defaultGit;
  let diff: string;
  try {
    diff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", `origin/${base}...HEAD`], repoPath);
  } catch (err) {
    return { blocked: true, hits: [], reason: err instanceof Error ? err.message : String(err) };
  }
  const { text, locations } = buildScanInput(addedLines(diff), title, body, opts.branchName ?? null);
  const allowPath = join(repoPath, ".leak-allow");
  const allow = existsSync(allowPath) ? parseLeakAllow(readFileSync(allowPath, "utf8")) : [];

  const exec = opts.exec ?? defaultExec;
  const r = exec([script, "--patterns", patterns, "--log", `origin/${base}..HEAD`, "--stdin"], repoPath, text);
  if (r.status === 0) return { blocked: false };
  if (r.status === 3) return { blocked: true, hits: [], reason: "leak-check found no patterns (exit 3)" };
  if (r.status === 1) {
    const hits = mapLeakOutput(r.stdout, locations, allow);
    if (hits.length) return { blocked: true, hits, reason: `${hits.length} leak-check hit(s)` };
    // Every hit allowlisted is a pass; exit 1 with no hit lines at all is the
    // script failing (set -e), not a clean result.
    if (/^\S+ (stdin:\d+|commit [0-9a-f]+)$/m.test(r.stdout)) return { blocked: false };
  }
  return { blocked: true, hits: [], reason: `leak-check failed (exit ${r.status}): ${r.stderr.trim() || "no output"}` };
}

export class LeakBlockedError extends Error {
  constructor(
    readonly repoSlug: string,
    readonly result: Extract<LeakGateResult, { blocked: true }>,
  ) {
    super(`leak check blocked the push to ${repoSlug}: ${result.reason}`);
  }
}

// The rework comment: ids and locations only, never the matched text.
export function formatLeakComment(repoSlug: string, result: Extract<LeakGateResult, { blocked: true }>, patternsFile: string = LEAK_PATTERNS_FILE): string {
  const lines = [
    `Not pushed: \`${repoSlug}\` is a public repository and the pre-push leak check blocked it (${result.reason}).`,
  ];
  if (result.hits.length) {
    lines.push("", "Hits (pattern id, location):", ...result.hits.map((h) => `- ${h.id} ${h.location}`));
    lines.push(
      "",
      `The ids are defined in ${patternsFile}. Rephrase each hit so it describes the change itself, ` +
        "without internal references (amend or reword the commits for commit-message hits; the PR " +
        "title is the first commit's subject and the PR body is the handoff summary and how-to-verify). " +
        "A genuine false positive in a file can be allowlisted in the repo's `.leak-allow` as `<path-glob>:<id>`.",
    );
  }
  lines.push("", "The commits are still in this task's retained workdir.");
  return lines.join("\n");
}
