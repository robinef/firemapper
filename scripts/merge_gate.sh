#!/usr/bin/env bash
# Queue GitHub auto-merge for one firemapper PR, by number only. GitHub
# performs the merge once every required check on main is green.
#
# A wrapper rather than a `gh pr merge --auto ... --repo` permission rule:
# gh takes the repository from a PR URL and ignores --repo, so a wildcard rule
# would also queue merges in any other repo. Like review_gate.sh, run only the
# copy installed from origin/main, never the file from a checkout:
#
#   git show origin/main:scripts/merge_gate.sh > ~/.local/bin/firemapper-merge
#   chmod +x ~/.local/bin/firemapper-merge
#   ~/.local/bin/firemapper-merge <pr-number>
set -euo pipefail

pr="${1:?pr number}"
repo="robinef/firemapper"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr must be a number" >&2; exit 2; }
if [[ "$(gh pr view "$pr" --repo "$repo" --json isCrossRepository --jq .isCrossRepository)" != "false" ]]; then
  echo "PR #$pr comes from a fork; merge it by hand" >&2
  exit 1
fi
exec gh pr merge --auto --squash --delete-branch "$pr" --repo "$repo"
