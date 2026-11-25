// The crew64 map's worker: gathers the ledger, Orca and GitHub facts through a Source, folds them
// with fold() and answers the panel (`view`, `selectPlan`, `selectRepo`). It only reads: choosing
// what to view changes nothing but what is stored here. A save restarts the worker and drops its
// memory, so the choices live in orca.storage.
import { watch as fsWatch } from 'node:fs'
import { basename, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { fold, parsePlanTable } from './fold'
import { resolveFocus, type Workspace } from './focus'
import type { LedgerShow, Live, MapView } from './protocol'
import { LocalSource, realConfig, type Source } from './sources'

const SNAPSHOT_MS = 60_000
const LEASE_MS = 90_000
const DEFAULT_DEBOUNCE_MS = 150
const PLANS_DIR = 'docs/superpowers/plans'
const REPO_KEY = 'repoId'
const PLAN_KEY = 'plan'

export type Watcher = { close(): void }
export type WatchFn = (dir: string, onChange: () => void) => Watcher
export type Deps = {
  source: Source
  watch: WatchFn
  debounceMs?: number
  /** Periodic refresh while the panel is open; 0 turns it off. */
  intervalMs?: number
}

const realWatch: WatchFn = (dir, onChange) => {
  const w = fsWatch(dir, () => onChange())
  w.on('error', () => {})
  return w
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function emptyView(status: MapView['status'], notes: string[], extra: Partial<MapView> = {}): MapView {
  return {
    status, repo: null, candidates: [], plans: [], plan: null, rows: [],
    totals: { done: 0, total: 0, tokensIn: 0, tokensOut: 0, escalations: 0, reviewsUsed: 0, reviewsAllowance: 0 },
    notes, ...extra
  }
}

type Active = { stop(): void }
let active: Active | null = null

export async function deactivate(): Promise<void> {
  active?.stop()
  active = null
}

export default function activate(orca: OrcaWorkerApi): void {
  const settings = async () => {
    const all = await orca.settings.get()
    return { orcaCli: text(all.orcaCli), crew64Root: text(all.crew64Root) }
  }
  activateWith(orca, { source: new LocalSource(realConfig(settings)), watch: realWatch })
}

type AgentState = { state: 'working' | 'blocked' | 'waiting'; workspaceId: string; at: number }

export function activateWith(orca: OrcaWorkerApi, deps: Deps): void {
  const { source } = deps
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const interval = deps.intervalMs ?? SNAPSHOT_MS
  const rootCache = new Map<string, string | null>()
  // Agent status by the terminal identity the event carried (terminalId and paneKey).
  const agentStates = new Map<string, AgentState>()
  let snapshot: { key: string; at: number; live: Live } | null = null
  let leaseAt = 0
  let lapseTimer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let watchKey = ''
  let watchers: Watcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let dirty = false
  let stopped = false
  let chain: Promise<unknown> = Promise.resolve()

  const isOpen = () => Date.now() - leaseAt < LEASE_MS
  /** One build at a time, whether a request or a refresh asked for it. */
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn, fn)
    chain = result.catch(() => undefined)
    return result
  }
  const rootOf = async (path: string): Promise<string | null> => {
    if (!rootCache.has(path)) rootCache.set(path, await source.repoRoot(path))
    return rootCache.get(path) ?? null
  }

  type Chosen = { root: string; workspaces: Workspace[] } | { view: MapView }

  async function chooseRepo(): Promise<Chosen> {
    const listed = (await orca.host.call('workspace.list')).workspaces
    const workspaces = listed.filter((w) => w.hostId === null || w.hostId === 'local')
    const ctx = (await orca.host.call('workspace.readContext')) as
      | { branch: string; displayName: string; workspaceId?: string }
      | null
    const focus = resolveFocus(ctx, workspaces)
    const pick = async (w: Workspace): Promise<Chosen> => {
      const root = await rootOf(w.path)
      return root ? { root, workspaces } : { view: emptyView('error', [`${w.name} is not in a git repository`]) }
    }
    if (focus.kind === 'one') return pick(focus.workspace)
    if (focus.kind === 'none') {
      const note = !ctx
        ? 'No workspace is focused.'
        : ctx.workspaceId
          ? "The focused workspace is not in Orca's workspace list."
          : 'The focused workspace matches no listed workspace.'
      return { view: emptyView('error', [note]) }
    }
    const stored = text(await orca.storage.get(REPO_KEY))
    const chosen = stored ? focus.candidates.find((w) => w.id === stored) : undefined
    if (chosen) return pick(chosen)
    const roots = new Map<string, Workspace>()
    for (const c of focus.candidates) {
      const root = await rootOf(c.path)
      if (root && !roots.has(root)) roots.set(root, c)
    }
    // Only an exact branch-and-name match may be taken for granted; anything less is the picker's.
    if (focus.exact && roots.size === 1) return { root: [...roots.keys()][0], workspaces }
    const candidates = [...roots].map(([root, w]) => ({ id: w.id, name: basename(root) }))
    return { view: emptyView('ambiguous', [], { candidates }) }
  }

  const hasId = (ids: string[] | undefined, key: string) => ids?.includes(key) === true

  /** Forgets agent states whose terminal a fresh snapshot no longer lists. */
  function pruneStates(live: Live, workspaces: Workspace[]): void {
    const paths = new Set(live.worktrees.map((w) => w.path))
    for (const [key, entry] of agentStates) {
      const w = workspaces.find((x) => x.id === entry.workspaceId)
      if (!w || !paths.has(w.path)) continue
      if (!live.terminals.some((t) => t.worktreePath === w.path && hasId(t.ids, key))) agentStates.delete(key)
    }
  }

  async function liveFor(root: string, ledger: LedgerShow, workspaces: Workspace[], force: boolean): Promise<Live> {
    const tasks = ledger.plans[0]?.tasks ?? []
    const paths = tasks.flatMap((t) => (t.worktree ? [t.worktree] : []))
    const branches = tasks.flatMap((t) => (t.branch && t.tokens_in === null && t.tokens_out === null ? [{ task: t.task, branch: t.branch }] : []))
    // What the snapshot is about: this repository, this plan and its task paths and branches.
    const key = JSON.stringify([root, ledger.plans[0]?.plan ?? null, paths, branches])
    if (force || !snapshot || snapshot.key !== key || Date.now() - snapshot.at >= SNAPSHOT_MS) {
      const live = await source.live(root, paths, branches)
      snapshot = { key, at: Date.now(), live }
      pruneStates(live, workspaces)
    }
    const live = snapshot.live
    // Live agent events fill in between snapshots, joined to a listed terminal by identity.
    const terminals = live.terminals.flatMap((t) => {
      const w = workspaces.find((x) => x.path === t.worktreePath)
      const matches = [...agentStates].filter(([k, e]) => w !== undefined && e.workspaceId === w.id && hasId(t.ids, k)).map(([, e]) => e)
      const latest = matches.sort((x, y) => y.at - x.at)[0]
      if (t.agent === false && !latest) return []
      return [latest && t.status !== 'gone' ? { ...t, status: latest.state } : t]
    })
    return { ...live, terminals }
  }

  async function build(force: boolean): Promise<MapView> {
    const chosen = await chooseRepo()
    if ('view' in chosen) return chosen.view
    const { root, workspaces } = chosen
    const ledger = await source.ledger(root)
    if (!ledger) return emptyView('error', source.notes())
    const wanted = text(await orca.storage.get(PLAN_KEY))
    const index = ledger.plans.findIndex((p) => p.plan === wanted)
    const plans = index > 0 ? [ledger.plans[index], ...ledger.plans.filter((_, i) => i !== index)] : ledger.plans
    const ordered = { ...ledger, plans }
    const markdown = await source.planFile(root, plans[0]?.plan)
    const rows = markdown === null ? null : parsePlanTable(markdown)
    const live = await liveFor(root, ordered, workspaces, force)
    const view = fold(ordered, live, rows)
    await watchFor(root)
    return { ...view, notes: [...new Set([...view.notes, ...source.notes()])] }
  }

  async function watchFor(root: string): Promise<void> {
    const dirs = [await source.logDir(root), join(root, PLANS_DIR)].filter((d): d is string => d !== null)
    const key = dirs.join('\n')
    if (key === watchKey || stopped || !isOpen()) return
    watchKey = key
    for (const w of watchers) w.close()
    watchers = []
    for (const dir of dirs) {
      try {
        watchers.push(deps.watch(dir, schedule))
      } catch {
        // A directory that does not exist yet is picked up by the next snapshot cycle.
        watchKey = ''
      }
    }
  }

  async function refresh(force = false): Promise<void> {
    if (running) {
      dirty = true
      return running
    }
    running = (async () => {
      try {
        do {
          dirty = false
          orca.panels.post('view', await exclusive(() => build(force)))
        } while (dirty && !stopped && isOpen())
      } catch (error) {
        orca.log(`refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    await running
    running = null
  }

  function schedule(): void {
    if (stopped || timer !== null || !isOpen()) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, debounceMs)
  }

  function lapse(): void {
    // No lease left: no timers, no polling; watchers are reopened by the next refresh.
    if (poll !== null) clearInterval(poll)
    poll = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const w of watchers) w.close()
    watchers = []
    watchKey = ''
  }

  function renewLease(): void {
    const wasOpen = isOpen()
    leaseAt = Date.now()
    if (lapseTimer !== null) clearTimeout(lapseTimer)
    lapseTimer = setTimeout(lapse, LEASE_MS)
    ;(lapseTimer as unknown as { unref?: () => void }).unref?.()
    if (wasOpen) return
    if (interval > 0 && poll === null) {
      poll = setInterval(() => { snapshot = null; schedule() }, interval)
      ;(poll as unknown as { unref?: () => void }).unref?.()
    }
    void refresh(true)
  }

  orca.panels.handle('view.lease', async () => {
    renewLease()
    return { ok: true as const }
  })
  const answer = () => exclusive(() => build(!isOpen()))
  orca.panels.handle('view', answer)
  orca.panels.handle('selectPlan', async ({ plan }) => {
    await orca.storage.set(PLAN_KEY, plan)
    return answer()
  })
  orca.panels.handle('selectRepo', async ({ id }) => {
    await orca.storage.set(REPO_KEY, id)
    return answer()
  })
  for (const event of ['workspace.changed', 'workspace.created', 'workspace.removed'] as const) {
    orca.events.on(event, () => {
      snapshot = null
      rootCache.clear()
      schedule()
    })
  }
  orca.events.on('agent.status.changed', (e) => {
    if (e.workspaceId === null) return
    const entry: AgentState = { state: e.state === 'done' ? 'waiting' : e.state, workspaceId: e.workspaceId, at: e.receivedAt }
    for (const key of [e.terminalId, e.paneKey]) if (key) agentStates.set(key, entry)
    schedule()
  })

  active = {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (lapseTimer !== null) clearTimeout(lapseTimer)
      if (poll !== null) clearInterval(poll)
      for (const w of watchers) w.close()
      watchers = []
    }
  }
}
