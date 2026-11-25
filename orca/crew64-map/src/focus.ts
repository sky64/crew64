// Which workspace is focused: match the focused context against workspace.list.
export type Workspace = { id: string; path: string; branch: string | null; hostId: string | null; name: string }
export type FocusContext = { branch: string; displayName: string; workspaceId?: string | null }
export type Focus =
  | { kind: 'one'; workspace: Workspace }
  | { kind: 'ambiguous'; candidates: Workspace[] }
  | { kind: 'none' }

const bare = (branch: string | null): string => (branch ?? '').replace(/^refs\/heads\//, '')

function outcome(matches: Workspace[]): Focus {
  if (matches.length === 1) return { kind: 'one', workspace: matches[0] }
  return matches.length > 1 ? { kind: 'ambiguous', candidates: matches } : { kind: 'none' }
}

/**
 * An id the host reports (Orca 1.4.259+) wins when it names a listed workspace; otherwise branch
 * and display name must both match, then branch alone when no name matches.
 */
export function resolveFocus(ctx: FocusContext | null, workspaces: Workspace[]): Focus {
  if (!ctx) return { kind: 'none' }
  if (ctx.workspaceId) {
    const byId = workspaces.find((w) => w.id === ctx.workspaceId)
    if (byId) return { kind: 'one', workspace: byId }
  }
  const sameBranch = workspaces.filter((w) => bare(w.branch) === bare(ctx.branch))
  const exact = sameBranch.filter((w) => w.name === ctx.displayName)
  return outcome(exact.length > 0 ? exact : sameBranch)
}
