// Pure folding of the ledger, live Orca/GitHub facts and the plan file into one view model.
// No I/O here: the worker gathers the inputs, the panel draws the output.
import type { Cell, LedgerShow, LedgerTask, Live, MapView, PlanRow, PrInfo, TaskRow, TaskState } from './protocol'

type Fact<T> = { value: T; inferred: boolean }

const cell = <T>(value: T | null | undefined, inferred = false): Cell<T> =>
  value === null || value === undefined ? { value: null, inferred: false } : { value, inferred }

/** A logged value wins; the plan row fills in, marked inferred. */
function pick<T>(logged: T | null | undefined, plan: T | null | undefined): Cell<T> {
  if (logged !== null && logged !== undefined) return cell(logged)
  return cell(plan, true)
}

export function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function emptyTask(n: number, title: string): LedgerTask {
  return {
    task: n, title, tier: null, rung: null, mode: null, model: null, worktree: null, branch: null,
    dispatch: null, reviews: 0, escalations: 0, tokens_in: null, tokens_out: null, pr: null,
    pr_url: null, merged: false, abandoned: false, last_event: 'planned', last_ts: ''
  }
}

function matchPr(t: LedgerTask, branch: string | null, live: Live): Fact<PrInfo> | null {
  const prs = live.prs ?? []
  const byNumber = t.pr === null ? undefined : prs.find((p) => p.number === t.pr)
  if (byNumber) return { value: { number: byNumber.number, url: byNumber.url, state: byNumber.state }, inferred: false }
  const byBranch = branch ? prs.find((p) => p.headRefName === branch) : undefined
  if (byBranch) {
    const state = byBranch.state
    // A log that names a different PR number is not overridden by a branch guess.
    if (t.pr !== null && t.pr !== byBranch.number) return null
    return { value: { number: byBranch.number, url: byBranch.url, state }, inferred: t.pr === null }
  }
  if (t.pr !== null && t.pr_url) return { value: { number: t.pr, url: t.pr_url, state: 'open' }, inferred: false }
  return null
}

function terminalState(path: string | null, live: Live): 'blocked' | 'working' | 'dead' | null {
  if (!path) return null
  if (live.needsInput.includes(path)) return 'blocked'
  const own = live.terminals.filter((x) => x.worktreePath === path)
  if (own.some((x) => x.status === 'blocked')) return 'blocked'
  if (own.some((x) => x.status === 'working')) return 'working'
  if (own.length > 0 && own.every((x) => x.status === 'gone')) return 'dead'
  return null
}

type Decision = { state: TaskState; inferred: boolean }

function decide(t: LedgerTask, path: string | null, started: boolean, pr: Fact<PrInfo> | null, live: Live): Decision {
  if (t.merged) return { state: 'done', inferred: false }
  if (t.abandoned) return { state: 'abandoned', inferred: false }
  if (pr?.value.state === 'merged') return { state: 'done', inferred: pr.inferred }
  const terminal = terminalState(path, live)
  if (terminal === 'blocked') return { state: 'blocked', inferred: false }
  if (terminal === 'working') return { state: 'working', inferred: !started }
  if (pr?.value.state === 'open') return { state: 'review', inferred: pr.inferred }
  if (started) {
    const exists = path !== null && live.worktrees.some((w) => w.path === path)
    return { state: exists && terminal !== 'dead' ? 'working' : 'unknown', inferred: false }
  }
  if (path) return { state: 'working', inferred: true }
  return { state: 'waiting', inferred: false }
}

function buildRow(t: LedgerTask, plan: PlanRow | undefined, live: Live, allowance: number): TaskRow {
  const started = t.last_event !== 'planned' || t.worktree !== null || t.dispatch !== null
  const slug = slugOf(t.title ?? plan?.title ?? '')
  const guessed = !started && slug ? live.worktrees.find((w) => w.branch.endsWith(slug)) : undefined
  const path = t.worktree ?? guessed?.path ?? null
  const branch = t.branch ?? guessed?.branch ?? null
  const pr = matchPr(t, branch, live)
  const { state, inferred } = decide(t, path, started, pr, live)
  const trailer = live.trailerTokens?.[t.task]
  const tokens: Cell<{ in: number; out: number }> =
    t.tokens_in !== null
      ? cell({ in: t.tokens_in, out: t.tokens_out ?? 0 })
      : trailer
        ? cell(trailer, true)
        : cell(null)
  return {
    task: t.task,
    title: t.title ?? plan?.title ?? `Task ${t.task}`,
    state,
    stateInferred: inferred,
    waitingOn: state === 'waiting' ? (plan?.dependsOn ?? []) : [],
    tier: pick(t.tier, plan?.tier),
    rung: pick(t.rung, plan?.rung),
    mode: pick(t.mode, plan?.mode),
    model: pick(t.model, plan?.model),
    reviews: { used: t.reviews, allowance },
    escalations: t.escalations,
    tokens,
    worktreePath: path,
    branch,
    pr: pr?.value ?? null,
    prUnknown: live.prs === null && pr === null
  }
}

function totalsOf(rows: TaskRow[], allowance: number): MapView['totals'] {
  const sum = (f: (r: TaskRow) => number) => rows.reduce((n, r) => n + f(r), 0)
  return {
    done: rows.filter((r) => r.state === 'done').length,
    total: rows.length,
    tokensIn: sum((r) => r.tokens.value?.in ?? 0),
    tokensOut: sum((r) => r.tokens.value?.out ?? 0),
    escalations: sum((r) => r.escalations),
    reviewsUsed: sum((r) => r.reviews.used),
    reviewsAllowance: rows.length * allowance
  }
}

const EMPTY_TOTALS: MapView['totals'] = {
  done: 0, total: 0, tokensIn: 0, tokensOut: 0, escalations: 0, reviewsUsed: 0, reviewsAllowance: 0
}

function baseView(status: MapView['status']): MapView {
  return { status, repo: null, candidates: [], plans: [], plan: null, rows: [], totals: EMPTY_TOTALS, notes: [] }
}

export function fold(ledger: LedgerShow, live: Live, planFallback: PlanRow[] | null): MapView {
  const repo = ledger.repo
  if (!repo || repo.build_map !== true) return baseView('off')
  const current = ledger.plans[0] ?? null
  if (!current && (!planFallback || planFallback.length === 0)) {
    return { ...baseView('no-plan'), repo: { name: repoName(repo.repo_root), host: repo.this_host } }
  }
  const byNumber = new Map<number, LedgerTask>((current?.tasks ?? []).map((t) => [t.task, t]))
  const planByNumber = new Map<number, PlanRow>((planFallback ?? []).map((p) => [p.task, p]))
  for (const p of planFallback ?? []) if (!byNumber.has(p.task)) byNumber.set(p.task, emptyTask(p.task, p.title))
  const allowance = repo.review_cycles
  const rows = [...byNumber.values()]
    .sort((a, b) => a.task - b.task)
    .map((t) => buildRow(t, planByNumber.get(t.task), live, allowance))
  const notes: string[] = []
  if (ledger.skipped_lines > 0) notes.push(`${ledger.skipped_lines} unreadable log line(s) skipped`)
  return {
    status: 'ok',
    repo: { name: repoName(repo.repo_root), host: repo.this_host },
    candidates: [],
    plans: ledger.plans.map((p) => ({ plan: p.plan, lastTs: p.last_ts })),
    plan: current?.plan ?? null,
    rows,
    totals: totalsOf(rows, allowance),
    notes
  }
}

function repoName(root: string): string {
  return root.replace(/\/+$/, '').split('/').pop() || root
}

// --- plan file -----------------------------------------------------------------------------

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

const clean = (s: string | undefined): string | null => {
  const v = (s ?? '').replace(/\*\*|`/g, '').trim()
  return v === '' || v === '—' || v === '-' ? null : v
}

const DEPENDENCY = /(?:depends on|after|needs|blocked by|waiting on)\s+(?:tasks?\s+)?#?(\d+(?:\s*(?:,|and|&)\s*#?\d+)*)/i

function dependenciesOf(text: string): number[] {
  const m = DEPENDENCY.exec(text)
  return m ? (m[1].match(/\d+/g) ?? []).map(Number) : []
}

export function parsePlanTable(markdown: string): PlanRow[] {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('|') && splitRow(l).some((c) => /^task$/i.test(c)))
  if (start < 0) return []
  const head = splitRow(lines[start]).map((c) => c.toLowerCase())
  const col = (name: string) => head.indexOf(name)
  const rows: PlanRow[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.includes('|')) break
    const cells = splitRow(line)
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
    const m = /^(\d+)\.\s*(.+)$/.exec(clean(cells[col('task')]) ?? '')
    if (!m) continue
    const rung = clean(cells[col('rung')])
    rows.push({
      task: Number(m[1]),
      title: m[2].replace(/\s*\((?:depends on|after|needs|blocked by|waiting on)[^)]*\)\s*$/i, '').trim(),
      tier: clean(cells[col('tier')]),
      rung: rung !== null && /^\d+$/.test(rung) ? Number(rung) : null,
      mode: clean(cells[col('mode')]),
      vendor: clean(cells[col('vendor')]),
      model: clean(cells[col('model')]),
      dependsOn: dependenciesOf(line)
    })
  }
  return rows
}
