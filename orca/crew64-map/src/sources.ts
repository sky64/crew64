// Where the worker reads from: the crew64 ledger, git, `gh` and the `orca` CLI, all on the host
// the worker runs on (decision 0010: transport same-host, so there is no RemoteSource).
// Security: every subprocess is execFile with an argument array (never a shell string) and a 10 s
// timeout. Paths come only from workspace.list, Orca's own listings or the ledger, and the cwd of a
// call is one of them; nothing from the log is spliced into a command line unvalidated; tokens are
// never read or logged.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { LedgerShow, Live } from './protocol'

const TIMEOUT_MS = 10_000
const MAX_BUFFER = 8 * 1024 * 1024
const GH_INTERVAL_MS = 60_000
const PLANS_DIR = 'docs/superpowers/plans'

export type ExecFn = (cmd: string, args: string[], opts: { cwd?: string }) => Promise<string>
export type FsLike = {
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  realpath(path: string): Promise<string>
  isSymlink(path: string): Promise<boolean>
}
export type SourceSettings = { orcaCli?: string; crew64Root?: string }

export interface Source {
  ledger(repoRoot: string): Promise<LedgerShow | null>
  /** `branches` lets the source read `Tokens:` commit trailers for tasks the log has no tokens for. */
  live(repoRoot: string, taskPaths: string[], branches?: { task: number; branch: string }[]): Promise<Live>
  /** The plan's Markdown: the repo-relative `plan` when given, else the newest plan file. */
  planFile(repoRoot: string, plan?: string): Promise<string | null>
  /** The main checkout of the repository a workspace path belongs to. */
  repoRoot(workspacePath: string): Promise<string | null>
  /** The repository's log directory, for the file watch. */
  logDir(repoRoot: string): Promise<string | null>
  /** Why something is unavailable, each reason once. */
  notes(): string[]
}

/** The real execFile: argument array, no shell, 10 s timeout. */
export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((done, fail) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
      (error, stdout) => (error ? fail(error) : done(stdout)))
  })

export const realFs: FsLike = {
  readdir,
  readFile: (p) => readFile(p, 'utf8'),
  exists: (p) => stat(p).then(() => true, () => false),
  realpath,
  isSymlink: (p) => lstat(p).then((s) => s.isSymbolicLink())
}

export type LocalSourceConfig = {
  exec: ExecFn
  fs: FsLike
  home: string
  env: Record<string, string | undefined>
  now: () => number
  settings: () => Promise<SourceSettings>
}

export function realConfig(settings: () => Promise<SourceSettings>): LocalSourceConfig {
  const env = process.env
  return { exec: realExec, fs: realFs, home: env.HOME || homedir(), env, now: () => Date.now(), settings }
}

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Letters, digits and `._/-`, not starting with `-`: safe as a git revision argument. */
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const asList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(asRecord) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

type PrCache = { at: number; prs: Live['prs'] }

export class LocalSource implements Source {
  private readonly noteSet = new Set<string>()
  private readonly prCache = new Map<string, PrCache>()
  private readonly prInflight = new Map<string, Promise<Live['prs']>>()
  private readonly baseCache = new Map<string, string>()

  constructor(private readonly cfg: LocalSourceConfig) {}

  notes(): string[] {
    return [...this.noteSet]
  }

  private note(text: string): void {
    this.noteSet.add(text)
  }

  async ledger(repoRoot: string): Promise<LedgerShow | null> {
    const script = await this.ledgerScript()
    if (script === null) return null
    try {
      const out = await this.cfg.exec('python3', ['-I', script, 'show', '--json'], { cwd: repoRoot })
      return JSON.parse(out) as LedgerShow
    } catch {
      this.note('the crew64 ledger could not be read (crew64_ledger.py show failed)')
      return null
    }
  }

  async logDir(repoRoot: string): Promise<string | null> {
    const script = await this.ledgerScript()
    if (script === null) return null
    try {
      const dir = (await this.cfg.exec('python3', ['-I', script, 'path'], { cwd: repoRoot })).trim()
      return dir !== '' && isAbsolute(dir) ? dir : null
    } catch {
      return null
    }
  }

  async repoRoot(workspacePath: string): Promise<string | null> {
    try {
      const out = (await this.cfg.exec('git', ['rev-parse', '--git-common-dir'], { cwd: workspacePath })).trim()
      const common = isAbsolute(out) ? out : resolve(workspacePath, out)
      return basename(common) === '.git' ? dirname(common) : null
    } catch {
      return null
    }
  }

  /**
   * Reads a plan only through real files: no symlink component below the repository, and the real
   * path of the file inside the real path of the plans directory, inside the real repository.
   */
  async planFile(repoRoot: string, plan?: string): Promise<string | null> {
    const dir = join(repoRoot, PLANS_DIR)
    try {
      if (!(await this.plainPath(repoRoot, PLANS_DIR.split('/')))) return null
      let names: string[]
      if (plan !== undefined) {
        const target = resolve(repoRoot, plan)
        if (!target.startsWith(resolve(dir) + '/') || !target.endsWith('.md')) return null
        names = [target.slice(resolve(dir).length + 1)]
      } else {
        names = (await this.cfg.fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse()
      }
      for (const name of names) {
        const text = await this.readPlan(repoRoot, dir, name)
        if (text !== null) return text
      }
      return null
    } catch {
      return null
    }
  }

  /** True when every component of `parts` below `base` exists as a real directory or file, not a symlink. */
  private async plainPath(base: string, parts: string[]): Promise<boolean> {
    let at = base
    for (const part of parts) {
      at = join(at, part)
      if (await this.cfg.fs.isSymlink(at)) return false
    }
    return true
  }

  private async readPlan(repoRoot: string, dir: string, name: string): Promise<string | null> {
    if (!(await this.plainPath(dir, name.split('/')))) return null
    const file = join(dir, name)
    const [realRepo, realDir, realFile] = await Promise.all([
      this.cfg.fs.realpath(repoRoot), this.cfg.fs.realpath(dir), this.cfg.fs.realpath(file)
    ])
    const inside = realDir.startsWith(realRepo + '/') && realFile.startsWith(realDir + '/')
    return inside ? this.cfg.fs.readFile(file) : null
  }

  async live(repoRoot: string, taskPaths: string[], branches: { task: number; branch: string }[] = []): Promise<Live> {
    const live: Live = { worktrees: [], terminals: [], needsInput: [], prs: null }
    await this.readOrca(repoRoot, taskPaths, live)
    live.prs = await this.pullRequests(repoRoot)
    const trailers = await this.trailerTokens(repoRoot, branches)
    if (Object.keys(trailers).length > 0) live.trailerTokens = trailers
    return live
  }

  // --- crew64 tools ---------------------------------------------------------------------

  private async ledgerScript(): Promise<string | null> {
    const root = await this.crew64Root()
    const script = root === null ? null : join(root, 'tools', 'crew64_ledger.py')
    if (script !== null && (await this.cfg.fs.exists(script))) return script
    this.note('crew64 tools not found: set the crew64 folder in the plugin settings or CREW64_ROOT')
    return null
  }

  private async crew64Root(): Promise<string | null> {
    const setting = str((await this.cfg.settings()).crew64Root)
    if (setting !== null) return setting
    const env = str(this.cfg.env.CREW64_ROOT)
    if (env !== null) return env
    const base = join(this.cfg.home, '.claude', 'plugins', 'cache', 'crew64', 'crew64')
    try {
      const versions = (await this.cfg.fs.readdir(base)).sort(compareVersions)
      const highest = versions.pop()
      return highest === undefined ? null : join(base, highest)
    } catch {
      return null
    }
  }

  // --- Orca CLI -------------------------------------------------------------------------

  private async orcaCli(): Promise<string | null> {
    const setting = str((await this.cfg.settings()).orcaCli)
    const config = str(this.cfg.env.XDG_CONFIG_HOME) ?? join(this.cfg.home, '.config')
    const path = setting ?? join(config, 'orca', 'linux-orca-cli-shim', 'orca')
    if (await this.cfg.fs.exists(path)) return path
    this.note('the orca CLI was not found, so live terminal state is unknown: set its path in the plugin settings')
    return null
  }

  private async orcaJson(cli: string, args: string[], key: string): Promise<Record<string, unknown>[] | null> {
    try {
      const out = JSON.parse(await this.cfg.exec(cli, [...args, '--json'], {})) as unknown
      return asList(asRecord(asRecord(out).result)[key])
    } catch {
      this.note(`the orca CLI call "${args.slice(0, 2).join(' ')}" failed`)
      return null
    }
  }

  private async readOrca(repoRoot: string, taskPaths: string[], live: Live): Promise<void> {
    const cli = await this.orcaCli()
    if (cli === null) return
    const all = await this.orcaJson(cli, ['worktree', 'list'], 'worktrees')
    if (all === null) return
    const repoId = str(all.find((w) => w.path === repoRoot)?.repoId)
    const own = all.filter((w) => (repoId !== null ? w.repoId === repoId : taskPaths.includes(String(w.path))) || w.path === repoRoot)
    const paths = new Set(own.map((w) => String(w.path)))
    live.worktrees = own.map((w) => ({ path: String(w.path), branch: String(w.branch ?? '').replace(/^refs\/heads\//, '') }))
    // Supervised workers: the only source that tells an agent from a plain shell, and the join
    // for escalations (their messages carry dispatch and task ids, not terminal handles).
    const workers = await this.orcaJson(cli, ['orchestration', 'worker-list', '--limit', '100'], 'workers')
    const liveWorkers = (workers ?? []).filter((w) => w.liveness === 'live')
    const workerPath = (w: Record<string, unknown>): string | null => {
      const workspace = str(w.workspace)
      const at = workspace?.indexOf('::') ?? -1
      return workspace !== null && at >= 0 ? workspace.slice(at + 2) : null
    }
    const agentPaths = new Set(liveWorkers.flatMap((w) => workerPath(w) ?? []))
    const terminals = await this.orcaJson(cli, ['terminal', 'list'], 'terminals')
    if (terminals === null) return
    live.terminals = terminals
      .filter((t) => paths.has(String(t.worktreePath)))
      .map((t) => {
        const ids = [str(t.handle), str(t.ptyId), t.tabId && t.leafId ? `${String(t.tabId)}:${String(t.leafId)}` : null, str(t.leafId)]
        return {
          worktreePath: String(t.worktreePath),
          status: t.connected === false || t.orphaned === true ? ('gone' as const) : ('waiting' as const),
          ids: ids.filter((i): i is string => i !== null),
          agent: agentPaths.has(String(t.worktreePath))
        }
      })
    if (workers === null) {
      this.note('escalations are not mapped: the orca worker listing is unavailable')
      return
    }
    const inbox = await this.orcaJson(cli, ['orchestration', 'inbox', '--limit', '100'], 'messages')
    if (inbox === null) return
    const found = new Set<string>()
    for (const m of inbox.filter((x) => x.type === 'escalation' && x.handled === false)) {
      const payload = asRecord(m.payload)
      const dispatch = str(payload.dispatchId)
      const taskId = str(payload.taskId)
      const worker = liveWorkers.find((w) => (dispatch !== null && w.dispatchId === dispatch) || (dispatch === null && taskId !== null && w.taskId === taskId))
      const path = worker ? workerPath(worker) : null
      if (path !== null && paths.has(path)) found.add(path)
      else if (path === null) this.note('an escalation could not be mapped to a worktree and is not shown')
    }
    live.needsInput = [...found]
  }

  // --- GitHub ---------------------------------------------------------------------------

  private pullRequests(repoRoot: string): Promise<Live['prs']> {
    const pending = this.prInflight.get(repoRoot)
    if (pending) return pending
    const cached = this.prCache.get(repoRoot)
    if (cached && this.cfg.now() - cached.at < GH_INTERVAL_MS) return Promise.resolve(cached.prs)
    // The slot is taken before gh runs, so a second caller shares this fetch instead of starting one.
    const started = this.cfg.now()
    const fetch = this.fetchPullRequests(repoRoot).then((prs) => {
      this.prCache.set(repoRoot, { at: started, prs })
      return prs
    }).finally(() => this.prInflight.delete(repoRoot))
    this.prInflight.set(repoRoot, fetch)
    return fetch
  }

  private async fetchPullRequests(repoRoot: string): Promise<Live['prs']> {
    try {
      const out = await this.cfg.exec('gh', ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,state,url', '--limit', '200'], { cwd: repoRoot })
      return asList(JSON.parse(out)).flatMap((p) => {
        const state = String(p.state).toLowerCase()
        const url = str(p.url)
        const head = str(p.headRefName)
        if (typeof p.number !== 'number' || url === null || head === null) return []
        return state === 'open' || state === 'merged' || state === 'closed' ? [{ number: p.number, headRefName: head, state, url }] : []
      })
    } catch (error) {
      const missing = (error as { code?: unknown }).code === 'ENOENT'
      this.note(missing ? 'GitHub pull request state is unavailable: the gh CLI is not installed' : 'GitHub pull request state is unavailable: gh failed (is it signed in?)')
      return null
    }
  }

  // --- commit trailers ------------------------------------------------------------------

  private async baseRef(repoRoot: string): Promise<string> {
    const known = this.baseCache.get(repoRoot)
    if (known !== undefined) return known
    let base = 'main'
    try {
      const out = (await this.cfg.exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot })).trim()
      if (SAFE_REF.test(out)) base = out
    } catch {
      // No origin/HEAD: the repository's `main`.
    }
    this.baseCache.set(repoRoot, base)
    return base
  }

  private async trailerTokens(repoRoot: string, branches: { task: number; branch: string }[]): Promise<Record<number, { in: number; out: number }>> {
    const found: Record<number, { in: number; out: number }> = {}
    const safe = branches.filter((b) => SAFE_REF.test(b.branch) && !b.branch.includes('..'))
    if (safe.length === 0) return found
    const base = await this.baseRef(repoRoot)
    for (const b of safe) {
      try {
        const out = await this.cfg.exec('git', ['log', '--format=%(trailers:key=Tokens,valueonly)', `${base}..${b.branch}`], { cwd: repoRoot })
        let sum = { in: 0, out: 0 }
        let seen = false
        for (const line of out.split('\n')) {
          const m = /^(?:Tokens:\s*)?(\d+)\/(\d+)$/.exec(line.trim())
          if (!m) continue
          seen = true
          sum = { in: sum.in + Number(m[1]), out: sum.out + Number(m[2]) }
        }
        if (seen) found[b.task] = sum
      } catch {
        // The branch is gone or unreadable: no inferred tokens for it.
      }
    }
    return found
  }
}
