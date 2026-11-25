// Where the worker reads from: the crew64 ledger, git, `gh` and the `orca` CLI, all on the host
// the worker runs on (decision 0010: transport same-host, so there is no RemoteSource).
// Security: every subprocess is execFile with an argument array (never a shell string) and a 10 s
// timeout. Paths come only from workspace.list, Orca's own listings or the ledger, and the cwd of a
// call is one of them; nothing from the log is spliced into a command line unvalidated; tokens are
// never read or logged.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
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
  exists: (p) => stat(p).then(() => true, () => false)
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

  async planFile(repoRoot: string, plan?: string): Promise<string | null> {
    try {
      if (plan !== undefined) {
        const target = resolve(repoRoot, plan)
        const inside = target.startsWith(resolve(repoRoot, PLANS_DIR) + '/') && target.endsWith('.md')
        return inside ? await this.cfg.fs.readFile(target) : null
      }
      const dir = join(repoRoot, PLANS_DIR)
      const newest = (await this.cfg.fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort().pop()
      return newest === undefined ? null : await this.cfg.fs.readFile(join(dir, newest))
    } catch {
      return null
    }
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
    const terminals = await this.orcaJson(cli, ['terminal', 'list'], 'terminals')
    if (terminals === null) return
    const mine = terminals.filter((t) => paths.has(String(t.worktreePath)))
    live.terminals = mine.map((t) => ({
      worktreePath: String(t.worktreePath),
      status: t.connected === false || t.orphaned === true ? 'gone' : 'waiting'
    }))
    const inbox = await this.orcaJson(cli, ['orchestration', 'inbox', '--limit', '100'], 'messages')
    if (inbox === null) return
    const byHandle = new Map(mine.map((t) => [String(t.handle), String(t.worktreePath)]))
    const waiting = inbox.filter((m) => m.type === 'escalation' && m.handled === false)
    const where = waiting.map((m) => byHandle.get(String(m.from)) ?? byHandle.get(String(asRecord(m.payload).terminal)))
    live.needsInput = [...new Set(where.filter((p): p is string => p !== undefined))]
  }

  // --- GitHub ---------------------------------------------------------------------------

  private async pullRequests(repoRoot: string): Promise<Live['prs']> {
    const cached = this.prCache.get(repoRoot)
    if (cached && this.cfg.now() - cached.at < GH_INTERVAL_MS) return cached.prs
    let prs: Live['prs'] = null
    try {
      const out = await this.cfg.exec('gh', ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,state,url', '--limit', '200'], { cwd: repoRoot })
      prs = asList(JSON.parse(out)).flatMap((p) => {
        const state = String(p.state).toLowerCase()
        const url = str(p.url)
        const head = str(p.headRefName)
        if (typeof p.number !== 'number' || url === null || head === null) return []
        return state === 'open' || state === 'merged' || state === 'closed' ? [{ number: p.number, headRefName: head, state, url }] : []
      })
    } catch (error) {
      const missing = (error as { code?: unknown }).code === 'ENOENT'
      this.note(missing ? 'GitHub pull request state is unavailable: the gh CLI is not installed' : 'GitHub pull request state is unavailable: gh failed (is it signed in?)')
    }
    this.prCache.set(repoRoot, { at: this.cfg.now(), prs })
    return prs
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
