# Agent GitHub identity and the first gated pull request

Recorded 2026-10-22. This file states what was configured and what the first pull request through the gate exercised. It records facts, not proof of a security boundary; see the limits at the end.

## Identity

| Item | Value |
|---|---|
| GitHub user | `Solvela-bot` |
| Display name | solvela-publisher |
| Account origin | An existing account the owner controls |
| Repository role | Collaborator with write permission, not admin |
| Commit author | `Solvela-bot <277798848+Solvela-bot@users.noreply.github.com>` |

On 2026-10-22 the owner had the orchestrator (thread thr_nveh5eysxj) invite the account as a collaborator with write permission. The owner accepted the invitation from that account and created a fine-grained personal access token with contents and pull requests set to read and write. This repository could not be selected for that token, see below.

## Credential handling

The intended path was a fine-grained personal access token delivered through `room-cli secret request` into an untracked `.env.agent` file, never printed or committed. Two attempts on 2026-10-22 failed:

1. The first token identified as `sky64`, not the bot.
2. The second token identified as `Solvela-bot` but could not write to this repository. Fine-grained tokens can target repositories owned by the token's own account or by an organization the account belongs to. Here the bot is an outside collaborator on a repository owned by another personal account, `sky64`, so this repository could not be selected for the token.

The push and pull request were therefore made with gh's device-code OAuth login as `Solvela-bot`, into a throwaway configuration directory selected with `GH_CONFIG_DIR`. Afterwards the bot account was logged out and that directory was deleted. No token file was written to the worktree for that path. The owner's own `gh` login was not used for agent pushes. Deleting the directory is not complete cleanup; two side effects remain: `gh auth setup-git` set a global Git credential helper pointing at gh, which may have pre-existed, and a `.gh-agent-config` entry remains in the main repository's `info/exclude`.

- The OAuth grant does not expire unless it is revoked in the Solvela-bot account's authorized OAuth apps.
- A classic personal access token would be the alternative to the device-code login.

## Merge gate

### Current gate (decision 0011, 2026-11-26)

The approval rule below is superseded by [decision 0011](decisions/0011-machine-merge-gate.md). A pull request merges when all of these hold:

- the `ci` check (`.github/workflows/ci.yml`, job `ci`) is green on its head;
- the `codex-review` commit status on that same head is `success`, posted by the orchestrator with `tools/bot/review-status.sh` for the exact SHA the reviewer named;
- the orchestrator has verified the worker's evidence.

The bot merges and the owner is told of every merge (merge SHA and time on the pull request, the Orca workspace comment, the report). No human approval is required, and no agent approves a pull request to satisfy a review rule: a bot approval of agent work is not a review. Pull requests #28 to #30 were approved by the bot with no human and no CI, which is what this replaces. A repository whose branch protection still requires an approving review is misconfigured for this harness; the orchestrator reports it to the owner and does not work around it. The orchestrator changes this repository's branch protection to require `ci` and `codex-review` after decision 0011 merges.

### Earlier gate (2026-10-22 to 2026-11-26, superseded)

Kept as history. Branch protection on `main` required one approving review, with admin enforcement and no force pushes. Consequences:

- The bot can push branches and open pull requests.
- A write collaborator can merge once protection requirements pass. Merging without the required approval is expected to be blocked by branch protection; this is untested. Owner-only merging was procedure, not an enforced restriction, and is superseded by the standing authorization below.
- The owner cannot merge without a reviewer approving the pull request.
- Standing authorization (owner ruling, 2026-10-25): `Solvela-bot` performs merges and production deployments once the independent Codex review is clean and the orchestrator has verified it. Each one is reported to the owner in the task thread and recorded on the pull request with the merge SHA and time. The owner may revoke or narrow this at any time. See the [decision note](decisions/2026-10-25-agent-merge-and-deploy.md).
- Self-approval limit: the bot cannot approve its own pull request, and main required one approving review. The merge waited for a human approval, recorded on the pull request. In practice pull requests #28 to #30 were opened under the owner's login and approved by the bot, so neither a human nor a machine check was in the loop; decision 0011 replaces this rule. Whether a merge without approval is rejected remains untested.
- First uses (2026-10-25): Solvela-bot merged sky64/floor PR 2 at 17:20:37Z (merge commit 1d0db41, unprotected base) and this repository's PR 10 at 18:22:40Z (merge commit 30ea1e3) after the owner's approving review; branch protection accepted the second. Details in the [decision note](decisions/2026-10-25-agent-merge-and-deploy.md).

## First gated pull request

The pull request that adds this file is the first to exercise that path: authored and pushed as `Solvela-bot`, opened against `main`. The Codex review and the owner's approval are recorded in the pull request itself, not here.

## Unverified

| Claim | Status |
|---|---|
| Credential rotation practice | Not defined or tested; the OAuth grant stays valid until revoked |
| The bot cannot approve its own pull request | Relies on GitHub refusing self-approval; not tested here |
| The bot cannot bypass branch protection | Expected because it is not an admin; not tested here |

## Automated path, 2026-10-22

PR 2 was authored by `Solvela-bot`, reviewed by Codex thread thr_h93fu5fccb at cbec74d, then approved and merged by the owner `sky64` on 2026-10-22 ([pull request 2](https://github.com/sky64/ai-developement-system/pull/2)). After that, the device-code login was replaced by a stored token, so cloud threads can push without a manual login.

| Item | State |
|---|---|
| Token | A classic personal access token for `Solvela-bot`, scope `repo` |
| Storage | The owner's 1Password vault `Agents`, item `Solvela-bot GitHub token` |
| Cloud copy | Copied once into Cloudroom's cloud environment as `GH_AGENT_TOKEN` |
| Guard in sandboxes | Every cloud thread receives `ORCHESTRATOR_GUARD=off` from the cloud environment, so the write guard is off there. The sandbox is the boundary and the checkout is the implementer workspace. |
| Git setup | A cloud setup script sets the Git author to `Solvela-bot` and a `github.com` credential helper that reads `GH_AGENT_TOKEN` at push time |
| Tooling | [tools/op/new-agent-token.sh](../tools/op/new-agent-token.sh) creates such an item from [tools/op/agent-token.template.json](../tools/op/agent-token.template.json) and can copy it into the cloud environment |

The first cloud attempt, thread thr_wnjaz3ftp5, halted for two reasons: the setup script did not find the checkout at `/code`, and the guard override was not yet an environment variable. The orchestrator thread reported both as fixed before this run. That is confirmed only by this run's step 0 observations, from thread thr_24nwt58nae's report: the `github.com` credential helper was present, `ORCHESTRATOR_GUARD` was off, and writes in the checkout were allowed. The setup script itself was not inspected.

The device-code OAuth grant used for PR 2 is to be revoked by the owner. Its status is unconfirmed.

### Unverified

| Claim | Status |
|---|---|
| This run is the test of the automated path | The pull request that adds this section is its first use; its outcome is recorded on the pull request |
| Device-code OAuth grant revoked | Unconfirmed |
| Token storage in 1Password | Stated by the owner; not inspected from a sandbox. In this run's sandbox, `GH_AGENT_TOKEN` was set and the GitHub API reported actor `Solvela-bot` with scope `repo` |
| `op item create` and `room-cli cloud env set` usage in the script | Checked with stub commands only; not run against 1Password or Cloudroom |
| Token rotation, self-approval refusal, and branch protection bypass | Still untested, as listed above |
| Merge without approval is rejected | Untested; PR 2 and PR 10 exercised only approved merges |

### Review cycle 1

Codex review thread thr_zysv79xr8t on be70987 raised five findings; all fixed in one commit.

- P1, `tools/op/new-agent-token.sh`: shell tracing would print the token. Fix: `set +x` at the top and again before `read -rs`; no tracing anywhere.
- P2, `tools/op/new-agent-token.sh`: a failed `op read` still ran `room-cli cloud env set` with empty input. Fix: the read is captured with a failure and empty check, and room-cli runs only after both pass.
- P2, `tools/op/new-agent-token.sh`: arguments were not fully validated before the token prompt. Fix: non-empty title, username and hostname, a real `YYYY-MM-DD` date checked with `python3 -I`, and `op`, `python3` and, with a fifth argument, `room-cli` on PATH, all before the prompt.
- P2, this file: the two setup fixes were stated as done. Fix: qualified as reported by the orchestrator thread and confirmed only by step 0 observations.
- P2, README.md, [02-compatibility-matrix.md](02-compatibility-matrix.md), [03-cloudroom-setup.md](03-cloudroom-setup.md): an approved merge was called verification of the merge gate. Fix: changed to exercised, with rejection of a merge without approval marked untested.

Related: [capability matrix](02-compatibility-matrix.md), [setup record](03-cloudroom-setup.md).
