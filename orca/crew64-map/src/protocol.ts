// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type TaskState = 'waiting' | 'working' | 'blocked' | 'review' | 'done' | 'abandoned' | 'unknown'

/** A value for display: `inferred` marks it `~`, a null value shows `—`. */
export type Cell<T> = { value: T | null; inferred: boolean }

export type PrInfo = { number: number; url: string; state: 'open' | 'merged' | 'closed' | 'unknown' }

export type TaskRow = {
  task: number
  title: string
  state: TaskState
  stateInferred: boolean
  /** Task numbers the plan row names as dependencies; only set while the state is `waiting`. */
  waitingOn: number[]
  tier: Cell<string>
  rung: Cell<number>
  mode: Cell<string>
  model: Cell<string>
  reviews: { used: number; allowance: number }
  escalations: number
  /** Each direction is null when unknown; a missing count is never shown as 0. */
  tokens: Cell<{ in: number | null; out: number | null }>
  worktreePath: string | null
  branch: string | null
  pr: PrInfo | null
  prUnknown: boolean
}

export type MapView = {
  status: 'ok' | 'off' | 'no-plan' | 'ambiguous' | 'error'
  repo: { name: string; host: string | null } | null
  candidates: { id: string; name: string }[]
  plans: { plan: string; lastTs: string }[]
  plan: string | null
  rows: TaskRow[]
  totals: {
    done: number
    total: number
    tokensIn: number
    tokensOut: number
    escalations: number
    reviewsUsed: number
    reviewsAllowance: number
  }
  notes: string[]
}

/** Live Orca and GitHub facts for one repository; `prs` is null when GitHub is unavailable. */
export type Live = {
  worktrees: { path: string; branch: string }[]
  terminals: { worktreePath: string; status: 'working' | 'blocked' | 'waiting' | 'gone' }[]
  /** Worktree paths with an Orca `needs-input` escalation. */
  needsInput: string[]
  prs: { number: number; headRefName: string; state: 'open' | 'merged' | 'closed'; url: string }[] | null
  /** Tokens parsed from `Tokens: <in>/<out>` commit trailers, by task number (inferred). */
  trailerTokens?: Record<number, { in: number; out: number }>
}

export type LedgerTask = {
  task: number
  title: string | null
  tier: string | null
  rung: number | null
  mode: string | null
  model: string | null
  /** 'launch' when a dispatched/native_started event named the model; only then is it a fact. */
  model_source: 'planned' | 'launch' | null
  worktree: string | null
  branch: string | null
  dispatch: string | null
  reviews: number
  escalations: number
  tokens_in: number | null
  tokens_out: number | null
  pr: number | null
  pr_url: string | null
  merged: boolean
  abandoned: boolean
  last_event: string
  last_ts: string
}

/** What `crew64_ledger.py show --json` prints. */
export type LedgerShow = {
  repo: {
    v: number
    build_map: boolean
    review_cycles: number
    this_host: string | null
    repo_root: string
    github: string | null
    ledger_version: string
  } | null
  plans: { plan: string; last_ts: string; tasks: LedgerTask[] }[]
  skipped_lines: number
}

/** One row of a plan's Tasks table; absent columns are null. */
export type PlanRow = {
  task: number
  title: string
  tier: string | null
  rung: number | null
  mode: string | null
  vendor: string | null
  model: string | null
  dependsOn: number[]
}

declare module 'orca' {
  interface PluginRequests {
    /** The total the worker keeps in storage. */
    'counter.get': { output: { total: number } }
    /** Adds `by` to the stored total and answers the new total. */
    'counter.add': { input: { by: number }; output: { total: number } }
    /** The folded map for the repository being viewed. */
    view: { output: MapView }
    /** Views another plan of the same repository; changes nothing else. */
    selectPlan: { input: { plan: string }; output: MapView }
    /** Views another repository (a `candidates` id from `workspace.list`); changes nothing else. */
    selectRepo: { input: { id: string }; output: MapView }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the total changes. */
    'counter.changed': { total: number }
    /** Posted to every open panel on each refresh. */
    view: MapView
  }
}
