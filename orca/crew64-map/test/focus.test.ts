import { assert, test } from 'orca/testing'
import { resolveFocus } from '../src/focus'

const ws = (id: string, path: string, branch: string | null, name: string) => ({
  id, path, branch, hostId: 'local', name
})

test('singleMatchResolves', () => {
  const list = [ws('a', '/r/a', 'refs/heads/feat', 'feat'), ws('b', '/r/b', 'main', 'main')]
  const r = resolveFocus({ branch: 'feat', displayName: 'feat' }, list)
  assert.equal(r.kind, 'one')
  assert.equal(r.kind === 'one' && r.workspace.id, 'a')
})

test('ambiguousFocusOffersPicker', () => {
  const list = [ws('a', '/r1', 'main', 'main'), ws('b', '/r2', 'main', 'main'), ws('c', '/r3', 'x', 'x')]
  const r = resolveFocus({ branch: 'main', displayName: 'main' }, list)
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(r.kind === 'ambiguous' && r.candidates.map((c) => c.id), ['a', 'b'])
})

test('focusByWorkspaceId', () => {
  const list = [ws('a', '/r1', 'main', 'main'), ws('b', '/r2', 'main', 'main')]
  const r = resolveFocus({ branch: 'main', displayName: 'main', workspaceId: 'b' }, list)
  assert.equal(r.kind === 'one' && r.workspace.id, 'b')
})

test('unlistedWorkspaceIdNeverFallsBackToAnotherWorkspace', () => {
  const r = resolveFocus({ workspaceId: 'missing-A', branch: 'main', displayName: 'repo-A' }, [ws('B', '/B', 'main', 'repo-B')])
  assert.equal(r.kind, 'none')
  // Even a perfect branch and name match is not used when the host named a different id.
  assert.equal(resolveFocus({ workspaceId: 'zz', branch: 'main', displayName: 'main' }, [ws('a', '/r1', 'main', 'main')]).kind, 'none')
})

test('branchOnlyMatchIsAPickerNotASelection', () => {
  const r = resolveFocus({ branch: 'main', displayName: 'repo-A' }, [ws('B', '/B', 'main', 'repo-B')])
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(r.kind === 'ambiguous' && r.candidates.map((c) => c.id), ['B'])
})

test('noContextOrNoMatchIsNone', () => {
  assert.equal(resolveFocus(null, []).kind, 'none')
  assert.equal(resolveFocus({ branch: 'q', displayName: 'q' }, [ws('a', '/r', 'main', 'main')]).kind, 'none')
})
