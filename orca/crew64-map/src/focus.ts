// Which workspace is focused: match the focused context against workspace.list.
export type Workspace = { id: string; path: string; branch: string | null; hostId: string | null; name: string }
export type FocusContext = { branch: string; displayName: string; workspaceId?: string | null }
export type Focus =
  | { kind: 'one'; workspace: Workspace }
  /** `exact`: every candidate matched branch and display name (a repository picker among equals). */
  | { kind: 'ambiguous'; candidates: Workspace[]; exact: boolean }
  | { kind: 'none' }

const bare = (branch: string | null): string => (branch ?? '').replace(/^refs\/heads\//, '')

/**
 * An id the host reports (Orca 1.4.259+) is authoritative: it names a listed workspace or the
 * answer is `none`; it never falls back to another workspace. Without an id, branch and display
 * name must both match to select; a branch-only match is offered as a picker, never selected.
 */
export function resolveFocus(ctx: FocusContext | null, workspaces: Workspace[]): Focus {
  if (!ctx) return { kind: 'none' }
  if (ctx.workspaceId) {
    const byId = workspaces.find((w) => w.id === ctx.workspaceId)
    return byId ? { kind: 'one', workspace: byId } : { kind: 'none' }
  }
  const sameBranch = workspaces.filter((w) => bare(w.branch) === bare(ctx.branch))
  const exact = sameBranch.filter((w) => w.name === ctx.displayName)
  if (exact.length === 1) return { kind: 'one', workspace: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact, exact: true }
  return sameBranch.length > 0 ? { kind: 'ambiguous', candidates: sameBranch, exact: false } : { kind: 'none' }
}
