#!/usr/bin/env bash
# Post the `claude-review` commit status that branch protection on main
# requires. Run it only after /code-review and /security-review have passed
# on the exact commit being posted — the status is the attestation, and it
# binds to that SHA: any new push lands a commit with no status, so the
# review has to run again before auto-merge can proceed.
#
#   bash scripts/review_gate.sh <pr-number> success|failure "<one-line summary>"
#
# No Claude credential lives in the repo or in Actions: the review runs in
# the local session and this posts its verdict with the local `gh` login.
set -euo pipefail

pr="${1:?pr number}"
verdict="${2:?success|failure}"
note="${3:-}"
repo="robinef/firemapper"

case "$verdict" in success|failure) ;; *) echo "verdict must be success or failure" >&2; exit 2 ;; esac
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr must be a number" >&2; exit 2; }

# Attest only what was reviewed: a clean tree whose HEAD is the PR's head.
git diff --quiet HEAD || { echo "working tree is dirty; review what is committed" >&2; exit 1; }
head_sha="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"
local_sha="$(git rev-parse HEAD)"
if [[ "$head_sha" != "$local_sha" ]]; then
  echo "PR #$pr head ${head_sha:0:7} != local HEAD ${local_sha:0:7}; push or check out the reviewed commit" >&2
  exit 1
fi

gh api -X POST "repos/$repo/statuses/$head_sha" \
  -f state="$verdict" -f context="claude-review" -f description="${note:0:140}" \
  --jq '.context + ": " + .state + " @ " + .sha[0:7]'
