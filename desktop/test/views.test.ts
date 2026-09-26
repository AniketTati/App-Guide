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
    expect(blindSpots(gaps).map((b) => b.short)).toEqual(['82 Python files', '3 hand-written queries'])
  })
})

describe('the product’s counts', () => {
  it('counts routes with no check found, and each kind of data once', () => {
    const facts: Fact[] = [
      route('GET', '/health', []), route('GET', '/x', ['requireUser']),
      { kind: 'write', table: 'contract', module: 'a', where: where('a.ts') },
      { kind: 'read', table: 'contract', module: 'b', where: where('b.ts') },
    ]
    expect(productCounts(facts)).toMatchObject({ routes: 2, noCheck: 1, tables: 1 })
  })
})
