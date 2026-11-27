#!/usr/bin/env bash
# Record the Codex review verdict on one commit as a commit status that branch
# protection can require (decision 0011):
#
#   review-status.sh <owner/repo> <full head sha> clean|findings "<one-line description>"
#
# Posts context `codex-review` on that SHA through gh-bot: `success` for clean,
# `failure` for findings. A status is bound to one commit, so a new push to the
# branch has no `codex-review` status until its own review is recorded. Prints
# the state the API returned. GH_BOT overrides the gh-bot path (tests only).
{ set +x; } 2>/dev/null
set -euo pipefail
usage() { echo "usage: review-status.sh <owner/repo> <full head sha> clean|findings \"<one-line description>\"" >&2; exit 2; }
[ "$#" -eq 4 ] || usage
repo="$1" sha="$2" verdict="$3" desc="$4"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "review-status: <owner/repo> must look like owner/name: $repo" >&2; exit 2; }
case "/$repo/" in */./*|*/../*) echo "review-status: <owner/repo> must not contain . or .. as a part: $repo" >&2; exit 2;; esac
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "review-status: the SHA must be a full 40-character lowercase hex commit id: $sha" >&2; exit 2; }
case "$verdict" in
  clean) state=success;;
  findings) state=failure;;
  *) echo "review-status: the verdict must be clean or findings: $verdict" >&2; exit 2;;
esac
case "$desc" in
  ""|*$'\n'*|*$'\r'*) echo "review-status: the description must be one non-empty line" >&2; exit 2;;
esac
# GitHub accepts at most 140 characters here; refuse rather than truncate.
[ "${#desc}" -le 140 ] || { echo "review-status: the description is over 140 characters" >&2; exit 2; }
bot="${GH_BOT:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)/gh-bot}"
"$bot" api --method POST "repos/$repo/statuses/$sha" \
  -f state="$state" -f context=codex-review -f description="$desc" --jq .state
