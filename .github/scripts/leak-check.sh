#!/usr/bin/env bash
# Leak check for public repositories: fails when tracked files, commit
# metadata or piped-in text match any pattern from a private list.
#
# Usage: leak-check.sh [--patterns FILE] [--tree] [--log [RANGE]] [--stdin]
#
#   --tree        scan tracked files (contents and paths) of the current repo
#   --log [RANGE] scan author/committer names and emails, subjects and bodies
#                 of every commit, or only those in RANGE (e.g. origin/main..)
#   --stdin       scan text piped in (a PR title and body, say)
#
# Patterns come from --patterns FILE, else $LEAK_PATTERNS_FILE, else
# $LEAK_PATTERNS (the same content as a multi-line string, for CI). One per
# line, "<id><TAB><case-insensitive ERE>", blank lines and # comments ignored.
#
# A hit prints "<id> <file>:<line>" (line 0 = the path itself),
# "<id> commit <sha>" or "<id> stdin:<line>": never the matched text and never
# the pattern, so the output is safe in a public CI log.
#
# An optional .leak-allow at the repo root suppresses tree hits, one
# "<path-glob>:<id>" per line (# comments allowed), e.g.
#   templates/work-dir/.github/workflows/*.yml:P04
#
# Exit: 0 clean, 1 hits found, 2 usage error, 3 no patterns available (the
# caller decides whether that is a failure).
#
# Standalone on purpose (bash, git, grep, sed, awk, coreutils only): public repos vendor
# an exact copy as .github/scripts/leak-check.sh.
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/{s/^# \{0,1\}//p}' "$0" >&2
  exit 2
}

patterns_file=""
do_tree=0 do_log=0 do_stdin=0 log_range=""
while (($#)); do
  case "$1" in
    --patterns) [[ $# -ge 2 ]] || usage; patterns_file="$2"; shift 2 ;;
    --tree) do_tree=1; shift ;;
    --log)
      do_log=1; shift
      if (($#)) && [[ "$1" != --* ]]; then log_range="$1"; shift; fi
      ;;
    --stdin) do_stdin=1; shift ;;
    -h|--help) usage ;;
    *) echo "leak-check: unknown argument: $1" >&2; usage ;;
  esac
done
((do_tree || do_log || do_stdin)) || usage

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Normalise the patterns into "<id>\t<regex>" lines.
raw="$tmp/raw"
if [[ -n "$patterns_file" ]]; then
  cat -- "$patterns_file" > "$raw"
elif [[ -n "${LEAK_PATTERNS_FILE:-}" ]]; then
  cat -- "$LEAK_PATTERNS_FILE" > "$raw"
else
  printf '%s\n' "${LEAK_PATTERNS:-}" > "$raw"
fi
ids=() regexes=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" != *$'\t'* ]]; then
    echo "leak-check: malformed pattern line (no tab), ignored" >&2
    continue
  fi
  ids+=("${line%%$'\t'*}")
  regexes+=("${line#*$'\t'}")
done < "$raw"
if ((${#ids[@]} == 0)); then
  echo "leak-check: no patterns available (set LEAK_PATTERNS or LEAK_PATTERNS_FILE, or pass --patterns)" >&2
  exit 3
fi

hits=0
report() { echo "$1"; hits=1; }

# Allowlist entries ("<glob>:<id>") from the repo root's .leak-allow.
allow=()
if ((do_tree)); then
  root=$(git rev-parse --show-toplevel)
  cd "$root"
  if [[ -f .leak-allow ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line=${line%$'\r'}
      [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
      allow+=("$line")
    done < .leak-allow
  fi
fi
allowed() { # <path> <id>
  local entry
  for entry in "${allow[@]}"; do
    # shellcheck disable=SC2053 # the glob is meant to match unquoted
    [[ "${entry##*:}" == "$2" && "$1" == ${entry%:*} ]] && return 0
  done
  return 1
}

# grep -n over a text file; prints the matching line numbers.
match_lines() { # <regex> <file>
  grep -n -i -E -e "$1" -- "$2" | cut -d: -f1 || true
}

if ((do_tree)); then
  git ls-files > "$tmp/paths"
  for i in "${!ids[@]}"; do
    id=${ids[$i]} re=${regexes[$i]}
    # Paths themselves (line 0).
    while IFS= read -r n; do
      path=$(sed -n "${n}p" "$tmp/paths")
      allowed "$path" "$id" || report "$id $path:0"
    done < <(match_lines "$re" "$tmp/paths")
    # Contents. --null puts a NUL after the path and after the line number.
    while IFS= read -r -d '' path && IFS= read -r -d '' n && IFS= read -r _; do
      allowed "$path" "$id" || report "$id $path:$n"
    done < <(git grep -I -n -i -E --null -e "$re" || true)
  done
fi

if ((do_log)); then
  # Two line-aligned files: the text to scan and the commit each line is from.
  log_args=(--format=$'\x1e%H%n%an <%ae>%n%cn <%ce>%n%B')
  [[ -n "$log_range" ]] && log_args+=("$log_range")
  git log "${log_args[@]}" | awk -v sep=$'\x1e' -v text="$tmp/log.txt" -v shas="$tmp/log.sha" '
    index($0, sep) == 1 { sha = substr($0, 2); next }
    { print > text; print sha > shas }'
  touch "$tmp/log.txt" "$tmp/log.sha"
  for i in "${!ids[@]}"; do
    id=${ids[$i]}
    while IFS= read -r sha; do
      report "$id commit $sha"
    done < <(match_lines "${regexes[$i]}" "$tmp/log.txt" |
      awk 'NR == FNR { want[$1] = 1; next } FNR in want' - "$tmp/log.sha" |
      awk '!seen[$0]++')
  done
fi

if ((do_stdin)); then
  cat > "$tmp/stdin"
  for i in "${!ids[@]}"; do
    while IFS= read -r n; do
      report "${ids[$i]} stdin:$n"
    done < <(match_lines "${regexes[$i]}" "$tmp/stdin")
  done
fi

exit "$hits"
