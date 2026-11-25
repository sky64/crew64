import { assert, test } from 'orca/testing'
import { fold, parsePlanTable } from '../src/fold'
import type { LedgerShow, LedgerTask, Live, PlanRow } from '../src/protocol'

const WT = '/w/crew64-map-t4'

function task(over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    task: 1, title: 'Add the parser', tier: 'normal', rung: 1, mode: 'delegated', model: 'claude-sonnet-5-5',
    worktree: WT, branch: 'sky64/add-the-parser', dispatch: 'ctx_1', reviews: 0, escalations: 0,
    tokens_in: null, tokens_out: null, pr: null, pr_url: null, merged: false, abandoned: false,
    last_event: 'dispatched', last_ts: '2026-11-25T10:00:00+00:00', ...over
  }
}

function ledger(tasks: LedgerTask[], over: Partial<LedgerShow> = {}): LedgerShow {
  return {
    repo: { v: 1, build_map: true, review_cycles: 2, this_host: null, repo_root: '/home/x/proj', github: 'o/n', ledger_version: '1' },
    plans: [{ plan: 'docs/plans/p.md', last_ts: '2026-11-25T10:00:00+00:00', tasks }],
    skipped_lines: 0, ...over
  }
}

function live(over: Partial<Live> = {}): Live {
  return { worktrees: [{ path: WT, branch: 'sky64/add-the-parser' }], terminals: [], needsInput: [], prs: [], ...over }
}

const first = (l: LedgerShow, v: Live, plan: PlanRow[] | null = null) => fold(l, v, plan).rows[0]

test('mergedInLogIsDone', () => {
  const row = first(ledger([task({ merged: true, last_event: 'merged' })]), live({ worktrees: [] }))
  assert.equal(row.state, 'done')
  assert.equal(row.stateInferred, false)
})

test('prMergedWithoutLogIsDoneInferred', () => {
  const prs: Live['prs'] = [{ number: 7, headRefName: 'sky64/add-the-parser', state: 'merged', url: 'u' }]
  const row = first(ledger([task()]), live({ prs }))
  assert.equal(row.state, 'done')
  assert.equal(row.stateInferred, true)
  assert.equal(row.pr?.number, 7)
})

test('blockedTerminalIsBlocked', () => {
  const row = first(ledger([task()]), live({ terminals: [{ worktreePath: WT, status: 'blocked' }] }))
  assert.equal(row.state, 'blocked')
})

test('needsInputIsBlocked', () => {
  const row = first(ledger([task()]), live({ needsInput: [WT] }))
  assert.equal(row.state, 'blocked')
})

test('openPrIsReview', () => {
  const prs: Live['prs'] = [{ number: 8, headRefName: 'sky64/add-the-parser', state: 'open', url: 'u' }]
  const row = first(ledger([task({ pr: 8, pr_url: 'u' })]), live({ prs }))
  assert.equal(row.state, 'review')
  assert.equal(row.stateInferred, false)
})

test('dispatchedWithLiveWorktreeIsWorking', () => {
  const row = first(ledger([task()]), live({ terminals: [{ worktreePath: WT, status: 'working' }] }))
  assert.equal(row.state, 'working')
  assert.equal(first(ledger([task()]), live({ terminals: [{ worktreePath: WT, status: 'waiting' }] })).state, 'working')
})

test('noTerminalForDispatchedTaskIsUnknown', () => {
  assert.equal(first(ledger([task()]), live()).state, 'unknown')
  assert.equal(first(ledger([task()]), live({ terminals: [{ worktreePath: '/other', status: 'working' }] })).state, 'unknown')
  const native = task({ dispatch: null, last_event: 'native_started' })
  assert.equal(first(ledger([native]), live()).state, 'unknown')
})

test('deadTerminalIsUnknown', () => {
  const row = first(ledger([task()]), live({ terminals: [{ worktreePath: WT, status: 'gone' }] }))
  assert.equal(row.state, 'unknown')
})

test('worktreeGoneWithoutMergeIsUnknown', () => {
  const row = first(ledger([task()]), live({ worktrees: [] }))
  assert.equal(row.state, 'unknown')
})

test('branchSlugInferenceMarksTilde', () => {
  const planned = task({ worktree: null, branch: null, dispatch: null, last_event: 'planned' })
  const row = first(ledger([planned]), live())
  assert.equal(row.state, 'working')
  assert.equal(row.stateInferred, true)
  assert.equal(row.worktreePath, WT)
  const none = first(ledger([planned]), live({ worktrees: [] }))
  assert.equal(none.state, 'waiting')
})

test('foldIgnoresBadLines', () => {
  const view = fold(ledger([task(), task({ task: 2, title: 'Two' })], { skipped_lines: 2 }), live(), null)
  assert.equal(view.rows.length, 2)
  assert.equal(view.notes.length, 1)
  assert.match(view.notes[0], /2/)
})

test('totalsAddUp', () => {
  const tasks = [
    task({ merged: true, reviews: 1, escalations: 1, tokens_in: 100, tokens_out: 10, last_event: 'merged' }),
    task({ task: 2, title: 'Two', worktree: null, branch: null, dispatch: null, last_event: 'planned', reviews: 2, tokens_in: 50, tokens_out: 5 }),
    task({ task: 3, title: 'Three', worktree: null, branch: null, dispatch: null, last_event: 'planned' })
  ]
  const t = fold(ledger(tasks), live({ worktrees: [] }), null).totals
  assert.deepEqual(t, { done: 1, total: 3, tokensIn: 150, tokensOut: 15, escalations: 1, reviewsUsed: 3, reviewsAllowance: 6 })
})

test('parsePlanTableByHeaderNames', () => {
  const md = readFixture()
  const rows = parsePlanTable(md)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].task, 1)
  assert.equal(rows[0].title, 'Add the parser')
  assert.equal(rows[0].mode, null)
  assert.equal(rows[0].model, 'claude-sonnet-5-5')
  assert.equal(rows[1].rung, 2)
  assert.equal(rows[1].model, null)
  assert.deepEqual(rows[1].dependsOn, [1])
  const view = fold({ repo: ledger([]).repo, plans: [], skipped_lines: 0 }, live({ worktrees: [] }), rows)
  assert.equal(view.rows[0].mode.value, null)
  assert.equal(view.rows[0].mode.inferred, false)
  assert.equal(view.rows[1].state, 'waiting')
  assert.deepEqual(view.rows[1].waitingOn, [1])
})

test('buildMapOffGivesOffStatus', () => {
  const l = ledger([task()])
  l.repo = { ...l.repo!, build_map: false }
  assert.equal(fold(l, live(), null).status, 'off')
  assert.equal(fold({ repo: null, plans: [], skipped_lines: 0 }, live(), null).status, 'off')
  assert.equal(fold(ledger([]), live(), null).status, 'ok')
})

test('logPrWithGithubUnavailableIsUnknownNotReview', () => {
  const t = task({ pr: 9, pr_url: 'https://x/9' })
  const row = first(ledger([t]), live({ prs: null, terminals: [{ worktreePath: WT, status: 'waiting' }] }))
  assert.equal(row.prUnknown, true)
  assert.equal(row.pr?.state, 'unknown')
  assert.equal(row.pr?.number, 9)
  assert.equal(row.pr?.url, 'https://x/9')
  assert.equal(row.state, 'working')
  const gone = first(ledger([t]), live({ prs: null, worktrees: [] }))
  assert.equal(gone.state, 'unknown')
})

test('partialTokensInOnly', () => {
  const v = fold(ledger([task({ tokens_in: 100, tokens_out: null })]), live(), null)
  assert.deepEqual(v.rows[0].tokens, { value: { in: 100, out: null }, inferred: false })
  assert.equal(v.totals.tokensIn, 100)
  assert.equal(v.totals.tokensOut, 0)
  assert.equal(v.notes.length, 1)
})

test('partialTokensOutOnly', () => {
  const v = fold(ledger([task({ tokens_in: null, tokens_out: 20 })]), live(), null)
  assert.deepEqual(v.rows[0].tokens, { value: { in: null, out: 20 }, inferred: false })
  assert.equal(v.totals.tokensOut, 20)
  assert.equal(v.notes.length, 1)
})

test('plannedModelIsInferred', () => {
  const planned = task({ worktree: null, branch: null, dispatch: null, last_event: 'planned', model: 'claude-opus-5-5' })
  const row = first(ledger([planned]), live({ worktrees: [] }))
  assert.deepEqual(row.model, { value: 'claude-opus-5-5', inferred: true })
  assert.deepEqual(first(ledger([task()]), live()).model, { value: 'claude-sonnet-5-5', inferred: false })
})

test('missingLedgerFieldsDoNotThrow', () => {
  const run = (l: unknown) => fold(l as LedgerShow, live(), null)
  assert.equal(run({}).status, 'off')
  assert.equal(run(null).status, 'off')
  assert.equal(run({ repo: null }).status, 'off')
  const repo = ledger([]).repo
  assert.equal(run({ repo }).status, 'no-plan')
  assert.equal(run({ repo: { build_map: true } }).status, 'no-plan')
  const bare = { task: 1, last_event: 'dispatched', worktree: WT }
  const v = run({ repo: { build_map: true, review_cycles: 2 }, plans: [{ plan: 'p.md', tasks: [bare, { nope: 1 }] }] })
  assert.equal(v.rows.length, 1)
  const r = v.rows[0]
  assert.equal(r.reviews.used, 0)
  assert.equal(r.escalations, 0)
  assert.equal(r.tokens.value, null)
  assert.equal(r.title, 'Task 1')
  assert.equal(Number.isNaN(v.totals.tokensIn), false)
  assert.equal(Number.isNaN(v.totals.reviewsUsed), false)
  const empty = run({ repo, plans: [{ plan: 'p.md' }], skipped_lines: 'x' })
  assert.equal(empty.status, 'ok')
  assert.equal(empty.rows.length, 0)
  assert.deepEqual(empty.notes, [])
})

import { readFileSync } from 'node:fs'
function readFixture(): string {
  return readFileSync(new URL('./fixtures/plan-scout64.md', import.meta.url), 'utf8')
}
