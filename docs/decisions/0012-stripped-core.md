# 0012: A stripped core, with everything else decided by the plan

Date: 2026-11-27. Status: proposed. The owner asked for this page to be recorded; it is not accepted and nothing in force changes with it. Revised the same day at the owner's request: five of the orchestrator's objections to the first draft are now part of the proposal (marked "revision" below). Two open points remain at the end and are not decided.

## Context

- [Decision 0002](0002-bare-minimum-harness.md) (2026-10-24) already chose a bare-minimum harness with add-ons per project, because an always-on plugin cost too much context. Since then the harness has grown its own always-on text: the orchestrator skill, `AGENTS.md` and [docs/05-delegation.md](../05-delegation.md) are 67 KB together, read in full at the start of every orchestrator session, and the two Orca guides the skill loads add about 52 KB.
- Features are switches ([decision 0005](0005-feature-switches-and-portability.md)). A switch that is off does not remove its rules from what the orchestrator reads.
- No metering gateway is connected in any repository (`features.metering` is `none`), so nothing in the harness depends on one today.
- The first field measurement of the harness (issues #46 and #36) found that the orchestrator session, not the workers, is the largest share of Claude usage.
- The owner's intent: one small core that is the same in every repository, and every further part (model strength, extra skills, hooks, a gateway) chosen while the plan for a repository is made. A simple build should need the core only. A hard task must not fall back to a generic agent because equipping a specialist took too many steps.

## Proposed decision

**Purpose.** One loop, the same in every repository: plan, do the task, review, merge. Everything else is a module that a repository's plan turns on. A simple build runs on the core alone.

**1. Roles and the default mode.**

- Implementer: the session that does one task, in its own worktree.
- Reviewer: an independent context that ends with one verdict line.
- Orchestrator: plans, dispatches, checks results, merges. Writes no code.
- Revision: the default mode is solo. One session does the task alone in a worktree, and the review follows. A row is dispatched to a worker only when the plan says so, for example because tasks run in parallel or need another vendor.
- Revision: an orchestrator session ends when its task is merged or stopped. The plan, with each row's status, is the state that carries over to the next session. No session carries the history of earlier tasks.

**2. The plan is the only place where decisions are made.** It is written once, when the repository or a piece of work is formed. Each task row carries:

- what to do, the files, and the acceptance checks;
- the specialist: one agent and its skills, by exact name;
- the model and its effort setting, for the implementer and for the reviewer;
- the mode: solo (the default) or dispatched, with the reason for dispatching;
- how many correction rounds are allowed before the owner is asked.

The plan also lists the modules that are on, and what the owner must supply. A single task is a one-row plan. There is no ladder or tier table at dispatch; whoever starts the task reads the row.

Revision, how the model is chosen:

- The default for a row is the cheapest model whose result the row's acceptance checks can verify. A stronger model needs a reason in the row.
- Measured tokens and correction rounds of finished rows are recorded in the plan, and the next plan is written with them in view.
- A row that fails its checks or its review moves one model step up, once. After that the owner is asked. This is the only escalation rule.

**3. Equipping is one step, and skipping it is visible.**

- The planner searches the skill library with one command and writes the matching names into the row.
- If nothing fits, the plan gets an earlier task: write the missing skill to the standard.
- A check refuses to start a row without a named specialist.
- A generic agent is allowed only where the plan says so with a reason, never on a row the plan marks difficult.
- The brief is generated from the row with the skill text already pasted in, so the equipped path is the shortest path.
- Revision: the check only makes an omission visible; any name satisfies it. The control is the owner's approval of the plan, so the plan shows the specialist of every row in one column.
- Revision: whether a specialist does better than a generic agent with the same skill text has not been measured. The report of each task records the specialist used and the correction rounds, so that it can be.

**4. Skill standard and library.**

- Revision: the standard is Claude Code's skill format, one folder with a `SKILL.md` whose header has a name and a description that says when to use it. The core adds a few required header fields: tags for technology and domain, inputs, outputs, how to verify, origin.
- A skill holds no repository-specific paths; those are parameters.
- A project writes new skills to this standard. A skill that passes review is promoted to the library.
- Revision: the library is a plain repository with an index file generated from the headers. Searching it is a text search of that index. Nothing more is built until the number of skills makes that insufficient.
- Plans search the library first.

**5. Guard.** One hook stops a session from writing in the main checkout.

**6. Review and merge.** Every pull request head gets one independent review. Merge needs CI green and a clean verdict on the same head ([decision 0011](0011-machine-merge-gate.md)).

Revision, the owner's waiver. A reviewer may call any wrong behaviour a blocker, so a task that rests on a heuristic can fail review without end. The owner, and only the owner, can accept one named finding as a documented limit:

- the limit is written where users of the code will read it;
- the waiver is recorded on the pull request and as the review status of that head, with a description that begins `owner waiver:` and names the finding;
- it covers that finding on that head and nothing else.

**7. Report.** What changed, what was checked, what is untested, measured tokens, the specialist used and the correction rounds.

**Not in the core.** These are modules, off unless the plan turns them on: bot identity, a metering gateway, the read-only scout, deploy and live checks, and anything project-specific.

**Size budget.** The core rules a session reads fit in 8 KB. Each module fits on one page. CI enforces both.

## What exists and what would be built

| Part | State |
|---|---|
| Plan template, `plan-tooling` skill | exists; the template needs the new columns |
| Guard hook | exists |
| Review status script, CI gate | exists; the waiver description is new |
| Solo mode in a task worktree | exists as "native mode" ([decision 0009](0009-process-ladder.md)); becomes the default |
| Measured tokens per task | a ledger script is in review and not merged |
| Cut-down core rule text | to build (mostly deletion and splitting) |
| Check for a named specialist | to build |
| Brief generator from a plan row | to build |
| Skill header fields, library repository, index | to build (small) |

## Open points (not decided)

1. **Much of the dispatch plumbing is Orca's.** Worktrees, worker start with model and effort, supervision and wake-up mail, review bots and CI mail are Orca features with their own short guide. The core should name what it adds to Orca (the plan format, the equip rule, the guard, the gate status, the report) and describe none of Orca's commands itself. Whether Orca's task records can carry a plan's rows is not yet checked.
2. **Regrowth.** Decision 0002 made the same choice and the text grew back. The size budget in CI is the only item on this page that prevents that, so it should come first.

## Consequences if accepted

- The orchestrator skill, `AGENTS.md` and docs/05 are cut and split; the model ladder ([0004](0004-model-ladder.md)), the process ladder ([0009](0009-process-ladder.md)) and the tier table ([0001](0001-tiered-protocol.md)) become plan columns or modules. The waiver narrows [decision 0011](0011-machine-merge-gate.md). Each of those changes is delegation policy and needs its own reviewed pull request.
- Nothing changes until then.
