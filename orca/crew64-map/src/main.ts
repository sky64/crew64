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
const OPEN_WINDOW_MS = 5 * 60_000
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

export function activateWith(orca: OrcaWorkerApi, deps: Deps): void {
  const { source } = deps
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const rootCache = new Map<string, string | null>()
  const agentStates = new Map<string, 'working' | 'blocked' | 'waiting'>()
  let snapshot: { root: string; at: number; live: Live } | null = null
  let lastViewAt = 0
  let watchKey = ''
  let watchers: Watcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let dirty = false
  let stopped = false

  const isOpen = () => Date.now() - lastViewAt < OPEN_WINDOW_MS
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
    const stored = text(await orca.storage.get(REPO_KEY))
    const pick = async (w: Workspace): Promise<Chosen> => {
      const root = await rootOf(w.path)
      return root ? { root, workspaces } : { view: emptyView('error', [`${w.name} is not in a git repository`]) }
    }
    if (focus.kind === 'one') return pick(focus.workspace)
    const pool = focus.kind === 'ambiguous' ? focus.candidates : workspaces
    const chosen = stored ? pool.find((w) => w.id === stored) : undefined
    if (chosen) return pick(chosen)
    if (focus.kind === 'none') return { view: emptyView('error', ['No workspace is focused.']) }
    const roots = new Map<string, Workspace>()
    for (const c of focus.candidates) {
      const root = await rootOf(c.path)
      if (root && !roots.has(root)) roots.set(root, c)
    }
    if (roots.size === 1) return { root: [...roots.keys()][0], workspaces }
    const candidates = [...roots].map(([root, w]) => ({ id: w.id, name: basename(root) }))
    return { view: emptyView('ambiguous', [], { candidates }) }
  }

  async function liveFor(root: string, ledger: LedgerShow, workspaces: Workspace[], force: boolean): Promise<Live> {
    const tasks = ledger.plans[0]?.tasks ?? []
    const paths = tasks.flatMap((t) => (t.worktree ? [t.worktree] : []))
    const branches = tasks.flatMap((t) => (t.branch && t.tokens_in === null && t.tokens_out === null ? [{ task: t.task, branch: t.branch }] : []))
    const fresh = snapshot && snapshot.root === root && Date.now() - snapshot.at < SNAPSHOT_MS
    if (!fresh || force) snapshot = { root, at: Date.now(), live: await source.live(root, paths, branches) }
    const live = snapshot!.live
    // Live agent events fill in between snapshots.
    const terminals = live.terminals.map((t) => {
      const w = workspaces.find((x) => x.path === t.worktreePath)
      const state = w ? agentStates.get(w.id) : undefined
      return state && t.status !== 'gone' ? { ...t, status: state } : t
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
    if (key === watchKey || stopped) return
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
          orca.panels.post('view', await build(force))
        } while (dirty && !stopped)
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

  function onWorkspaceEvent(): void {
    snapshot = null
    rootCache.clear()
    schedule()
  }

  // A panel that has not asked for a view lately is closed: nothing polls for it.
  const opened = (): boolean => {
    const wasClosed = !isOpen()
    lastViewAt = Date.now()
    return wasClosed
  }

  async function answer(): Promise<MapView> {
    return build(opened())
  }

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
    orca.events.on(event, onWorkspaceEvent)
  }
  orca.events.on('agent.status.changed', (e) => {
    if (e.workspaceId === null) return
    agentStates.set(e.workspaceId, e.state === 'done' ? 'waiting' : e.state)
    schedule()
  })

  const interval = deps.intervalMs ?? SNAPSHOT_MS
  const poll = interval > 0 ? setInterval(() => { snapshot = null; schedule() }, interval) : null
  ;(poll as unknown as { unref?: () => void } | null)?.unref?.()
  active = {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (poll !== null) clearInterval(poll)
      for (const w of watchers) w.close()
      watchers = []
    }
  }
}
