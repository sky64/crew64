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
  const logged = t.pr !== null && t.pr_url ? { number: t.pr, url: t.pr_url } : null
  // GitHub unavailable: keep the logged link, but its state is unknown and drives nothing.
  if (live.prs === null) return logged ? { value: { ...logged, state: 'unknown' }, inferred: false } : null
  const prs = live.prs
  const byNumber = t.pr === null ? undefined : prs.find((p) => p.number === t.pr)
  if (byNumber) return { value: { number: byNumber.number, url: byNumber.url, state: byNumber.state }, inferred: false }
  const byBranch = branch ? prs.find((p) => p.headRefName === branch) : undefined
  // A log that names a different PR number is not overridden by a branch guess.
  if (byBranch && (t.pr === null || t.pr === byBranch.number)) {
    return { value: { number: byBranch.number, url: byBranch.url, state: byBranch.state }, inferred: t.pr === null }
  }
  return logged ? { value: { ...logged, state: 'unknown' }, inferred: false } : null
}

/** `alive`: a terminal that is neither working nor blocked; `dead`: none listed, or all gone. */
function terminalState(path: string | null, live: Live): 'blocked' | 'working' | 'alive' | 'dead' {
  if (!path) return 'dead'
  if (live.needsInput.includes(path)) return 'blocked'
  const own = live.terminals.filter((x) => x.worktreePath === path)
  if (own.some((x) => x.status === 'blocked')) return 'blocked'
  if (own.some((x) => x.status === 'working')) return 'working'
  return own.some((x) => x.status !== 'gone') ? 'alive' : 'dead'
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
    return { state: exists && terminal === 'alive' ? 'working' : 'unknown', inferred: false }
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
  const tokens: Cell<{ in: number | null; out: number | null }> =
    t.tokens_in !== null || t.tokens_out !== null
      ? cell({ in: t.tokens_in, out: t.tokens_out })
      : trailer
        ? cell(trailer, true)
        : cell(null)
  // The model is a fact only when a dispatched/native_started event named it (model_source 'launch');
  // a planned model, a plan-row model, or a ledger without model_source is inferred (Codex task 4, cycle 2).
  const intended = t.model ?? plan?.model ?? null
  const model: Cell<string> =
    t.model_source === 'launch' && t.model !== null ? cell(t.model) : intended !== null ? cell(intended, true) : cell(null)
  return {
    task: t.task,
    title: t.title ?? plan?.title ?? `Task ${t.task}`,
    state,
    stateInferred: inferred,
    waitingOn: state === 'waiting' ? (plan?.dependsOn ?? []) : [],
    tier: pick(t.tier, plan?.tier),
    rung: pick(t.rung, plan?.rung),
    mode: pick(t.mode, plan?.mode),
    model,
    reviews: { used: t.reviews, allowance },
    escalations: t.escalations,
    tokens,
    worktreePath: path,
    branch,
    pr: pr?.value ?? null,
    prUnknown: live.prs === null || pr?.value.state === 'unknown'
  }
}

function totalsOf(rows: TaskRow[], allowance: number): MapView['totals'] {
  const sum = (f: (r: TaskRow) => number) => rows.reduce((n, r) => n + f(r), 0)
  return {
    done: rows.filter((r) => r.state === 'done').length,
    total: rows.length,
    tokensIn: sum((r) => r.tokens.value?.in ?? 0), // known counts only
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

const DEFAULT_REVIEW_CYCLES = 2 // the shipped default of limits.review_cycles

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const count = (v: unknown): number => num(v) ?? 0

function normalizeTask(raw: unknown): LedgerTask | null {
  if (!isObj(raw) || !Number.isInteger(raw.task)) return null
  return {
    task: raw.task as number, title: str(raw.title), tier: str(raw.tier), rung: num(raw.rung), mode: str(raw.mode),
    model: str(raw.model),
    model_source: raw.model_source === 'launch' || raw.model_source === 'planned' ? raw.model_source : null,
    worktree: str(raw.worktree), branch: str(raw.branch), dispatch: str(raw.dispatch),
    reviews: count(raw.reviews), escalations: count(raw.escalations), tokens_in: num(raw.tokens_in),
    tokens_out: num(raw.tokens_out), pr: num(raw.pr), pr_url: str(raw.pr_url), merged: raw.merged === true,
    abandoned: raw.abandoned === true, last_event: str(raw.last_event) ?? 'planned', last_ts: str(raw.last_ts) ?? ''
  }
}

/** Shape-valid JSON in, a complete LedgerShow out: missing arrays are empty, counts 0, tokens unknown. */
function normalizeLedger(raw: unknown): LedgerShow {
  const src = isObj(raw) ? raw : {}
  const r = isObj(src.repo) ? src.repo : null
  const plans = (Array.isArray(src.plans) ? src.plans : []).flatMap((p: unknown) => {
    if (!isObj(p) || typeof p.plan !== 'string') return []
    const tasks = (Array.isArray(p.tasks) ? p.tasks : []).flatMap((t: unknown) => normalizeTask(t) ?? [])
    return [{ plan: p.plan, last_ts: str(p.last_ts) ?? '', tasks }]
  })
  return {
    repo: r && {
      v: count(r.v), build_map: r.build_map === true, review_cycles: num(r.review_cycles) ?? DEFAULT_REVIEW_CYCLES,
      this_host: str(r.this_host), repo_root: str(r.repo_root) ?? '', github: str(r.github),
      ledger_version: str(r.ledger_version) ?? ''
    },
    plans,
    skipped_lines: count(src.skipped_lines)
  }
}

export function fold(rawLedger: LedgerShow, rawLive: Live, planFallback: PlanRow[] | null): MapView {
  const ledger = normalizeLedger(rawLedger)
  const live: Live = {
    ...rawLive,
    worktrees: rawLive?.worktrees ?? [], terminals: rawLive?.terminals ?? [],
    needsInput: rawLive?.needsInput ?? [], prs: rawLive?.prs ?? null
  }
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
  const partial = rows.filter((r) => r.tokens.value && (r.tokens.value.in === null || r.tokens.value.out === null))
  if (partial.length > 0) notes.push(`token totals leave out unknown counts for ${partial.length} task(s)`)
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
  return root.replace(/\/+$/, '').split('/').pop() || 'repository'
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
