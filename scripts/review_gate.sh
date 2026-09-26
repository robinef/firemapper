#!/usr/bin/env bash
# Post the `claude-review` commit status that branch protection on main
# requires. Run it only after /code-review and /security-review have passed
# on the exact commit being posted — the status is the attestation, and it
# binds to that SHA: any new push lands a commit with no status, so the
# review has to run again before auto-merge can proceed.
#
# NEVER run this file from a checkout. The gate refuses unless the local HEAD
# is the PR's head, so the copy in the working tree is always the PR's own
# copy — a PR that rewrote it would run with your gh token. Run the trusted
# copy installed from main instead (AGENTS.md, "Shipping"):
#
#   git fetch origin main
#   git show origin/main:scripts/review_gate.sh > ~/.local/bin/firemapper-review-gate
#   chmod +x ~/.local/bin/firemapper-review-gate
#   firemapper-review-gate <pr-number> success|failure "<one-line summary>"
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

# Fork PRs never auto-merge: a human merges them by hand.
if [[ "$(gh pr view "$pr" --repo "$repo" --json isCrossRepository --jq .isCrossRepository)" != "false" ]]; then
  echo "PR #$pr comes from a fork; the review gate is for same-repo branches only" >&2
  exit 1
fi

# Attest only what was reviewed: a clean tree whose HEAD is the PR's head.
git diff --quiet HEAD || { echo "working tree is dirty; review what is committed" >&2; exit 1; }
head_sha="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"
local_sha="$(git rev-parse HEAD)"
if [[ "$head_sha" != "$local_sha" ]]; then
  echo "PR #$pr head ${head_sha:0:7} != local HEAD ${local_sha:0:7}; push or check out the reviewed commit" >&2
  exit 1
fi

# GitHub caps the description at 140 characters; cut on bytes, then drop any
# multibyte character the cut split, or the API rejects invalid UTF-8.
desc="$(printf '%s' "$note" | head -c 140 | { iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true; })"

gh api -X POST "repos/$repo/statuses/$head_sha" \
  -f state="$verdict" -f context="claude-review" -f description="$desc" \
  --jq '.context + ": " + .state + " @ " + .sha[0:7]'
