import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/model/facts.js'
import type { Change } from '../../src/model/report.js'
import { blindSpots, changeView, groupChanges, productCounts } from '../src/core/views.js'

const where = (file: string, line = 1) => ({ file, line })
const route = (method: string, path: string, middleware: string[] | 'unresolved'): Fact =>
  ({ kind: 'route', method, path, middleware, framework: 'fastify', where: where('apps/api/src/routes/x.ts', 10) })

describe('changes, in the PM’s words', () => {
  it('shows a route by its address, with its checks as written, or none found', () => {
    expect(changeView({ type: 'added', fact: route('DELETE', '/api/v1/contracts/:id', []) })).toMatchObject({
      kind: 'route', title: 'DELETE /api/v1/contracts/:id', detail: 'no check found before it runs', checks: [],
    })
    expect(changeView({ type: 'added', fact: route('GET', '/api/v1/contracts', ["requirePermission('view', 'contract')"]) })?.checks)
      .toEqual(["requirePermission('view', 'contract')"])
  })

  it('puts routes with no check found first', () => {
    const changes: Change[] = [
      { type: 'added', fact: route('GET', '/a', ['requireUser']) },
      { type: 'added', fact: route('POST', '/b', []) },
    ]
    expect(groupChanges(changes).route.map((r) => r.title)).toEqual(['POST /b', 'GET /a'])
  })

  it('says a version moved, not just that a package changed', () => {
    const lib = (version: string): Fact => ({ kind: 'library', name: 'fastify', version, direct: true, importers: ['a.ts'], where: where('apps/api/package.json') })
    expect(changeView({ type: 'changed', fact: lib('^5.1.0'), previous: lib('^5.0.0') })?.detail).toBe('^5.0.0 → ^5.1.0')
  })
})

describe('the status bar', () => {
  it('says what it cannot read in a few words, counting each kind once', () => {
    const gaps: Fact[] = [
      { kind: 'gap', reason: 'unsupported-language', subject: 'Python', detail: '82 Python files not read — routes, data and calls in them are not listed', where: where('apps/agents/main.py') },
      ...Array.from({ length: 3 }, (_, i): Fact => ({ kind: 'gap', reason: 'raw-sql', subject: `a.ts:${i}`, detail: 'hand-written SQL', where: where('a.ts', i) })),
    ]
    // Where they are is part of the name: the PM knows apps/agents as the AI service.
    expect(blindSpots(gaps).map((b) => b.short)).toEqual(['82 Python files, in apps/agents', '3 hand-written queries'])
  })
})

describe('the product’s counts', () => {
  it('counts routes with no check found, and each kind of data once', () => {
    const facts: Fact[] = [
      route('GET', '/health', []), route('GET', '/x', ['requireUser']),
      { kind: 'write', table: 'contract', module: 'a', where: where('a.ts') },
      { kind: 'read', table: 'contract', module: 'b', where: where('b.ts') },
    ]
    expect(productCounts(facts)).toMatchObject({ routes: 2, noCheck: 1, noCheckUnreviewed: 1, tables: 1 })
    // One the PM says is meant to be open no longer asks for attention.
    expect(productCounts(facts, ['GET /health'])).toMatchObject({ noCheck: 1, noCheckUnreviewed: 0 })
  })
})

describe('who may call a route in a Check', () => {
  it('reads the role table the way Product does, wildcards and scopes included', async () => {
    const { whoFrom } = await import('../src/core/views.js')
    const roles = {
      tables: [{ name: 'ROLES', where: 'p.ts:1', roles: ['ADMIN', 'SALES', 'VIEWER'], rows: [
        { resource: '*', cells: { ADMIN: [{ actions: ['*'], scope: 'org' }], SALES: [], VIEWER: [] } },
        { resource: 'contract', cells: { ADMIN: [{ actions: ['*'], scope: 'org' }], SALES: [{ actions: ['view', 'edit'], scope: 'own' }], VIEWER: [{ actions: ['view'], scope: 'org' }] } },
      ] }],
      routes: {},
    }
    expect(whoFrom(["requirePermission('edit', 'contract')", 'ownScopeGuard(x)'], roles)).toEqual([{ role: 'ADMIN', scope: 'org' }, { role: 'SALES', scope: 'own' }])
    expect(whoFrom(['requireUser'], roles)).toBeNull()
  })
})

describe('what a Check says first', () => {
  it('never gives an all-clear over what it could not read', async () => {
    const { sentenceOf } = await import('../src/core/views.js')
    const empty = { route: [], data: [], service: [], package: [], code: [] }
    const base = {
      changes: empty, touched: [], roleChanges: [], screens: { changed: [], added: [], removed: [] },
      schema: { tables: { added: [], removed: [], changed: [] }, lists: { added: [], removed: [], changed: [] }, migrations: [], settings: false },
      unmatched: { added: [], fixed: [] }, unseen: [],
    }
    expect(sentenceOf(base as never)).toMatch(/^No new routes, checks, data, packages or services\./)
    expect(sentenceOf({ ...base, unseen: [{ label: 'Python', files: ['a.py', 'b.py'] }] } as never)).toBe(
      'Nothing changed in the parts I can read — but it changes Python (2 files), which I can’t read. Ask Claude what those changes do before you merge.')
    expect(sentenceOf({ ...base, roleChanges: [{ role: 'FINANCE', resource: 'renewal', before: 'view', after: 'approve, view' }],
      schema: { ...base.schema, tables: { added: ['FieldRun', 'FieldSuggestion'], removed: [], changed: [] } } } as never)).toBe('It changes what 1 role may do and adds 2 tables.')
    // A route that was there before but does something else now is a change.
    expect(sentenceOf({ ...base, touched: [{}, {}], screens: { changed: [{ how: 'page' }], added: [], removed: [] } } as never)).toBe('It changes the code behind 2 existing routes and changes 1 screen.')
    // Every list the page shows has words: none of these is "nothing".
    const lone = [
      { changes: { ...empty, data: [{ title: 'invoice' }] } },
      { schema: { ...base.schema, migrations: ['add invoices'] } },
      { schema: { ...base.schema, lists: { added: [], removed: [], changed: ['Role'] } } },
      { schema: { ...base.schema, settings: true } },
      { screens: { changed: [], added: [], removed: [{ name: 'Old', path: '/old' }] } },
      { screens: { changed: [{ how: 'uses' }], added: [], removed: [] } },
      { changes: { ...empty, package: [{ title: 'zod', type: 'changed' }] } },
    ]
    for (const over of lone) expect(sentenceOf({ ...base, ...over } as never), JSON.stringify(over)).toMatch(/^It /)
  })

  it('reads a change to the role table as what each role may now do', async () => {
    const { roleChanges } = await import('../src/core/views.js')
    const table = (finance: { actions: string[]; scope: string | null }[]) => ({ tables: [{ name: 'ROLES', where: 'p.ts:1', roles: ['ADMIN', 'FINANCE'], rows: [
      { resource: 'renewal', cells: { ADMIN: [{ actions: ['*'], scope: 'org' }], FINANCE: finance } },
    ] }], routes: {} })
    expect(roleChanges(table([{ actions: ['view'], scope: 'org' }]), table([{ actions: ['view', 'approve'], scope: 'org' }]))).toEqual([
      { role: 'FINANCE', resource: 'renewal', before: 'view', after: 'approve, view' },
    ])
    expect(roleChanges(table([]), table([{ actions: ['view'], scope: 'own' }]))).toEqual([{ role: 'FINANCE', resource: 'renewal', before: 'nothing', after: 'view (own only)' }])
    // The same grants written in another order are not a change.
    expect(roleChanges(table([{ actions: ['view', 'approve'], scope: 'org' }]), table([{ actions: ['approve', 'view'], scope: 'org' }]))).toEqual([])
  })
})

describe('work in flight', () => {
  const work = (over: Partial<import('../../src/check/work.js').Work>): import('../../src/check/work.js').Work => ({
    id: '/w', branch: 'fix/x', path: '/w', primary: false, head: 'h1', mergeBase: 'm', ahead: 1, uncommitted: [], tasks: ['EE1'], edited: [], plan: null,
    changed: ['a.ts'], lastCommit: new Date().toISOString(), fingerprint: 'f1', lastEdit: null, oldestEdit: null, ...over,
  })
  const tasks = new Map([['EE1', { id: 'EE1', title: 'Every action is a decision', status: 'DONE' } as never]])

  it('is ready for you when it is committed, every task is done, and you have not checked it', async () => {
    const { workView } = await import('../src/core/views.js')
    expect(workView(work({}), [], tasks, undefined).ready).toBe(true)
    expect(workView(work({ uncommitted: ['b.ts'] }), [], tasks, undefined).ready).toBe(false)
    expect(workView(work({}), [], tasks, { at: 'x', head: 'h1', dirty: 0, fingerprint: 'f1' }).ready).toBe(false)
  })

  it('knows it moved when an uncommitted file changed, not just when the count did', async () => {
    const { workView } = await import('../src/core/views.js')
    const checked = { at: 'x', head: 'h1', dirty: 1, fingerprint: 'f1' }
    expect(workView(work({ uncommitted: ['b.ts'], fingerprint: 'f1' }), [], tasks, checked).movedSinceCheck).toBe(false)
    expect(workView(work({ uncommitted: ['b.ts'], fingerprint: 'f2' }), [], tasks, checked).movedSinceCheck).toBe(true)
  })

  it('is named by its plan before its first commit, and set apart when weeks old', async () => {
    const { workView } = await import('../src/core/views.js')
    expect(workView(work({ tasks: [], plan: { file: 'docs/39-X.md', title: 'Capture, fix and trust contract data', done: 3, total: 9 } }), [], tasks, undefined).label).toBe('Capture, fix and trust contract data')
    expect(workView(work({ path: null, lastCommit: '2026-07-01T00:00:00Z' }), [], tasks, undefined, Date.parse('2026-09-26T00:00:00Z'))).toMatchObject({ stale: true, where: 'branch', ready: false })
  })
})
