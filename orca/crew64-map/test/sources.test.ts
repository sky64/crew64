import { assert, test } from 'orca/testing'
import { LocalSource, type ExecFn } from '../src/sources'

type Call = { cmd: string; args: string[]; cwd?: string }
const REPO = '/home/u/repo'
const SHIM = '/home/u/.config/orca/linux-orca-cli-shim/orca'
const LEDGER = { repo: null, plans: [], skipped_lines: 0 }

type Routes = Record<string, string | Error | (() => string)>

/** A fake execFile: routes are keyed `cmd arg0 arg1…`, the first route whose key prefixes the call wins. */
function harness(routes: Routes, files: Record<string, string> = {}, opts: { settings?: Record<string, string>; env?: Record<string, string> } = {}) {
  const calls: Call[] = []
  const exec: ExecFn = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd })
    const line = [cmd, ...args].join(' ')
    const key = Object.keys(routes).find((k) => line.startsWith(k))
    if (key === undefined) throw Object.assign(new Error(`no route for ${line}`), { code: 'ENOENT' })
    const r = routes[key]
    if (r instanceof Error) throw r
    return typeof r === 'function' ? r() : r
  }
  let now = 1_000_000
  const fs = {
    readdir: async (p: string) => {
      const prefix = p.replace(/\/$/, '') + '/'
      return [...new Set(Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0]))]
    },
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    exists: async (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(p + '/'))
  }
  const source = new LocalSource({
    exec, fs, home: '/home/u', env: opts.env ?? {}, now: () => now,
    settings: async () => opts.settings ?? {}
  })
  return { source, calls, advance: (ms: number) => { now += ms } }
}

const TOOLS = '/opt/crew64/tools/crew64_ledger.py'
const withTools = { [TOOLS]: '' }

test('localReadsLedgerViaPython', async () => {
  const h = harness({ python3: JSON.stringify(LEDGER) }, withTools, { settings: { crew64Root: '/opt/crew64' } })
  assert.deepEqual(await h.source.ledger(REPO), LEDGER)
  assert.deepEqual(h.calls, [{ cmd: 'python3', args: ['-I', TOOLS, 'show', '--json'], cwd: REPO }])
})

test('crew64RootFromEnvThenHighestInstalledVersion', async () => {
  const env = { CREW64_ROOT: '/env/crew64' }
  const a = harness({ python3: JSON.stringify(LEDGER) }, { '/env/crew64/tools/crew64_ledger.py': '' }, { env })
  await a.source.ledger(REPO)
  assert.equal(a.calls[0].args[1], '/env/crew64/tools/crew64_ledger.py')
  const base = '/home/u/.claude/plugins/cache/crew64/crew64'
  const b = harness({ python3: JSON.stringify(LEDGER) }, {
    [`${base}/0.9.0/tools/crew64_ledger.py`]: '', [`${base}/0.10.2/tools/crew64_ledger.py`]: '', [`${base}/0.2.0/tools/crew64_ledger.py`]: ''
  })
  await b.source.ledger(REPO)
  assert.equal(b.calls[0].args[1], `${base}/0.10.2/tools/crew64_ledger.py`)
})

test('missingCrew64ToolsAddsNoteAndNoLedger', async () => {
  const h = harness({})
  assert.equal(await h.source.ledger(REPO), null)
  assert.equal(h.calls.length, 0)
  assert.equal(h.source.notes().length, 1)
  await h.source.ledger(REPO)
  assert.equal(h.source.notes().length, 1)
})

test('orcaCliFromSetting', async () => {
  const routes = { '/x/orca worktree list': '{"result":{"worktrees":[]}}', '/x/orca terminal list': '{"result":{"terminals":[]}}', '/x/orca orchestration inbox': '{"result":{"messages":[]}}', gh: '[]' }
  const a = harness(routes, { '/x/orca': '' }, { settings: { orcaCli: '/x/orca' } })
  await a.source.live(REPO, [])
  assert.ok(a.calls.some((c) => c.cmd === '/x/orca'))
  // XDG_CONFIG_HOME default, then ~/.config.
  const xdg = harness({ '/xdg/orca/linux-orca-cli-shim/orca': '{"result":{"worktrees":[],"terminals":[],"messages":[]}}', gh: '[]' }, { '/xdg/orca/linux-orca-cli-shim/orca': '' }, { env: { XDG_CONFIG_HOME: '/xdg' } })
  await xdg.source.live(REPO, [])
  assert.ok(xdg.calls.some((c) => c.cmd === '/xdg/orca/linux-orca-cli-shim/orca'))
  const home = harness({ [SHIM]: '{"result":{"worktrees":[],"terminals":[],"messages":[]}}', gh: '[]' }, { [SHIM]: '' })
  await home.source.live(REPO, [])
  assert.ok(home.calls.some((c) => c.cmd === SHIM))
})

test('missingOrcaCliMakesTerminalStateUnknown', async () => {
  const h = harness({ gh: '[]' })
  const live = await h.source.live(REPO, ['/wt/one'])
  assert.deepEqual(live.terminals, [])
  assert.deepEqual(live.worktrees, [])
  assert.deepEqual(live.needsInput, [])
  assert.ok(h.source.notes().some((n) => /orca/i.test(n)))
  assert.ok(!h.calls.some((c) => c.cmd.endsWith('/orca')))
})

const cli = (extra: Routes = {}): Routes => ({
  [`${SHIM} worktree list`]: JSON.stringify({
    result: { worktrees: [
      { id: 'r::/home/u/repo', path: REPO, repoId: 'r', branch: 'refs/heads/main' },
      { id: 'r::a b\'c', path: "a b'c", repoId: 'r', branch: 'refs/heads/sky64/t1' },
      { id: 'q::/other', path: '/other', repoId: 'q', branch: 'refs/heads/other' }
    ] }
  }),
  [`${SHIM} terminal list`]: JSON.stringify({
    result: { terminals: [
      { handle: 'term_1', worktreePath: "a b'c", connected: true, orphaned: false },
      { handle: 'term_2', worktreePath: '/other', connected: true, orphaned: false },
      { handle: 'term_3', worktreePath: REPO, connected: false, orphaned: true }
    ] }
  }),
  [`${SHIM} orchestration inbox`]: JSON.stringify({
    result: { messages: [
      { type: 'escalation', handled: false, from: 'term_1', subject: 'needs input' },
      { type: 'escalation', handled: true, from: 'term_3' },
      { type: 'worker_done', handled: false, from: 'term_1' }
    ] }
  }),
  gh: '[]',
  ...extra
})

test('pathsWithSpacesAndQuotes', async () => {
  const h = harness(cli(), { [SHIM]: '' })
  const live = await h.source.live(REPO, ["a b'c"])
  assert.deepEqual(live.worktrees.map((w) => w.path), [REPO, "a b'c"])
  assert.deepEqual(live.worktrees[1].branch, 'sky64/t1')
  assert.deepEqual(live.terminals, [
    { worktreePath: "a b'c", status: 'waiting' },
    { worktreePath: REPO, status: 'gone' }
  ])
  assert.deepEqual(live.needsInput, ["a b'c"])
})

test('noShellStrings', async () => {
  const h = harness(cli(), { [SHIM]: '', '/opt/crew64/tools/crew64_ledger.py': '' }, { settings: { crew64Root: '/opt/crew64' } })
  await h.source.ledger(REPO)
  await h.source.live(REPO, ["a b'c"], [{ task: 1, branch: 'sky64/t1' }])
  await h.source.logDir(REPO)
  assert.ok(h.calls.length >= 6)
  for (const c of h.calls) {
    assert.ok(Array.isArray(c.args), 'args is an array')
    assert.ok(c.args.every((a) => typeof a === 'string'))
    assert.ok(!/\s/.test(c.cmd), `command ${c.cmd} has no spaces`)
    assert.ok(!['sh', 'bash', 'zsh'].includes(c.cmd) && !c.args.includes('-c'))
  }
})

const PRS = JSON.stringify([
  { number: 7, headRefName: 'sky64/t1', state: 'MERGED', url: 'https://github.com/o/r/pull/7' },
  { number: 8, headRefName: 'x', state: 'OPEN', url: 'https://github.com/o/r/pull/8' },
  { number: 9, headRefName: 'y', state: 'CLOSED', url: 'https://github.com/o/r/pull/9' }
])

test('ghListsAllStatesAndMapsThem', async () => {
  const h = harness({ gh: PRS })
  const live = await h.source.live(REPO, [])
  const gh = h.calls.find((c) => c.cmd === 'gh')
  assert.deepEqual(gh?.args, ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,state,url', '--limit', '200'])
  assert.equal(gh?.cwd, REPO)
  assert.deepEqual(live.prs?.map((p) => [p.number, p.state]), [[7, 'merged'], [8, 'open'], [9, 'closed']])
})

test('ghUnavailableMarksPrUnknown', async () => {
  const h = harness({ gh: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })
  const a = await h.source.live(REPO, [])
  assert.equal(a.prs, null)
  h.advance(61_000)
  const b = await h.source.live(REPO, [])
  assert.equal(b.prs, null)
  assert.equal(h.source.notes().filter((n) => /GitHub/.test(n)).length, 1)
})

test('ghPolledAtMostOncePerMinute', async () => {
  const h = harness({ gh: PRS })
  await h.source.live(REPO, [])
  h.advance(30_000)
  const again = await h.source.live(REPO, [])
  assert.equal(h.calls.filter((c) => c.cmd === 'gh').length, 1)
  assert.equal(again.prs?.length, 3)
  h.advance(31_000)
  await h.source.live(REPO, [])
  assert.equal(h.calls.filter((c) => c.cmd === 'gh').length, 2)
  // A failed poll is not retried inside the minute either.
  const f = harness({ gh: new Error('auth') })
  await f.source.live(REPO, [])
  f.advance(10_000)
  await f.source.live(REPO, [])
  assert.equal(f.calls.filter((c) => c.cmd === 'gh').length, 1)
})

test('trailerTokensInferred', async () => {
  const h = harness(cli({
    'git symbolic-ref': 'origin/main\n',
    'git log': '1200/300\n'
  }), { [SHIM]: '' })
  const live = await h.source.live(REPO, ["a b'c"], [{ task: 1, branch: 'sky64/t1' }])
  const log = h.calls.find((c) => c.cmd === 'git' && c.args[0] === 'log')
  assert.deepEqual(log?.args, ['log', '--format=%(trailers:key=Tokens,valueonly)', 'origin/main..sky64/t1'])
  assert.equal(log?.cwd, REPO)
  assert.deepEqual(live.trailerTokens, { 1: { in: 1200, out: 300 } })
})

test('trailerTokensSumCommitsAndRejectOptionLikeBranches', async () => {
  const h = harness(cli({ 'git symbolic-ref': 'origin/main\n', 'git log': '100/20\n\n50/5\nTokens: unknown\n' }), { [SHIM]: '' })
  const live = await h.source.live(REPO, [], [{ task: 2, branch: 'sky64/t2' }, { task: 3, branch: '--output=/etc/x' }])
  assert.deepEqual(live.trailerTokens, { 2: { in: 150, out: 25 } })
  assert.equal(h.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'log').length, 1)
})

test('repoRootFromGitCommonDir', async () => {
  const h = harness({ 'git rev-parse --git-common-dir': '/home/u/repo/.git\n' })
  assert.equal(await h.source.repoRoot('/home/u/repo/.claude/wt'), '/home/u/repo')
  assert.equal(h.calls[0].cwd, '/home/u/repo/.claude/wt')
  const rel = harness({ 'git rev-parse --git-common-dir': '.git\n' })
  assert.equal(await rel.source.repoRoot('/home/u/repo'), '/home/u/repo')
})

test('planFileReadsNamedOrNewestPlan', async () => {
  const dir = `${REPO}/docs/superpowers/plans`
  const h = harness({}, { [`${dir}/2026-01-01-a.md`]: 'A', [`${dir}/2026-02-01-b.md`]: 'B' })
  assert.equal(await h.source.planFile(REPO), 'B')
  assert.equal(await h.source.planFile(REPO, 'docs/superpowers/plans/2026-01-01-a.md'), 'A')
  // A plan path that leaves the repository is refused.
  assert.equal(await h.source.planFile(REPO, '../../etc/passwd'), null)
})
