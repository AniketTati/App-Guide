import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/model/facts.js'
import type { Product } from '../../src/graph/product.js'
import { productView } from '../src/core/product.js'

const route = (method: string, path: string, middleware: string[]): Extract<Fact, { kind: 'route' }> =>
  ({ kind: 'route', method, path, middleware, framework: 'fastify', where: { file: 'apps/api/src/r.ts', line: 1 } })

function product(): Product {
  const list = route('GET', '/api/v1/contracts', ["requirePermission('view', 'contract')"])
  const open = route('POST', '/api/v1/telemetry', [])
  const hook = route('POST', '/api/internal/hook', ['inline preHandler'])
  return {
    facts: [list, open, hook],
    screens: [
      { path: '/contracts', component: 'ContractsPage', file: 'a.tsx', where: { file: 'apps/web/src/App.tsx', line: 3 }, signIn: 'required', section: 'Workspace', label: 'Contracts', app: 'web' },
      { path: '/contracts/:id', component: 'ContractDetailPage', file: 'b.tsx', where: { file: 'apps/web/src/App.tsx', line: 4 }, signIn: 'required', section: 'Workspace', label: null, app: 'web' },
      { path: '/login', component: 'LoginPage', file: 'c.tsx', where: { file: 'apps/web/src/App.tsx', line: 2 }, signIn: 'none', section: null, label: null, app: 'web' },
    ],
    links: new Map([
      ['/contracts', [{ route: list, call: { method: 'GET', path: '/api/v1/contracts', file: 'a.tsx', line: 1, via: null } }]],
      ['/contracts/:id', [{ route: open, call: { method: 'POST', path: '/api/v1/telemetry', file: 'b.tsx', line: 1, via: null } }]],
    ]),
    layout: [],
    unmatched: [],
    sections: [{ label: 'Workspace', items: [{ to: '/contracts', label: 'Contracts' }] }],
    data: new Map([[list, [{ table: 'contract', kind: 'read', file: 'r.ts', line: 2, via: null }]]]),
    roles: [{ name: 'ROLES', file: 'p.ts', line: 1, keyedByEnum: true, roles: [
      { role: 'ADMIN', grants: [{ action: '*', resource: '*', scope: 'org' }] },
      { role: 'SALES', grants: [{ action: 'view', resource: 'contract', scope: 'own' }] },
    ] }],
  }
}

describe('the Product view', () => {
  const view = productView(product(), 'origin/main')

  it('groups screens by the sidebar, then those it does not list, then those with no sign-in', () => {
    expect(view.groups.map((g) => [g.label, g.screens.map((s) => s.name)])).toEqual([
      ['Workspace', ['Contracts', 'Contract detail']],
      ['No sign-in', ['Login']],
    ])
  })

  it('says who may call each route, and what data it touches', () => {
    const r = view.groups[0]!.screens[0]!.routes[0]!
    expect(r.who).toEqual([{ role: 'ADMIN', scope: 'org' }, { role: 'SALES', scope: 'own' }])
    expect(r.data).toEqual([{ table: 'contract', kind: 'read', via: null }])
  })

  it('lists routes no screen calls behind the scenes', () => {
    expect(view.behind.map((r) => r.path)).toEqual(['/api/internal/hook'])
  })

  it('shows a grant on everything in every row, not just its own', () => {
    const t = view.roles!.tables[0]!
    expect(t.rows.find((row) => row.resource === 'contract')?.cells['ADMIN']).toEqual([{ actions: ['*'], scope: 'org' }])
    expect(view.roles!.routes['view contract']).toEqual([{ method: 'GET', path: '/api/v1/contracts' }])
  })
})
