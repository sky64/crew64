# 0011: The merge gate is machines, and the owner is told

Date: 2026-11-26. Status: accepted by the owner in the Orca chat of 2026-11-26. Implemented in one pull request (crew64 0.9.1). It supersedes the approval rule of the [2026-10-25 decision](2026-10-25-agent-merge-and-deploy.md) and of [docs/09](../09-agent-identity.md), "Merge gate"; the rest of the 2026-10-25 standing authorization stands.

## Source

- 2026-10-25, the owner: "I want to know when a merge happens but not to be the one to do it." ([decision](2026-10-25-agent-merge-and-deploy.md))
- 2026-11-26, the owner decided to replace the approval gate on `main` with machine gates, and asked for the gaps to be filled first. This record and its pull request fill them; the orchestrator changes the GitHub branch protection after it merges.

## What happened

`main` in this repository is protected by "one approving review", with admin enforcement. It was meant to be the owner's approval. In practice pull requests were opened under the owner's login and approved by the bot (`skybot64`): pull requests #28 to #30 merged on a bot approval, with no human in the loop and no machine check either. The repository had no CI, and the Codex verdict was a sentence in a pull request comment. The approval rule therefore gave neither what the owner wanted (not to be the one to merge) nor what a gate should give (a check that cannot be talked past).

## Decision

### The gate

A pull request merges when all of these hold:

1. the `ci` check is green on its head;
2. the `codex-review` commit status on that same head is `success`;
3. the orchestrator has verified the worker's evidence.

The bot merges, and the owner is told of every merge, as before: the merge SHA and time on the pull request, the Orca workspace comment, the completion report.

- No human approval is required, and no agent approves a pull request to satisfy a review rule. A bot approval of agent work is not a review.
- A repository whose branch protection still requires an approving review is misconfigured for this harness: the orchestrator reports it to the owner and does not work around it.
- The rule is general: it is what the orchestrator skill tells an orchestrator in any repository. A repository without CI has only the `codex-review` status and the orchestrator's verification; the orchestrator reports the missing CI as a gap in the completion report and does not block on it.
- Unchanged, and still the owner's: new paid services, permission changes, external communications, credential changes, anything the application repository's own rules reserve, and the "allowance spent" question.

### CI

`.github/workflows/ci.yml` runs this repository's verification list from AGENTS.md on every pull request and on every push to `main`: `bash -n` on every shell script under `tools/`, `py_compile` on the Python files there, and every test and check script. One job, named `ci`, because that name is what branch protection requires. It runs on `ubuntu-latest` with Python 3.13, `contents: read`, no secrets, and `actions/checkout` and `actions/setup-python` pinned to full commit SHAs. `claude plugin validate .`, `git diff --check` and the Markdown checks stay local; the Claude Code CLI is not on the runner.

### The Codex verdict as a commit status

`tools/bot/review-status.sh <owner/repo> <full head sha> clean|findings "<one-line description>"` posts a commit status with context `codex-review` through `gh-bot`: `success` for `clean`, `failure` for `findings`. It refuses anything but a 40-character SHA and prints the state the API returned. After a review the orchestrator records `findings` after a FINDINGS verdict and `clean` after CLEAN, and `clean` only for the exact SHA the reviewer named in its verdict line.

The verdict contract, required in every reviewer brief: the review ends with `VERDICT: CLEAN <full reviewed sha>` when no blocker remains, follow-ups may still be listed; or `VERDICT: FINDINGS <full reviewed sha>` when at least one blocker remains. Both name the full reviewed SHA. Follow-ups alone never make a FINDINGS verdict, so a follow-up never blocks a merge (decision 0010: only blockers start a correction cycle). A head with `failure` reaches `success` only through a correction cycle and a re-review whose verdict line names the new head. A trivial-tier task or a docs-only native diff that needs no review under the Process ladder records `clean` with the description `no review required: <reason>`. A status is bound to one commit, so a new push has no `codex-review` status until its own review is recorded.

### Bot identity in this repository

`.claude/crew64.json` is added here: the shipped defaults with `features.bot_identity` set to `true` and nothing else changed. There is no `platform.hosts` entry, so this repository's own tasks stay on the Claude row until the owner decides otherwise.

## What it does not prove

- The `codex-review` status is posted by the orchestrator, not by the reviewer. It binds a verdict to a commit, so a later push cannot inherit it, but it does not prove that a review happened or that the verdict was reported faithfully. That still rests on the orchestrator and on the review evidence in the pull request.
- Any holder of a token with status write on the repository can post `codex-review`; GitHub does not restrict a commit status to one app unless branch protection names the source.
- CI covers this repository's scripts only. It does not run `claude plugin validate .`, and it proves nothing about an application repository, whose CI is its own.
- The bot's token has scope `repo` and no `workflow` scope, so the bot cannot push a change to `.github/workflows/`; on 2026-11-26 GitHub refused that push. Changes to the workflow go through the owner or a token with that scope.

## Not changed

The risk tiers, the model ladder, the review-cycle rules and the guard.

## How to revert

Restore the approval rule in branch protection on `main` (one approving review, admin enforcement) and revert this record's pull request; the 2026-10-25 approval wording in AGENTS.md, the skill, docs/05, docs/09 and docs/12 comes back with the revert. The CI workflow can stay without the rule: it gates nothing unless branch protection requires it.
