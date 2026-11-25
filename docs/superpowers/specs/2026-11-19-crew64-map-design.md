# crew64-map: design

Date: 2026-11-19. Owner: sky64. Status: draft for owner approval.

## Intent

The owner runs many crew64 workers in parallel and wants to see progress and waste as numbers, not mood. crew64-map is an Orca sidebar panel that shows the current crew64 plan of the repository the owner is focused on: one row per task, coloured by state, with the numbers crew64 counts (rung, model, review cycles, escalations, tokens) and links to each task's worktree and pull request. It is also where the adoption audit for half-built repositories will report later (its own design).

## Decisions taken with the owner

- **Scope: one repository.** The panel follows the focused Orca workspace and shows that repository's plan. An all-repositories view is a later piece of work.
- **Remote hosts from the first version.** The owner works from the iMac's Orca with repositories on the home-office host (a paired Orca environment). The map must work for those workspaces, not only for repositories on the machine running the panel.
- **Show only.** The panel never changes anything: no stopping, dispatching or approving. Its only interactions are opening links (worktree, branch, pull request) and choosing which plan to view.
- **Data: approach 3, the log plus live data** (see Approaches).

## Goals

1. Header: repository name, plan name, progress (`3/5 done`).
2. One row per plan task: number and title, state (colour plus word), tier, rung, mode (native/delegated), the model actually used (a model id or a `dsh` overlay name), review cycles used against `limits.review_cycles`, escalations, tokens in/out, and links: open the task's worktree in Orca, the branch name, the pull request.
3. Footer totals for the plan: tokens in/out, escalations, review cycles used against the plan-wide allowance (tasks × `limits.review_cycles`).
4. Live: a row changes within seconds of the event that changed it (worker blocked, PR opened, merged).
5. Honest: a value that is inferred rather than recorded is marked with `~`; a value nobody knows is `—`.
6. When the focused repository has no plan in progress, say so plainly (this empty state is where the adoption audit will appear later).

## Non-goals

- Several repositories at once.
- Any control or write action, including editing plans.
- Money. Token counts only; cost in currency waits for the Solvela metering path.
- Charts over time. Rows and totals only.

## Anti-goals (failure even if it works)

- Showing a guess as a fact (a task shown `done` that is not merged; a `working` task whose worker is gone).
- Anything owner-specific in shipped code or defaults (host names, bot names, paths under a particular home directory). Same portability rule as decision 0005.
- Slowing Orca down or spamming GitHub: no tight polling loops, no per-render network calls.
- A panel that is on by default for people who did not opt in.

## Constraints

- Orca plugin system as of 1.4.255 to 1.4.259 (`orca plugin create`, `types`, `check`, `test`, `shot`). The panel is a `components` panel (TSX, Orca components, no build step) with a `trusted-worker` (`worker-panel` template). A trusted worker runs Node with full access and needs the owner's `--approve` to load.
- Plugin host APIs available: `workspace.readContext`, `workspace.list` (path, branch, hostId), `workspace.open`, `agents.list`, `events.subscribe` for `workspace.created`, `workspace.removed`, `workspace.changed`, `agent.status.changed` (`working` / `blocked` / `waiting` / ...), `storage`, `settings`, `shell.openExternal`. Capabilities to declare: `workspace:read`, `agent:read`, `storage:own`, `settings:own`. Nothing in the API knows about crew64 plans, rungs or review cycles.
- The orchestrator guard denies writes in the main checkout, so the log lives outside the repository.
- Tools follow the repo floor: Python 3.13+, bash on Linux. Plugin code is TypeScript as Orca's templates write it.
- Switch: the existing `features.build_map` (reserved, off) turns the whole feature on: the orchestrator writes the log only when it is on. The panel itself is installed and enabled separately in Orca (an Orca plugin cannot be switched by a repo config), and shows "crew64-map is off for this repository" when the switch is off.
- Naming: the panel is `crew64-map` (decision 0006).

## Approaches

1. **Work it all out live.** The worker reads the plan file, asks Orca, git and GitHub, matches tasks to worktrees by branch name, reads tokens from commit trailers. No new writes, but review cycles and escalations cannot be known, a running task has no tokens, and name matching breaks on a renamed branch.
2. **A task log only.** The orchestrator appends each step to a log; the panel reads it. Exact numbers and platform-independent, but a stuck worker shows as working until someone logs it, and anything not logged shows wrong.
3. **The log for numbers, live data for liveness (chosen).** The log supplies history, rung, model, review cycles, escalations, tokens; Orca's live agent events supply working/blocked right now; GitHub supplies pull request state; where the log is missing, the approach-1 inference fills in and is marked `~`. Chosen because the waste numbers exist only if crew64 writes them down, and only live events catch a worker that stalled.

## Design

### Parts

1. **`tools/crew64_ledger.py`** (crew64 repo): the only writer of the log. Subcommands:
   - `record --plan <plan file path relative to repo root> --task <n> --event <name> [--field key=value ...]`: appends one event. Exits 0 without writing when `features.build_map` is off (read through `crew64_config.py`), so the skill can call it unconditionally.
   - `show [--plan <path>]`: prints the folded state per task (for terminals and tests).
   - `path`: prints the log directory for the current repository.
2. **Orchestrator skill and docs/05**: one rule: at each step below, run `crew64_ledger.py record`. Steps: `planned` (once per task, when a plan is approved: tier, rung, mode, vendor), `dispatched` (worktree path, branch, dispatch id, agent, model or overlay), `native_started` (worktree path, branch, model = session model), `review` (cycle number, reviewer verdict), `escalated` (from, to, reason), `committed` (sha, tokens in/out when known, token source), `pr_opened` (number, url), `merged` (sha, time), `abandoned` (reason).
3. **The Orca plugin `crew64-map`** (crew64 repo, folder `orca/crew64-map/`, scaffolded from the `worker-panel` template):
   - Worker: resolves the focused workspace to its repository's main checkout, finds the log, subscribes to Orca events, takes snapshots through the `orca` CLI, polls GitHub, folds everything into one view model, posts it to the panel.
   - Panel: renders the view model. No logic beyond display and the plan picker.

### The log

- Location: `$CREW64_STATE_DIR` if set, else `$XDG_STATE_HOME/crew64`, else `~/.local/state/crew64`; then one directory per repository named `<main checkout basename>-<first 12 hex of sha256 of its real path>`; then one file per plan, `<plan file basename without .md>.jsonl`.
- The `planned` event carries everything the panel needs from the plan file: task number, title, tier, rung, mode, vendor, model, dependencies, plus the plan's branch and commit. While tasks run, the plan file usually sits on an unmerged branch, not in the main checkout (the guard forbids writing it there), so the panel never depends on the file once a log exists (builder's call, settled in review).
- One JSON object per line: `{"v":1,"ts":"<UTC ISO 8601>","plan":"docs/superpowers/plans/<file>.md","task":<n>,"event":"<name>", ...fields}`. Append-only; a later event for the same field wins when folding.
- Writes are single `write()` calls of one line opened with `O_APPEND`, so two orchestrators cannot interleave a line. The file holds no secrets and no prompt text.

### Remote workspaces (owner's decision)

**Result (2026-11-25, decision 0010):** a plugin runs on the Orca server it is installed on and sees only that server's workspaces, so the map is installed on each server (the home-office server for its repositories) and every read is local to that worker. The two cases below were the options before the spike.


`workspace.list` gives each workspace a `hostId`. A workspace on another host keeps its log, worktrees, git and `gh` on that host, so the worker must not assume it can read local files for it. The first plan task, before anything else is built, is a spike that answers one question on the owner's setup (iMac Orca, home-office environment): **where does a trusted plugin worker run for a remote workspace?**

- If Orca runs the plugin's worker on the workspace's host, the design above holds unchanged there.
- If the worker runs only on the local machine, every read for a remote workspace goes through the `orca` CLI with `--environment <host>`, which already reaches the home-office host: worktree and terminal listings and orchestration messages directly, and the log and `repo.json` through `crew64_ledger.py show --json` run on that host by the worker. The plan then adds the transport needed for that (for example a ledger read over an Orca terminal, or a ledger subcommand the remote side exposes), chosen in the spike's write-up. GitHub pull request state can come from the local `gh`, since it needs only the repository's GitHub name, which the remote log records in `repo.json`.

Either way, the folding and the panel are the same code; only the data source changes, behind one interface in the worker (`LocalSource`, `RemoteSource`).

### Which repository is focused (builder's call, settled in review)

`workspace.readContext` and `workspace.changed` give only branch, display name and terminals; `workspace.list` gives paths. The worker matches the focused context against `workspace.list` (branch and display name), then resolves the match's path to the main checkout with `git rev-parse --git-common-dir`. When the match is ambiguous, the header offers a repository picker among the candidates. Choosing what to view changes nothing, so it stays within show-only. The first plan task spikes this against the real API before the rest is built on it.

### Live state snapshot (builder's call, settled in review)

`agent.status.changed` only reports changes, and `agents.list` covers only the focused workspace. So the trusted worker takes a snapshot through the `orca` CLI when the panel opens, on every `workspace.*` event and at most once a minute while open: worktree and terminal listings for the task worktrees, and `orca orchestration` messages for `needs-input` escalations, which the plugin API does not carry. Live events update the snapshot in between. A task whose worktree has a terminal Orca no longer lists is `unknown`, never `working`.

### Repository settings the panel needs (builder's call, settled in review)

`crew64_config.py` stays the single reader of `.claude/crew64.json` (decision 0005). Each `crew64_ledger.py record` also rewrites `repo.json` in that repository's log directory, holding the effective `features.build_map`, `limits.review_cycles` and `this_host` as the reader resolved them, plus the ledger's version. The panel reads only that file: no `repo.json`, or `build_map` false, shows "crew64-map is off for this repository".

### Which plan is shown

The plan with the most recent log event in that repository's log directory. A small picker in the header lists the other plans that have a log, newest first. With no log, the newest plan file under `docs/superpowers/plans/` in the main checkout is shown from the file alone, every value marked `~`; a plan that exists only on a branch is not seen until its `planned` events are logged.

### Reading the plan file

Task rows come from the `## Tasks` table of the plan template (`docs/templates/plan.md`). Columns are matched by header name, not position, because older plans differ (the scout64 plan has no Mode column): Task, Tier, Rung, Mode, Vendor, Model. A missing column reads as `—`. Task number and title come from the Task cell (`1. <title>`).

### State of a task

States: `waiting` (grey), `working` (blue), `blocked` (red), `in review` (amber), `done` (green), `abandoned` (grey, struck through), `unknown` (grey, `?`). Folded in this order, first match wins:

1. Log says `merged` → done. Log says `abandoned` → abandoned.
2. GitHub says the task's PR is merged → done (`~` if the PR came from inference, not the log).
3. Orca's live agent status for a terminal in the task's worktree is `blocked` (or Orca escalated `needs-input`) → blocked; `working` → working.
4. A PR is open → in review.
5. Log says `dispatched` or `native_started` and the worktree exists → working; the worktree is gone without `merged` → unknown.
6. No log events: a worktree whose branch ends in the task's slug → working `~`; otherwise waiting.

"Waiting on N" is shown when the plan's task text names a dependency; otherwise just `waiting`.

### Numbers

- Rung, tier, mode: log `planned` first, else the plan row.
- Model: the last `dispatched`/`native_started` model; else the plan row's Model `~`.
- Review cycles: count of `review` events; shown against `limits.review_cycles` for that repository.
- Escalations: count of `escalated` events.
- Tokens: summed from `committed` events; else parsed from the `Tokens: <in>/<out>` commit trailer on the task branch `~`; else `—`.

### Refresh

Event-driven from Orca events and a file watch on the log directory and plans directory; GitHub pull request state through `gh pr list --json` for the repository at most once a minute, and only while the panel is open. Without `gh` or without auth, PR cells show `?` and the panel says why once.

## Testing

- `tools/test-crew64-ledger.sh` in the repo's style: record/show round trip, switch off writes nothing, concurrent appends stay whole lines, path naming, malformed lines are skipped and reported.
- Plugin: `orca plugin test` for worker folding (fixture logs, plan files, fake events) and panel rendering; `orca plugin check`; `orca plugin shot` for a visual check.
- Live check from the iMac's Orca against a real two-task plan on the home-office host (remote path), and once against a local repository (local path).

## Left to the builder

- Exact layout, colours from Orca theme tokens, icons, truncation.
- Polling interval within the one-minute ceiling; file-watch mechanics.
- Field names inside events beyond those listed, as long as `show` and the panel agree.
- Whether the plan picker is a select or a list.
- The decision record (`docs/decisions/0010-crew64-map.md`) and the plan.
