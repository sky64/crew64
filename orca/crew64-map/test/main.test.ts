import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from '../src/main'
import { LocalSource, type ExecFn } from '../src/sources'
import type { Live, MapView } from '../src/protocol'
import type { Source } from '../src/sources'

const REPO = '/home/u/repo'
const task = (n: number, extra: Record<string, unknown> = {}) => ({
  task: n, title: `task ${n}`, tier: 'normal', rung: 1, mode: 'delegated', model: null, model_source: null,
  worktree: null, branch: null, dispatch: null, reviews: 0, escalations: 0, tokens_in: null, tokens_out: null,
  pr: null, pr_url: null, merged: false, abandoned: false, last_event: 'planned', last_ts: '2026-11-25T00:00:00Z', ...extra
})
const LEDGER = {
  repo: { v: 1, build_map: true, review_cycles: 2, this_host: null, repo_root: REPO, github: null, ledger_version: '1' },
  plans: [
    { plan: 'docs/plans/new.md', last_ts: '2026-11-25T02:00:00Z', tasks: [task(1)] },
    { plan: 'docs/plans/old.md', last_ts: '2026-11-24T02:00:00Z', tasks: [task(7)] }
  ],
  skipped_lines: 0
}

function sourceFor(logDir: string | null = null, ledger: unknown = LEDGER) {
  const files = { '/c/tools/crew64_ledger.py': '' }
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'git') return `${REPO}/.git\n`
    if (cmd === 'python3' && args[2] === 'path') return `${logDir}\n`
    if (cmd === 'python3') return JSON.stringify(ledger)
    if (cmd === 'gh') return '[]'
    throw new Error('unexpected ' + cmd)
  }
  const fs = {
    readdir: async () => [], readFile: async () => { throw new Error('none') },
    exists: async (p: string) => p in files,
    realpath: async (p: string) => p,
    isSymlink: async () => false
  }
  return new LocalSource({ exec, fs, home: '/h', env: {}, now: () => Date.now(), settings: async () => ({ crew64Root: '/c' }) })
}

const ws = (id: string, path: string, branch: string, name: string) => ({ id, kind: 'worktree', name, path, branch, hostId: 'local' })
const noWatch = () => ({ close() {} })

async function mount(results: Record<string, unknown>, source = sourceFor(), watch: Parameters<typeof main.activateWith>[1]['watch'] = noWatch, debounceMs = 20) {
  const host = mockHost({ results })
  const worker = await mountWorker(
    { default: (orca) => main.activateWith(orca, { source, watch, debounceMs, intervalMs: 0 }), deactivate: main.deactivate },
    { host }
  )
  return { worker, host }
}

test('viewFoldsLedgerForTheFocusedRepository', async () => {
  const { worker } = await mount({
    'workspace.list': { workspaces: [ws('w1', `${REPO}/wt`, 'b', 'b')], truncated: false },
    'workspace.readContext': { branch: 'b', displayName: 'b', terminals: [] }
  })
  const view = (await worker.request('view')) as MapView
  assert.equal(view.status, 'ok')
  assert.equal(view.plan, 'docs/plans/new.md')
  assert.deepEqual(view.rows.map((r) => r.task), [1])
  await worker.deactivate()
})

test('ambiguousFocusOffersPickerThenSelectRepo', async () => {
  const { worker, host } = await mount({
    'workspace.list': { workspaces: [ws('a', `${REPO}/wt`, 'main', 'main'), ws('b', '/other/wt', 'main', 'main')], truncated: false },
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] }
  }, (() => {
    const s = sourceFor()
    const real = s.repoRoot.bind(s)
    s.repoRoot = async (p) => (p.startsWith('/other') ? '/other' : real(p))
    return s
  })())
  const first = (await worker.request('view')) as MapView
  assert.equal(first.status, 'ambiguous')
  assert.deepEqual(first.candidates.map((c) => c.id), ['a', 'b'])
  const after = (await worker.request('selectRepo', { id: 'a' })) as MapView
  assert.equal(after.status, 'ok')
  assert.equal(host.data().storage.repoId, 'a')
  await worker.deactivate()
})

test('selectPlanChangesOnlyWhatIsViewed', async () => {
  const { worker, host } = await mount({
    'workspace.list': { workspaces: [ws('w1', `${REPO}/wt`, 'b', 'b')], truncated: false },
    'workspace.readContext': { branch: 'b', displayName: 'b', terminals: [] }
  })
  const v = (await worker.request('selectPlan', { plan: 'docs/plans/old.md' })) as MapView
  assert.equal(v.plan, 'docs/plans/old.md')
  assert.deepEqual(v.rows.map((r) => r.task), [7])
  assert.equal(host.data().storage.plan, 'docs/plans/old.md')
  // Only the read-only host methods were used.
  assert.deepEqual([...new Set(host.calls.map((c) => c.method).filter((m) => !m.startsWith('storage.') && !m.startsWith('settings.')))].sort(), ['workspace.list', 'workspace.readContext'])
  await worker.deactivate()
})

test('noFocusedWorkspaceIsAnErrorViewNotACrash', async () => {
  const { worker } = await mount({ 'workspace.list': { workspaces: [], truncated: false }, 'workspace.readContext': null })
  const v = (await worker.request('view')) as MapView
  assert.equal(v.status, 'error')
  assert.ok(v.notes.length > 0)
  await worker.deactivate()
})

test('logChangeTriggersRefresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew64-map-'))
  const log = join(dir, 'new.jsonl')
  await writeFile(log, '{"v":1}\n')
  await mkdir(join(dir, 'x'))
  const { worker } = await mount({
    'workspace.list': { workspaces: [ws('w1', `${REPO}/wt`, 'b', 'b')], truncated: false },
    'workspace.readContext': { branch: 'b', displayName: 'b', terminals: [] }
  }, sourceFor(dir), (await import('node:fs')).watch as never)
  try {
    await worker.request('view.lease')
    await worker.request('view')
    const before = worker.posts.filter((p) => p.event === 'view').length
    await appendFile(log, '{"v":1,"event":"x"}\n')
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && worker.posts.filter((p) => p.event === 'view').length === before) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(worker.posts.filter((p) => p.event === 'view').length > before, 'a fresh view was posted within 2 s')
  } finally {
    await worker.deactivate()
  }
})

test('workspaceEventsRefreshWhileTheLeaseHolds', async () => {
  const { worker } = await mount({
    'workspace.list': { workspaces: [ws('w1', `${REPO}/wt`, 'b', 'b')], truncated: false },
    'workspace.readContext': { branch: 'b', displayName: 'b', terminals: [] }
  })
  await worker.request('view.lease')
  await worker.request('view')
  await new Promise((r) => setTimeout(r, 60))
  const before = worker.posts.length
  await worker.emit('workspace.changed', { context: { branch: 'b', displayName: 'b', terminals: [] } })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(worker.posts.length > before)
  await worker.deactivate()
})

// --- correction cycle 1 -------------------------------------------------------------------

const WT = '/repo-task'
const taskRow = { task: 1, title: 'task', tokens_in: null, tokens_out: null, branch: 'a', worktree: WT, last_event: 'dispatched' }
const stubLedger = {
  repo: { build_map: true, repo_root: '/repo', review_cycles: 2 },
  plans: [
    { plan: 'docs/superpowers/plans/a.md', last_ts: '', tasks: [taskRow] },
    { plan: 'docs/superpowers/plans/b.md', last_ts: '', tasks: [{ ...taskRow, branch: 'b' }] }
  ],
  skipped_lines: 0
}
type LiveFn = (root: string, paths: string[], branches?: { task: number; branch: string }[]) => Promise<Live>
function stub(live: LiveFn): Source & { liveCalls: number } {
  const s = {
    liveCalls: 0,
    ledger: async () => stubLedger as never,
    repoRoot: async () => '/repo',
    planFile: async () => null,
    logDir: async () => null,
    notes: () => [] as string[],
    live: async (r: string, p: string[], b?: { task: number; branch: string }[]) => { s.liveCalls++; return live(r, p, b) }
  }
  return s
}
const baseLive = (terminals: Live['terminals'], extra: Partial<Live> = {}): Live =>
  ({ worktrees: [{ path: WT, branch: 'a' }], terminals, needsInput: [], prs: [], ...extra })
const taskWs = { id: 'w', kind: 'worktree', path: WT, branch: 'task', name: 'task', hostId: 'local' }
const taskResults = {
  'workspace.list': { workspaces: [taskWs], truncated: false },
  'workspace.readContext': { branch: 'task', displayName: 'task', terminals: [] }
}
const taskCtx = { context: { branch: 'task', displayName: 'task', terminals: [] } }
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const PR = { number: 9, headRefName: 'a', state: 'open' as const, url: 'https://github.com/o/r/pull/9' }

async function mountStub(source: Source) {
  return mount(taskResults, source as never)
}

test('removedWorkerEventIsNotInheritedBySurvivingPane', async () => {
  const s = stub(async () => baseLive([{ worktreePath: WT, status: 'waiting', ids: ['surviving'], agent: true }], { prs: [PR] }))
  const { worker } = await mountStub(s)
  try {
    await worker.request('view')
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'removed:worker', terminalId: 'removed', state: 'working', receivedAt: Date.now() })
    await tick(10)
    await worker.emit('workspace.changed', taskCtx)
    await tick()
    const v = (await worker.request('view')) as MapView
    assert.equal(v.rows[0].state, 'review')
  } finally { await worker.deactivate() }
})

test('agentEventJoinsByTerminalIdentity', async () => {
  const s = stub(async () => baseLive([
    { worktreePath: WT, status: 'waiting', ids: ['t1'], agent: true },
    { worktreePath: WT, status: 'waiting', ids: ['t2'], agent: true }
  ]))
  const { worker } = await mountStub(s)
  try {
    await worker.request('view')
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'tab:p1', terminalId: 't1', state: 'blocked', receivedAt: 1 })
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'tab:p2', terminalId: 't2', state: 'working', receivedAt: 2 })
    // Two agents in one worktree do not overwrite each other: blocked wins over working.
    assert.equal(((await worker.request('view')) as MapView).rows[0].state, 'blocked')
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'tab:p1', terminalId: 't1', state: 'done', receivedAt: 3 })
    assert.equal(((await worker.request('view')) as MapView).rows[0].state, 'working')
  } finally { await worker.deactivate() }
})

test('plainShellIsNotWorkerLiveness', async () => {
  const s = stub(async () => baseLive([{ worktreePath: WT, status: 'waiting', ids: ['sh'], agent: false }]))
  const { worker } = await mountStub(s)
  try {
    const v = (await worker.request('view')) as MapView
    assert.equal(v.rows[0].state, 'unknown')
    // An agent event for another pane does not turn the shell into a worker.
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'x:y', terminalId: 'other', state: 'working', receivedAt: 1 })
    assert.equal(((await worker.request('view')) as MapView).rows[0].state, 'unknown')
  } finally { await worker.deactivate() }
})

test('eventStateIsDroppedWhenItsTerminalDisappearsFromTheSnapshot', async () => {
  let listed: Live['terminals'] = [{ worktreePath: WT, status: 'waiting', ids: ['t1'], agent: true }]
  const s = stub(async () => baseLive(listed, { prs: [PR] }))
  const { worker } = await mountStub(s)
  try {
    await worker.request('view')
    await worker.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'p', terminalId: 't1', state: 'working', receivedAt: 1 })
    assert.equal(((await worker.request('view')) as MapView).rows[0].state, 'working')
    listed = [{ worktreePath: WT, status: 'waiting', ids: ['t9'], agent: true }]
    await worker.emit('workspace.changed', taskCtx)
    await tick()
    await worker.emit('workspace.changed', taskCtx)
    await tick()
    assert.equal(((await worker.request('view')) as MapView).rows[0].state, 'review')
  } finally { await worker.deactivate() }
})

test('leaseKeepsPanelOpenAndLapseStopsRefreshAndPolling', async () => {
  const s = stub(async () => baseLive([{ worktreePath: WT, status: 'waiting', ids: ['t'], agent: true }]))
  const { worker } = await mountStub(s)
  const real = Date.now
  let t = real()
  Date.now = () => t
  try {
    assert.deepEqual(await worker.request('view.lease'), { ok: true })
    await tick()
    assert.ok(worker.posts.filter((p) => p.event === 'view').length >= 1, 'first lease refreshes at once')
    for (let i = 0; i < 12; i++) { t += 30_000; await worker.request('view.lease') }
    let posts = worker.posts.length
    await worker.emit('workspace.changed', taskCtx)
    await tick()
    assert.ok(worker.posts.length > posts, 'still open after six minutes of renewals')
    t += 91_000
    posts = worker.posts.length
    const liveCalls = s.liveCalls
    await worker.emit('workspace.changed', taskCtx)
    await tick()
    assert.equal(worker.posts.length, posts, 'a lapsed lease refreshes nothing')
    assert.equal(s.liveCalls, liveCalls, 'and polls nothing')
    await worker.request('view.lease')
    await tick()
    assert.ok(worker.posts.length > posts, 'the next lease refreshes at once')
  } finally { Date.now = real; await worker.deactivate() }
})

test('snapshotIsKeyedByPlan', async () => {
  const s = stub(async (_r, _p, branches) => baseLive([], { trailerTokens: { 1: { in: branches?.[0]?.branch === 'a' ? 100 : 200, out: 1 } } }))
  const { worker } = await mountStub(s)
  try {
    assert.equal(((await worker.request('view')) as MapView).rows[0].tokens.value?.in, 100)
    const v = (await worker.request('selectPlan', { plan: 'docs/superpowers/plans/b.md' })) as MapView
    assert.equal(v.rows[0].tokens.value?.in, 200)
  } finally { await worker.deactivate() }
})

test('requestBuildsAreSerialized', async () => {
  let running = 0
  let peak = 0
  const s = stub(async () => {
    running++
    peak = Math.max(peak, running)
    await tick(15)
    running--
    return baseLive([])
  })
  const { worker } = await mountStub(s)
  try {
    await Promise.all([worker.request('view'), worker.request('selectPlan', { plan: 'docs/superpowers/plans/b.md' }), worker.request('view')])
    assert.equal(peak, 1)
  } finally { await worker.deactivate() }
})

test('unlistedFocusIdIsAnErrorViewNotAnotherRepository', async () => {
  const { worker } = await mount({
    'workspace.list': { workspaces: [ws('B', '/B', 'main', 'repo-B')], truncated: false },
    'workspace.readContext': { branch: 'main', displayName: 'repo-A', terminals: [] }
  })
  try {
    const v = (await worker.request('view')) as MapView
    assert.equal(v.status, 'ambiguous')
    assert.deepEqual(v.candidates.map((c) => c.id), ['B'])
  } finally { await worker.deactivate() }
})
