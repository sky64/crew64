# 0010: crew64-map, an Orca panel for the focused repository's plan

Date: 2026-11-25. Status: design approved by the owner on 2026-11-19 (`docs/superpowers/specs/2026-11-19-crew64-map-design.md`); plan `docs/superpowers/plans/2026-11-19-crew64-map.md` approved on 2026-11-25. Full design in the spec; this record keeps what was decided and why.

## Context

The owner runs many crew64 workers in parallel and wants to see progress and waste as numbers. Orca has a plugin system with sidebar panels and trusted Node workers, but its API knows nothing of crew64 plans, rungs or review cycles, and two of the numbers that show waste (review cycles used, escalations) exist only in the orchestrator's head unless it writes them down.

## Decision

1. crew64-map is an Orca plugin (`orca/crew64-map/`, a `worker-panel`): a sidebar panel for the focused repository's current plan, one row per task, show only.
2. `tools/crew64_ledger.py` is the only writer of its log: one JSON line per orchestrator step, outside the repository, written only when `features.build_map` is on (the switch reserved in decision 0005 now does this). It also writes `repo.json`, the repository's effective settings as `crew64_config.py` resolved them, so `crew64_config.py` stays the single reader of `.claude/crew64.json`.
3. The panel joins three sources: the log (history and numbers), Orca's live state (working or blocked now), and GitHub (pull request state). An inferred value is marked `~`, an unknown one `—`.
4. The plugin is installed on each Orca server whose repositories it should map (Remote spike below).

## Consequences

- The orchestrator skill gains one rule (Build map log) and docs/05 one bullet; with the switch off nothing changes for any repository.
- A step the orchestrator forgets to log shows as inferred or unknown, never as a confident wrong value.
- The log lives in the user's state directory, so it survives worktree removal and is per machine: a repository's map is on the server where its orchestrator runs.
- Installing the panel needs the owner's approval of a trusted worker in Orca on each server.


## Remote spike (Task 1, 2026-11-25)

Question: where does a trusted plugin worker run for a workspace on another host, and how does the map read that host's log?

Method: a throwaway `worker-panel` plugin whose worker reported its hostname, user, the workspaces `workspace.list` returns with their `hostId`, whether each path is readable, its `ORCA*` environment, and the output of the `orca` CLI. Loaded with `orca plugin dev load` into the iMac's Orca (1.4.255) and, with `--environment home-office-omarchy`, into the home-office Orca server (1.4.259); called with `orca plugin dev request`; rendered with `orca plugin shot --environment home-office-omarchy`. Unloaded and deleted afterwards.

Findings:

- A plugin belongs to one Orca server. Loaded into the iMac's Orca, its worker ran on the iMac (`sky64-omarchy`) and `workspace.list` returned only the iMac's 6 workspaces, all `hostId: local`; no home-office workspace appeared.
- Loaded into the home-office server, its worker ran on home-office (`omarchy`, user `kennethdixon`), `workspace.list` returned that server's 107 workspaces, all `hostId: local` and readable, and the panel rendered with that data through `orca plugin shot --environment home-office-omarchy`.
- On 1.4.259, `workspace.readContext` also returns `workspaceId` (an `identity:wt2:…` id), which matches `workspace.list` exactly; 1.4.255 returns no id. Focus resolution uses the id when present and the branch-and-name match otherwise.
- The worker's environment has no `ORCA*` variables and no `orca` on `PATH`. The CLI shim exists on both machines at `~/.config/orca/linux-orca-cli-shim/orca`, and the home-office worker ran `worktree list --json` and `terminal list --json` through it.

Decision: transport `same-host`. crew64-map is installed on each Orca server whose repositories it should map (today the home-office server, and the iMac's for local repositories). Every read is local to the worker: the ledger, git, `gh`, and the `orca` CLI through the shim. There is no `RemoteSource`; the plan's Task 5 builds `LocalSource` only, finds the CLI through the plugin setting `orcaCli` (default `$XDG_CONFIG_HOME/orca/linux-orca-cli-shim/orca`, else `~/.config/orca/linux-orca-cli-shim/orca`), and says in a note when it is missing.

Still to confirm in Task 7: that the iMac's Orca window shows the home-office server's panel in its sidebar while a home-office workspace is focused (the shot proves the server renders it, not that the client displays it).
