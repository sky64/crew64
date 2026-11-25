# 0010: crew64-map, an Orca panel for the focused repository's plan

Date: 2026-11-25. Status: design approved by the owner on 2026-11-19 (`docs/superpowers/specs/2026-11-19-crew64-map-design.md`); plan `docs/superpowers/plans/2026-11-19-crew64-map.md` approved on 2026-11-25. The rest of this record is written in Task 3 of the plan; this section is Task 1's result.

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
