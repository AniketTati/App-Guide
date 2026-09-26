import { describe, expect, it } from 'vitest'
import type { CheckView, Note, ProductView, RouteRow } from '../src/shared/api.js'
import { buildMap } from '../src/renderer/map/layout.js'
import { notesBrief } from '../src/renderer/map/brief.js'

const route = (method: string, path: string, data: RouteRow['data'], who: RouteRow['who'] = null): RouteRow =>
  ({ method, path, checks: ["requirePermission('view', 'contract')"], noCheck: false, who, data, where: 'apps/api/src/r.ts:1' })

const VIEW: ProductView = {
  base: 'origin/main',
  groups: [
    { label: 'Workspace', screens: [
      { goesTo: ['/contracts/:id'], path: '/contracts', file: 'apps/web/src/pages/ContractsPage.tsx', name: 'Contracts', component: 'ContractsPage', signIn: 'required', app: 'web', where: 'apps/web/src/App.tsx:3',
        routes: [route('GET', '/api/v1/contracts', [{ table: 'contract', kind: 'read', via: null }], [{ role: 'ADMIN', scope: 'org' }, { role: 'SALES', scope: 'own' }])] },
      { goesTo: [], path: '/contracts/:id', file: 'apps/web/src/pages/ContractPage.tsx', name: 'Contract detail', component: 'ContractPage', signIn: 'required', app: 'web', where: 'apps/web/src/App.tsx:4',
        routes: [route('PATCH', '/api/v1/contracts/:id', [{ table: 'contract', kind: 'write', via: null }], [{ role: 'ADMIN', scope: 'org' }])] },
    ] },
  ],
  behind: [route('POST', '/api/v1/webhooks/stripe', [{ table: 'invoice', kind: 'write', via: null }])],
  layout: [],
  shared: [],
  unmatched: [{ method: 'GET', path: '/api/v1/approvals', where: 'apps/web/src/pages/ContractPage.tsx:9', screen: '/contracts/:id', via: null }],
  roles: { tables: [{ name: 'ROLES', where: 'p.ts:1', roles: ['ADMIN', 'SALES'], rows: [] }], routes: {} },
  background: { queues: [{ name: 'agents', declared: 'q.ts:1', jobs: [{ name: 'review', addedAt: ['r.ts:3'] }], workers: ['w.ts:1'], repeats: 0 }], timers: [], sockets: [] },
  readAt: '2026-09-27T00:00:00Z',
}

describe('the product as a map', () => {
  const map = buildMap(VIEW)
  const card = (id: string) => map.cards.find((c) => c.id === id)!

  it('draws each screen in its section, each kind of data, and what no screen shows', () => {
    expect(map.frames.map((f) => f.label)).toEqual(['Workspace', 'Data', 'Behind the scenes'])
    expect(map.cards.filter((c) => c.kind === 'screen').map((c) => c.label)).toEqual(['Contracts', 'Contract detail'])
    expect(map.cards.filter((c) => c.kind === 'table').map((c) => c.label)).toEqual(['contract', 'invoice'])
    expect(map.cards.filter((c) => c.frame === 'frame:behind').map((c) => c.label)).toEqual(['webhooks', 'agents queue'])
  })

  it('knows where each screen leads and what it changes or only reads', () => {
    expect(map.links).toEqual(expect.arrayContaining([
      { from: 'screen:/contracts', to: 'screen:/contracts/:id', kind: 'goes' },
      { from: 'screen:/contracts/:id', to: 'table:contract', kind: 'writes' },
      { from: 'screen:/contracts', to: 'table:contract', kind: 'reads' },
      { from: 'group:behind:webhooks', to: 'table:invoice', kind: 'writes' },
    ]))
  })

  it('marks what needs the PM — a call to something that isn’t there', () => {
    expect(card('screen:/contracts/:id').needs).toBe('calls something that isn’t there')
    expect(card('screen:/contracts').needs).toBeNull()
  })

  it('never puts two cards in the same place', () => {
    const spots = map.cards.map((c) => `${c.x},${c.y}`)
    expect(new Set(spots).size).toBe(spots.length)
  })

  it('shades the map for one role', () => {
    const as = buildMap(VIEW, { as: 'SALES' })
    expect(as.cards.find((c) => c.id === 'screen:/contracts')?.access).toBe('all')
    expect(as.cards.find((c) => c.id === 'screen:/contracts/:id')).toMatchObject({ access: 'none', accessNote: 'SALES can’t use it' })
  })

  it('in a Check, marks what the work changes on the map', () => {
    const check = {
      changes: { route: [{ type: 'changed', kind: 'route', title: 'PATCH /api/v1/contracts/:id', detail: '', where: '' }], data: [], service: [], package: [], code: [] },
      touched: [], screens: { changed: [{ name: 'Contracts', path: '/contracts', how: 'uses', app: 'web' }], added: [], removed: [{ name: 'Old', path: '/old' }] },
      schema: { tables: { added: ['Invoice'], removed: [], changed: [] }, lists: { added: [], removed: [], changed: [] }, migrations: [], settings: false },
      roleChanges: [{ role: 'SALES', resource: 'contract', before: 'view', after: 'edit, view' }],
    } as unknown as CheckView
    const m = buildMap(VIEW, { check })
    expect(m.cards.find((c) => c.id === 'screen:/contracts')?.change).toBe('touched')
    expect(m.cards.find((c) => c.id === 'screen:/contracts/:id')).toMatchObject({ change: 'changed', changeNote: '1 of its actions changed' })
    expect(m.cards.find((c) => c.id === 'screen:/old')).toMatchObject({ change: 'gone', frame: 'frame:Screens it removes' })
    expect(m.cards.find((c) => c.id === 'table:invoice')?.change).toBe('new')
    expect(m.cards.find((c) => c.id === 'role:SALES')).toMatchObject({ change: 'changed' })
  })
})

describe('notes, sent to Claude', () => {
  const note = (over: Partial<Note>): Note => ({ id: 'n1', on: 'main', target: { kind: 'screen', key: '/contracts', label: 'Contracts' }, text: 'Filter by counterparty.', at: '', sentAt: null, ...over })

  it('on main: each note with where it is, added to the tracker as a task first', () => {
    const text = notesBrief([note({}), note({ id: 'n2', target: { kind: 'table', key: 'contract', label: 'contract' }, text: 'Keep who changed it.' })],
      { product: 'acme', base: 'origin/main', view: VIEW, check: null, date: '2026-09-27' })
    expect(text).toContain("Here is what I'd like changed in acme, noted on App Guide's map of the product as it is on main:")
    expect(text).toContain('1. The Contracts screen (/contracts, apps/web/src/pages/ContractsPage.tsx) — it can do 1 thing.')
    expect(text).toContain('   > Filter by counterparty.')
    expect(text).toContain('2. The contract data — changed from Contract detail.')
    expect(text).toMatch(/Add each note to FIX_TRACKER\.md as its own task first — under a section headed "## Asked for in App Guide \(2026-09-27\)"/)
  })

  it('on a piece of work: changes to it, made where the work is', () => {
    const check = { work: { label: 'Let finance approve', branch: 'feat/finance' }, screens: { changed: [{ path: '/contracts', how: 'page' }], added: [], removed: [] }, schema: { tables: { added: [] } }, roleChanges: [] } as unknown as CheckView
    const text = notesBrief([note({ on: 'w1' })], { product: 'acme', base: 'origin/main', view: VIEW, check, date: '2026-09-27' })
    expect(text.split('\n')[0]).toBe('I checked "Let finance approve" (feat/finance) in App Guide, on a map of acme as this work leaves it. My notes, each on the part of the product it\'s about:')
    expect(text).toContain('This work changed its page.')
    expect(text).toContain('Make these changes on feat/finance, where the work already is.')
  })
})
