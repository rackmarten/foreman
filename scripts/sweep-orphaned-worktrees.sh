#!/usr/bin/env bash
#
# remove agent worktrees and branches that belong to tasks which are
# already finished.
#
# A past task note: nothing creates worktrees any more - a run works in its own
# clone under /app/tasks instead, and the dispatcher's sweep removes that whole
# directory. This script is now purely for the worktrees left behind by the
# pre-#153 scheme, which no other code path can reach. Run it once with
# --apply after deploying #153, and keep it around as a safety net for that
# legacy state.
#
# The dispatcher's own sweep (runner.ts's sweepRetainedWorktrees) handles this
# going forward, but it can only reach a task that still has
# `activeWorktreeName` set. Before #143 that sweep cleaned the task's own repo
# and then cleared the column, so any worktree it had created in a *related*
# repo was orphaned permanently - nothing could ever find it again. This picks
# those up, and stays useful afterwards as a safety net for anything left
# behind by a killed runner.
#
# Safe by default: prints what it would do and changes nothing. Pass --apply to
# actually remove. A worktree is only ever touched when pinboard says its task
# is done or rejected, so live work is never disturbed.
#
# A branch is only deleted once its commits are confirmed to be in the default
# branch already. That check is `git cherry`, not `git branch -d`: these PRs are
# squash-merged, so a merged branch's commit is never an ancestor of main and
# `branch -d` would refuse every single one. `git cherry` compares by patch
# equivalence instead, marking a commit `-` when the same change is already
# upstream and `+` when it genuinely is not.
#
# A branch with any `+` commit is real work that exists nowhere else - an
# attempt that committed and then failed before its PR merged. Those are
# reported and kept. --force-unmerged deletes them anyway, which is a
# deliberate choice to throw that work away.

set -euo pipefail

WORKSPACE_ROOT="${WORK_WORKSPACE_ROOT:-${HOME}/projects}"
PINBOARD_URL="${PINBOARD_URL:-http://pinboard:8095}"
APPLY=false
FORCE_UNMERGED=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --force-unmerged) FORCE_UNMERGED=true ;;
    -h | --help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# done/rejected are the two terminal statuses - anything else means the task
# could still legitimately want its worktree back (see runner.ts's
# prepareAttempt, which resumes one).
task_is_finished() {
  local task_id="$1" status
  status=$(curl -fsS -m 5 "${PINBOARD_URL}/api/tasks/${task_id}" 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null) || return 1
  [ "$status" = "done" ] || [ "$status" = "rejected" ]
}

# `git cherry <upstream> <branch>` lists each of the branch's commits with `-`
# when an equivalent patch is already upstream and `+` when it is not. Any `+`
# means real work that exists only here. Fails safe: if the comparison can't be
# made at all, the branch is treated as holding unmerged work and kept.
branch_has_unmerged_work() {
  local repo="$1" branch="$2" out
  out=$(git -C "$repo" cherry "$default_branch" "$branch" 2>/dev/null) || return 0
  echo "$out" | grep -q '^+'
}

removed=0
kept=0
unmerged=0

for repo in "${WORKSPACE_ROOT}"/*/*/; do
  [ -d "${repo}.git" ] || continue
  repo="${repo%/}"

  # Nearly everything here is `main`, but resolve it rather than assume - a
  # wrong upstream would make every branch look unmerged and clean nothing.
  if git -C "$repo" show-ref --verify --quiet refs/heads/main; then
    default_branch=main
  elif git -C "$repo" show-ref --verify --quiet refs/heads/master; then
    default_branch=master
  else
    echo "skip   $(basename "$repo"): no main/master branch to compare against" >&2
    continue
  fi

  # Drop worktree records whose directory is already gone, so `git worktree
  # list` below reflects reality rather than stale metadata.
  git -C "$repo" worktree prune 2>/dev/null || true

  # Worktree names are `task-<id>-session` today and `task-<id>-attempt-<n>`
  # under the pre-#66 scheme (one worktree per attempt rather than per task);
  # both still litter these repos, so match either. Each appears as a worktree
  # directory and again as `worktree-<name>` for the branch - collect both,
  # since an orphan can be a worktree plus its branch or just a stranded
  # branch.
  names=$(
    {
      git -C "$repo" worktree list --porcelain 2>/dev/null |
        sed -n 's#^worktree .*/\.claude/worktrees/\(task-[0-9][0-9]*-[^/]*\)$#\1#p'
      git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/worktree-task-*' 2>/dev/null |
        sed 's/^worktree-//'
    } | sort -u
  )

  for name in $names; do
    [ -n "$name" ] || continue
    # Handles both `task-<id>-session` and `task-<id>-attempt-<n>`.
    task_id="${name#task-}"
    task_id="${task_id%%-*}"

    if ! task_is_finished "$task_id"; then
      kept=$((kept + 1))
      echo "keep   $(basename "$repo")  $name (task ${task_id} is not finished, or pinboard is unreachable)"
      continue
    fi

    # Decide before reporting, so a dry run previews exactly what --apply does
    # rather than discovering the unmerged branches only once it is too late to
    # reconsider.
    keep_branch=false
    if [ "$FORCE_UNMERGED" != true ] && branch_has_unmerged_work "$repo" "worktree-${name}"; then
      keep_branch=true
    fi

    worktree_dir="${repo}/.claude/worktrees/${name}"

    if [ "$keep_branch" = true ]; then
      unmerged=$((unmerged + 1))
      echo "keep   $(basename "$repo")  $name - branch has commits not in ${default_branch} (--force-unmerged to delete anyway)"
      # The worktree directory is still removed: it is a checkout, not the
      # commits. The branch keeps them, so nothing is lost by reclaiming the
      # working copy.
      if [ "$APPLY" = true ] && [ -d "$worktree_dir" ]; then
        git -C "$repo" worktree remove --force "$worktree_dir" 2>/dev/null ||
          echo "  warning: could not remove worktree $worktree_dir" >&2
      fi
      continue
    fi

    echo "remove $(basename "$repo")  $name (task ${task_id} is finished, commits are in ${default_branch})"
    removed=$((removed + 1))
    if [ "$APPLY" = true ]; then
      if [ -d "$worktree_dir" ]; then
        git -C "$repo" worktree remove --force "$worktree_dir" 2>/dev/null ||
          echo "  warning: could not remove worktree $worktree_dir" >&2
      fi
      git -C "$repo" branch -D "worktree-${name}" 2>/dev/null || true
    fi
  done
done

echo
if [ "$APPLY" = true ]; then
  echo "Removed ${removed} orphaned worktree/branch pair(s); left ${kept} belonging to unfinished tasks."
else
  echo "Would remove ${removed} orphaned worktree/branch pair(s); would leave ${kept} belonging to unfinished tasks."
fi
if [ "$unmerged" -gt 0 ]; then
  echo "Kept ${unmerged} branch(es) holding commits that are not upstream - inspect those before using --force-unmerged."
fi
if [ "$APPLY" != true ]; then
  echo "Re-run with --apply to actually remove them."
fi
