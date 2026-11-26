# Orca setup record

Verified on this machine on 2026-10-27 from a Claude session inside an Orca terminal, unless a row says otherwise. Facts, not proof of a security boundary.

## State

| Item | Result |
|---|---|
| Orca | 1.4.271 verified 2026-11-26 on the local host (`orca --version` printed `1.4.271`; `orca status --json` showed `"appVersion": "1.4.271"` and runtime `"state": "ready"`; 22 repositories registered in `orca repo list`; the re-checked rows are under "Orca 1.4.271 checks" below). Earlier: 1.4.255 on 2026-11-17, 1.4.242 at the 2026-10-27 setup. `tools/orca-version-check.sh` compares the running version with this row. One SSH target (`gach-staging`) was registered and not connected at 1.4.255; not re-checked |
| Claude Code hooks | Orca's agent hooks are in `~/.claude/settings.json` for every hook event; the hook port and token are in the Orca terminal environment |
| Native subagents | Available inside Orca-launched Claude. An Explore subagent ran a command and returned. Cloud Room disabled these |
| Worktree creation | `orca worktree create --repo name:<repo> --name <name> --no-parent --base-branch <ref> --setup skip --json` creates `~/orca/workspaces/<repo>/<name>` on branch `sky64/<name>` |
| Guard in an Orca worktree | The hook allows file-tool writes inside the worktree, denies writes from it into the main checkout, and denies writes and `git commit` in the main checkout. Run against the real worktree paths |
| Claude to Codex review through Orca | Exercised on the first port branch: Run `run_d8515884b14d`, Codex worker in a child worktree, `worker_done` received through the Run inbox in about 90 seconds with outcome succeeded and no findings, worker released, delivery acknowledged |
| `worker-start --worktree new-child` | Rejected by this build with `selector_not_found` although the bundled guide documents it. Create the worktree first and pass `--worktree id:<id>` |
| Repository setup script | Orca's repo settings for this repository carried `pnpm install` with no package.json. There is no CLI to change it; clear it in Orca's repo settings or create worktrees with `--setup skip` |
| Bot identity | `skybot64` (GitHub account id 277798848, renamed from `Solvela-bot` on 2026-11-18) has write on this repository; its token is the 1Password item `Solvela-bot GitHub token` in vault `Agents` (the item kept its old name). `tools/bot/install-bot-identity.sh` scopes the identity and a credential helper to linked worktrees; see the verification below |
| Bot identity values (decision 0005) | On the owner's machines `install-bot-identity.sh` is run as `--name skybot64 --email 277798848+skybot64@users.noreply.github.com --token-command "op read 'op://Agents/Solvela-bot GitHub token/credential'"`, which writes `crew64.bot.name`, `crew64.bot.email` and `crew64.bot.tokenCommand` into the global git config. Repositories that merge as the bot set `features.bot_identity` to true in `.claude/crew64.json`; the owner's full wiring is `config/examples/orca-solvela.json`. Re-run with the `skybot64` name on both of the owner's machines on 2026-11-18; `gh-bot api user --jq .login` printed `skybot64` on each |
| Plugin in an Orca-launched session | Untested |
| Orca environment recipes as a write boundary | Untested |
| Automatic Codex review as an Orca automation | Not built |

## Bot identity verification

Recorded when `tools/bot/install-bot-identity.sh` was run on this machine; see the pull request that added this file for the command output.

| Check | Expected |
|---|---|
| `git config user.name` in an Orca worktree | `skybot64` |
| `git config user.name` in the main checkout | `sky64` |
| `git credential fill` for github.com in an Orca worktree | `username=skybot64` (password not printed) |
| `gh-bot api user --jq .login` | `skybot64` |
| `gh api user --jq .login` | `sky64` |

## Review and merge flow

1. The implementer works in an Orca worktree and commits as the bot.
2. The orchestrator starts a Codex reviewer as an Orca worker with base and head SHAs, changed files, acceptance criteria, and check results, and waits on the Run inbox.
3. With a clean review, the implementer pushes and opens the pull request as the bot with `gh-bot`.
4. The owner approves the pull request. Branch protection on `main` requires that approval and the bot cannot give it.
5. The orchestrator merges as the bot with `gh-bot pr merge`, reports to the owner, updates the Orca workspace comment, and records the merge SHA and time on the pull request, per the [standing authorization](decisions/2026-10-25-agent-merge-and-deploy.md).

## Model ladder routing

Rows for the ladder in [docs/05](05-delegation.md), "Model ladder" and "Ladder review" ([decision 0004](decisions/0004-model-ladder.md)). A row is verified only when the command was run and its output recorded here; "unverified" rows name the owner item that blocks them. Checked 2026-11-17 on the local Orca 1.4.255 host unless stated.

| Row | What was run | Result |
|---|---|---|
| Orca passes a model and effort to Claude and Codex workers | `orca orchestration worker-start --help` | Verified: `--model <id>` "Provider model id for a new agent launch", `--effort <level>` "Reasoning effort for the selected model". Help text states `dsh` and other agents "launch with the model from their own config". |
| `dsh` is a registered Orca agent on the home-office host | `orca worktree ps --environment home-office-omarchy --json` | Verified: six panes with `"agentType": "dsh-tui"` listed; `dsh` 0.2.2-rc.1 installed locally. The Orca agent id there is `dsh-tui`. The DeepSeek row applies once the profile row below is verified; on this host the overlay row and the worker row below both are. |
| `dsh` patch overlays for the two DeepSeek rungs exist by name | `dsh-tui --patch ~/.dsh/patches/<name>.yml <dir>` in tmux on the home-office host, 2026-11-18 (`dsh` 0.2.1-rc.5, `dsh-tui` 0.20.1) | Verified: `~/.dsh/patches/1-DeepSeek64.yml` (rung 0) starts on `deepseek-flash`, `2-DeepSeek64.yml` (rung 1) on `deepseek-v4-pro`; each file is one `agent-default-model` entry. Neither sets `DEEPSEEK_BASE_URL`, so calls go to DeepSeek directly, not through Solvela; that matches `gateway.kind` `none` in the owner's repositories today. Separate profiles of the same names were tried first and deleted on 2026-11-18: booted through `dsh-tui` with `DSH_TUI_PROFILE` the session fails to open (`Cannot redefine property: execute` on 41 plugins) although the status line still shows the model. |
| An Orca DeepSeek worker runs the rung its brief names | `orca terminal create --environment home-office-omarchy --command 'dsh-tui --patch "$HOME/.dsh/patches/1-DeepSeek64.yml" .'`, then `orca orchestration worker-start --on home-office-omarchy --terminal <handle>`; the dsh session log (`session.v4.jsonl.zstd`), 2026-11-18 | Verified: the worker returned `worker_done`, and its session log records all 28 calls with `model` `deepseek-flash`. Precondition: `~/.dsh-tui/model.json` is absent on the host (moved to `model.json.bak-2026-11-18`), because a `/model` choice saved there overrides every overlay. Orca's own launch (`--agent dsh-tui`, which runs `dsh-tui .`) takes no overlay and is not used for a rung. |
| A DeepSeek worker finishes unattended | crew64 0.8.2 live check on the home-office host, 2026-11-18 (Orca 1.4.259), run `run_235c79de8f03` | Fixed in 0.8.3: the worker stopped at a `dsh` sandbox approval (`danger-full-access`) for `git commit` in its linked worktree, whose git data lives in the main checkout, and Orca escalated `needs-input`. `dsh` has no setting for an extra writable directory (its `sandbox-policy` takes only `mode` and `workspaceRoot`), and `danger-full-access` would also turn approvals off. So the brief now tells the worker to leave its changes uncommitted; the orchestrator commits them when its session can move into the task worktree, otherwise a rung 0 Claude worker does. The orchestrator guard decides by the session's working directory, so an orchestrator left in the main checkout cannot commit in a worktree by path (Codex review of PR 27). |
| The guard and shell syntax | live check 3, 2026-11-19 | Observed: in the main checkout the guard denies any Bash command it cannot parse, including read-only process substitution such as `diff <(ls sites) file` ("unknown shell operator '<('"). Write the intermediate output to a scratch file instead. |
| The orchestrator knows which `platform.hosts` entry it runs on | the same live check: hostname `omarchy`, Orca environment `local`, key `home-office-omarchy` | Fixed in 0.8.3: a host entry lists `hostnames`; `crew64_config.py status` shows `this_host=<key>` on a matching machine (`CREW64_THIS_HOST` forces it). The owner's entry lists `omarchy`. |
| A native task can move into its Orca worktree | live checks 2 and 3 on the home-office host (crew64 0.8.3 on 2026-11-18, run `run_4de39f4d20b6`; 0.8.4 on 2026-11-19, run `run_02f90d753405`), orchestrator in the main checkout | Verified in live check 3 on 2026-11-19 (crew64 0.8.4, orchestrator in the main checkout, run `run_02f90d753405`): after crew64-enable listed the directory, `pwd` printed the task worktree path after each `cd`, the native task committed there, and the orchestrator committed the DeepSeek worker's diff itself; that worker finished unattended (dsh log: `deepseek-flash` only). Before 0.8.4, `cd ~/orca/workspaces/vintagemintage/<task>` came back as `Shell cwd was reset`, because Claude Code keeps a `cd` only inside the session's working directories, so the task fell back to delegated as the skill says. crew64-enable now lists `platform.worktree_root`/<repo name> (default `~/orca/workspaces`) in the untracked `.claude/settings.local.json` under `permissions.additionalDirectories` when `features.native_worktree_access` is on, and keeps that file out of git through `.git/info/exclude`. |
| Codex honours a `model_providers` base URL at Solvela with a bearer key | `codex --help` shows `-c, --config <key=value>` overrides for `~/.codex/config.toml` | Unverified end to end: needs the Solvela org API key for the reviewer team (owner item). |
| Claude Code carries `x-solvela-session` for a Claude session routed through Solvela | not run | Unverified and not scheduled: the owner has not moved any Claude session off the subscription (decision 0004, Owner items). |
| One Solvela team per role with hourly and daily budgets | not run | Unverified: needs the Solvela org, teams and budget figures (owner item). |
| Solvela team stats `by_model` return rows for a test session | not run | Unverified: needs the teams above and one test dispatch with `x-solvela-session` set. Solvela source confirms `spend_logs.session_id` (migration 003) and the `by_model` breakdown in the team stats route. |

## Orca 1.4.271 checks

Run on the local host on 2026-11-26 by the implementer of the 2026-11-26 field fixes ([decision 0010](decisions/0010-field-fixes-2026-11-26.md)). Each row quotes the output line it rests on.

| Row | What was run | Result |
|---|---|---|
| Running version | `orca --version` | Verified: `1.4.271`. |
| The orchestrator waits by ending its turn, not by polling | `orca skills get orchestration` | Verified. The guide says, after starting workers: "Then **end your turn**. "Report back" and "tell me when it's done" still mean end your turn; Orca wakes you and you report then." Under "Never": "Poll or run watch scripts: a script's plain `check` takes your mail, so it is hidden from you and Orca has nothing to wake you with. Orca wakes you." Under "When Orca wakes you": "In a chat, each message arrives whole as its own message: act on it." The orchestrator skill now ends the turn after `worker-start` instead of running `check --wait`. |
| `check --ack` is not needed | `orca orchestration check --help` | Verified: "--ack: optional; acknowledges a batch from an older Orca that does not mark it." and "A consuming check marks the batch it returns as handled, so the next check returns newer mail; no --ack is needed." The skill's `check --ack` instruction is removed. |
| Mail after lost context | `orca orchestration check --help`, `orca skills get orchestration` | Verified: "Lost track? `ORCA orchestration inbox --terminal run:<run_id> --limit 50` shows mail `check` already handled." |
| Orca still passes a model and effort to Claude and Codex workers | `orca orchestration worker-start --help` | Verified: `--model <id>` "Provider model id for a new agent launch", `--effort <level>` "Reasoning effort for the selected model"; "Other agents, including zcode, launch with the model from their own config." |
| Claude Code memory writes under the guard | `bash tools/hooks/test-orchestrator-guard.sh` | Unit test only: the hook allows the file write tools on `<home>/.claude/projects/<dir>/memory/` from the main checkout and from a worktree, and denies the other cases listed in decision 0010. Not yet exercised in a live orchestrator session. |
