import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from '../src/main'
import { LocalSource, type ExecFn } from '../src/sources'
import type { MapView } from '../src/protocol'

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
    exists: async (p: string) => p in files
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

test('workspaceEventsRefreshAndAgentStatusIsKept', async () => {
  const { worker } = await mount({
    'workspace.list': { workspaces: [ws('w1', `${REPO}/wt`, 'b', 'b')], truncated: false },
    'workspace.readContext': { branch: 'b', displayName: 'b', terminals: [] }
  })
  await worker.request('view')
  const before = worker.posts.length
  await worker.emit('workspace.changed', { context: { branch: 'b', displayName: 'b', terminals: [] } })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(worker.posts.length > before)
  await worker.deactivate()
})
