# 0012: A stripped core, with everything else decided by the plan

Date: 2026-11-27. Status: proposed. The owner asked for this page to be recorded; it is not accepted and nothing in force changes with it. The open points at the end are the orchestrator's objections to the draft and are not decided.

## Context

- [Decision 0002](0002-bare-minimum-harness.md) (2026-10-24) already chose a bare-minimum harness with add-ons per project, because an always-on plugin cost too much context. Since then the harness has grown its own always-on text: the orchestrator skill, `AGENTS.md` and [docs/05-delegation.md](../05-delegation.md) are 67 KB together, read in full at the start of every orchestrator session, and the two Orca guides the skill loads add about 52 KB.
- Features are switches ([decision 0005](0005-feature-switches-and-portability.md)). A switch that is off does not remove its rules from what the orchestrator reads.
- No metering gateway is connected in any repository (`features.metering` is `none`), so nothing in the harness depends on one today.
- The first field measurement of the harness (issues #46 and #36) found that the orchestrator session, not the workers, is the largest share of Claude usage.
- The owner's intent: one small core that is the same in every repository, and every further part (model strength, extra skills, hooks, a gateway) chosen while the plan for a repository is made. A simple build should need the core only. A hard task must not fall back to a generic agent because equipping a specialist took too many steps.

## Proposed decision

**Purpose.** One loop, the same in every repository: plan, dispatch, implement, review, merge. Everything else is a module that a repository's plan turns on. A simple build runs on the core alone.

**1. Three roles.**

- Orchestrator: plans, dispatches, checks results, merges. Writes no code.
- Implementer: one per task, in its own worktree.
- Reviewer: an independent context that ends with one verdict line.

**2. The plan is the only place where decisions are made.** It is written once, when the repository or a piece of work is formed. Each task row carries:

- what to do, the files, and the acceptance checks;
- the specialist: one agent and its skills, by exact name;
- the model and its effort setting, for the implementer and for the reviewer;
- the mode: one session does it alone, or a worker is dispatched;
- how many correction rounds are allowed before the owner is asked.

The plan also lists the modules that are on, and what the owner must supply. A single task is a one-row plan. There is no ladder, tier table or escalation rule at dispatch; dispatch reads the row.

**3. Equipping is one step, and skipping it is blocked.**

- The planner searches the skill library with one command and writes the matching names into the row.
- If nothing fits, the plan gets an earlier task: write the missing skill to the standard.
- A check refuses to dispatch a row without a named specialist.
- A generic agent is allowed only where the plan says so with a reason, never on a row the plan marks difficult.
- The brief is generated from the row with the skill text already pasted in, so the equipped path is the shortest path.

**4. Skill standard and library.**

- A skill is one folder with one file and a fixed header: name, when to use it, tags for technology and domain, inputs, outputs, how to verify, origin.
- It holds no repository-specific paths; those are parameters.
- A project writes new skills to this standard. A skill that passes review is promoted to one shared library with a generated index, searchable by name, tag and description.
- Plans search the library first.

**5. Guard.** One hook stops the orchestrator from writing in the main checkout.

**6. Review and merge.** Every pull request head gets one independent review. Merge needs CI green and a clean verdict on the same head ([decision 0011](0011-machine-merge-gate.md)).

**7. Report.** What changed, what was checked, what is untested, and measured tokens.

**Not in the core.** These are modules, off unless the plan turns them on: bot identity, a metering gateway, the read-only scout, deploy and live checks, and anything project-specific.

**Size budget.** The core rules the orchestrator reads fit in 8 KB. Each module fits on one page. CI enforces both.

## What exists and what would be built

| Part | State |
|---|---|
| Plan template, `plan-tooling` skill | exists |
| Guard hook | exists |
| Review status script, CI gate | exists |
| Cut-down core rule text | to build (mostly deletion and splitting) |
| Dispatch check for a named specialist | to build |
| Brief generator from a plan row | to build |
| Skill standard, library, search command | to build |

## Open points (orchestrator's objections, not decided)

1. **The page keeps the loop that costs the most.** Shorter rules cut the fixed context, but the orchestrator's cost is mostly the history it carries: every worker report, review and check result. The page should make "one session does the task alone, then review" the default mode and dispatch the exception, and should end the orchestrator session per task, with the plan as the state that carries over.
2. **A planner without numbers picks the strongest model.** The plan needs a stated default (the cheapest model whose result the row's checks can verify) and measured results fed back into the next plan. One small rule for a failed row is still needed, for example one step up, once.
3. **A name check does not ensure fit.** A check for a named specialist is satisfied by any name, including a broad agent. What a specialist adds over a generic agent given the same skill text has not been measured here. The owner's review of the plan is the real control; the check only makes omission visible.
4. **The library may be early.** The repository vendors two skills. Claude Code's skill format already has a header and a description the model searches. The standard should be that format plus the few fields above, and the library a plain repository with a generated index, until there are enough skills to need more.
5. **The review rule can deadlock.** With "merge needs a clean verdict" and no limit on what a reviewer may call a blocker, a task can fail review indefinitely on a heuristic. The core needs a recorded way for the owner to accept a documented limit.
6. **Much of the dispatch plumbing is Orca's.** Worktrees, worker start with model and effort, supervision and wake-up mail, review bots and CI mail are Orca features with their own short guide. The core should name what it adds to Orca (the plan format, the equip rule, the guard, the gate status, the report) and describe none of Orca's commands itself.
7. **Regrowth.** Decision 0002 made the same choice and the text grew back. The size budget in CI is the only item on this page that prevents that, so it should come first.

## Consequences if accepted

- The orchestrator skill, `AGENTS.md` and docs/05 are cut and split; the model ladder ([0004](0004-model-ladder.md)), the process ladder ([0009](0009-process-ladder.md)) and the tier table ([0001](0001-tiered-protocol.md)) become plan columns or modules. Each of those changes is delegation policy and needs its own reviewed pull request.
- Nothing changes until then.
