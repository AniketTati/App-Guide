import type { CheckView, Note, NoteTarget, ProductView, RouteRow, ScreenRow } from '../../shared/api.js'

/**
 * The product as a map: frames for the sidebar's sections and the parts of
 * the product no screen shows, cards inside them, and — for whatever is
 * picked — the lines to what it leads to, uses and changes. Placement is
 * worked out here, the same every time for the same product, so a card is
 * where the PM left it. Nothing here draws.
 */
export interface Frame { id: string; label: string; note?: string | undefined; x: number; y: number; w: number; h: number }

/** New, changed by the work itself, only running code it changed, or gone. */
export type Change = 'new' | 'changed' | 'touched' | 'gone'

export interface Card {
  id: string
  kind: NoteTarget
  /** What notes about it are keyed by: a screen's path, a table's name. */
  key: string
  label: string
  sub: string
  x: number
  y: number
  w: number
  h: number
  frame: string
  /** Counts in plain words: "66 actions", "changed by 4 screens". */
  facts: string[]
  /** Something here needs the PM: a call that reaches nothing, an open route. */
  needs: string | null
  /** In a Check: what this work does to it, and in a word how. */
  change: Change | null
  changeNote: string | null
  /** Viewing as one role: may they use it all, some of it, or none. */
  access: 'all' | 'some' | 'none' | null
  accessNote: string | null
  notes: number
}

export interface Link { from: string; to: string; kind: 'writes' | 'reads' | 'goes' | 'uses' | 'calls' }

export interface ProductMap { frames: Frame[]; cards: Card[]; links: Link[] }

const SCREEN = { w: 208, h: 76 }
const SMALL = { w: 196, h: 52 }
const GAP = 12
const PAD = { x: 16, top: 44, bottom: 16 }
const REGION_W = 1560

const keyOf = (r: { method: string; path: string }): string => `${r.method} ${r.path}`

export function buildMap(view: ProductView, opts: { check?: CheckView | null; as?: string | null; notes?: readonly Note[] } = {}): ProductMap {
  const frames: Frame[] = []
  const cards: Card[] = []
  const links: Link[] = []
  const check = opts.check ?? null
  const noteCount = new Map<string, number>()
  for (const n of opts.notes ?? []) noteCount.set(`${n.target.kind}:${n.target.key}`, (noteCount.get(`${n.target.kind}:${n.target.key}`) ?? 0) + 1)

  // What a Check says about each thing on the map.
  const changedRoutes = new Set([...(check?.changes.route ?? []), ...(check?.touched ?? [])].filter((r) => r.type !== 'removed').map((r) => r.title))
  const screenChange = new Map<string, { change: Change; note: string }>()
  for (const s of check?.screens.added ?? []) screenChange.set(s.path, { change: 'new', note: 'new screen' })
  // Its own page changed: changed. Only code it shares with others changed:
  // touched — worth trying, quieter on the map.
  for (const s of check?.screens.changed ?? []) screenChange.set(s.path, s.how === 'page' ? { change: 'changed', note: 'its page changed' } : { change: 'touched', note: 'code it runs changed' })
  const tableChange = new Map<string, Change>()
  for (const t of check?.schema.tables.added ?? []) tableChange.set(lower(t), 'new')
  for (const t of check?.schema.tables.changed ?? []) tableChange.set(lower(t), 'changed')
  for (const d of check?.changes.data ?? []) if (!tableChange.has(lower(d.title))) tableChange.set(lower(d.title), 'changed')

  const publicOk = new Set(view.publicOk ?? [])
  const roles = view.roles?.tables[0]?.roles ?? []

  // ── Screens, by the sidebar's sections ─────────────────────────────────
  const placeFrame = (id: string, label: string, note: string | undefined, items: { w: number; h: number }[], cols: number): { frame: Frame; at: (i: number) => { x: number; y: number } } => {
    const w = PAD.x * 2 + cols * items[0]!.w + (cols - 1) * GAP
    const rows = Math.ceil(items.length / cols)
    const h = PAD.top + rows * items[0]!.h + (rows - 1) * GAP + PAD.bottom
    const frame: Frame = { id, label, note, x: 0, y: 0, w, h }
    return { frame, at: (i) => ({ x: PAD.x + (i % cols) * (items[0]!.w + GAP), y: PAD.top + Math.floor(i / cols) * (items[0]!.h + GAP) }) }
  }

  const screenGroups = view.groups
  const pending: { frame: Frame; place: () => void }[] = []
  const removed = (check?.screens.removed ?? []).map(ghost)
  const sections = removed.length === 0 ? screenGroups : [...screenGroups, { label: 'Screens it removes', note: 'Gone once this work merges.', screens: removed }]
  for (const g of sections) {
    const list = [...g.screens]
    if (list.length === 0) continue
    const cols = list.length <= 2 ? list.length : list.length <= 6 ? 2 : 3
    const { frame, at } = placeFrame(`frame:${g.label}`, g.label, g.note, list.map(() => SCREEN), cols)
    pending.push({ frame, place: () => list.forEach((s, i) => {
      const p = at(i)
      const refused = opts.as == null ? 0 : s.routes.filter((r) => r.who !== null && !r.who.some((w) => w.role === opts.as)).length
      const known = s.routes.filter((r) => r.who !== null).length
      const open = s.routes.filter((r) => r.noCheck && !publicOk.has(keyOf(r))).length
      const missing = view.unmatched.filter((u) => u.screen === s.path).length
      const changed = s.routes.filter((r) => changedRoutes.has(keyOf(r))).length
      const sc = screenChange.get(s.path) ?? (removed.includes(s) ? { change: 'gone' as const, note: 'removed by this work' } : undefined)
      cards.push({
        id: `screen:${s.path}`, kind: 'screen', key: s.path, label: s.name, sub: s.path,
        x: frame.x + p.x, y: frame.y + p.y, w: SCREEN.w, h: SCREEN.h, frame: frame.id,
        facts: [s.routes.length === 0 ? 'no actions of its own' : `${s.routes.length} action${s.routes.length === 1 ? '' : 's'}`, ...(changed > 0 ? [`${changed} changed`] : [])],
        needs: missing > 0 ? 'calls something that isn’t there' : open > 0 ? `${open} open to anyone` : null,
        change: changed > 0 && (sc === undefined || sc.change === 'touched') ? 'changed' : sc?.change ?? null,
        changeNote: [sc?.note, changed > 0 ? `${changed} of its actions changed` : null].filter(Boolean).join(' · ') || null,
        access: opts.as == null || known === 0 ? null : refused === 0 ? 'all' : refused === known ? 'none' : 'some',
        accessNote: opts.as == null || known === 0 ? null : refused === 0 ? `${opts.as} can do all of it` : refused === known ? `${opts.as} can’t use it` : `${refused} of ${known} not allowed`,
        notes: noteCount.get(`screen:${s.path}`) ?? 0,
      })
    }) })
  }

  // ── Around the screens: shared parts and the layout ────────────────────
  if (view.shared.length > 0) {
    const { frame, at } = placeFrame('frame:shared', 'Parts many screens share', 'A dialog or an editor used on three screens or more.', view.shared.map(() => SCREEN), Math.min(3, view.shared.length))
    pending.push({ frame, place: () => view.shared.forEach((part, i) => {
      const p = at(i)
      const changed = part.routes.filter((r) => changedRoutes.has(keyOf(r))).length
      cards.push({
        id: `part:${part.file}`, kind: 'part', key: part.file, label: part.name, sub: `on ${part.screens.length} screens`,
        x: frame.x + p.x, y: frame.y + p.y, w: SCREEN.w, h: SCREEN.h, frame: frame.id,
        facts: [`${part.routes.length} action${part.routes.length === 1 ? '' : 's'}`], needs: null,
        change: changed > 0 ? 'changed' : null, changeNote: changed > 0 ? `${changed} of its actions changed` : null,
        access: null, accessNote: null, notes: noteCount.get(`part:${part.file}`) ?? 0,
      })
    }) })
  }
  if (view.layout.length > 0) {
    const { frame, at } = placeFrame('frame:layout', 'Around every signed-in screen', 'The layout, onboarding and the assistant.', [SCREEN], 1)
    pending.push({ frame, place: () => {
      const p = at(0)
      const changed = view.layout.filter((r) => changedRoutes.has(keyOf(r))).length
      cards.push({
        id: 'group:layout', kind: 'group', key: 'layout', label: 'Layout and assistant', sub: 'around every signed-in screen',
        x: frame.x + p.x, y: frame.y + p.y, w: SCREEN.w, h: SCREEN.h, frame: frame.id,
        facts: [`${view.layout.length} actions`], needs: null,
        change: changed > 0 ? 'changed' : null, changeNote: changed > 0 ? `${changed} of its actions changed` : null,
        access: null, accessNote: null, notes: noteCount.get('group:layout') ?? 0,
      })
    } })
  }

  // Shelf-pack the left region: frames left to right, a new row when full.
  let x = 0
  let y = 0
  let rowH = 0
  for (const f of pending) {
    if (x > 0 && x + f.frame.w > REGION_W) { x = 0; y += rowH + 32; rowH = 0 }
    f.frame.x = x
    f.frame.y = y
    x += f.frame.w + 32
    rowH = Math.max(rowH, f.frame.h)
    frames.push(f.frame)
    f.place()
  }
  const right = Math.max(REGION_W, ...frames.map((f) => f.x + f.w)) + 72

  // ── Data: every table a route reads or changes ─────────────────────────
  const tables = new Map<string, { writes: Set<string>; reads: Set<string> }>()
  const touch = (table: string, kind: 'write' | 'read', from: string): void => {
    const t = tables.get(table) ?? { writes: new Set(), reads: new Set() }
    ;(kind === 'write' ? t.writes : t.reads).add(from)
    tables.set(table, t)
  }
  for (const g of view.groups) for (const s of g.screens) for (const r of s.routes) for (const d of r.data) touch(d.table, d.kind, `screen:${s.path}`)
  for (const part of view.shared) for (const r of part.routes) for (const d of r.data) touch(d.table, d.kind, `part:${part.file}`)
  for (const r of view.layout) for (const d of r.data) touch(d.table, d.kind, 'group:layout')
  const behindGroups = groupBehind(view.behind)
  for (const [name, routes] of behindGroups) for (const r of routes) for (const d of r.data) touch(d.table, d.kind, `group:behind:${name}`)
  for (const t of check?.schema.tables.added ?? []) if (!tables.has(lower(t))) tables.set(lower(t), { writes: new Set(), reads: new Set() })
  const tableList = [...tables.keys()].sort()
  if (tableList.length > 0) {
    const { frame, at } = placeFrame('frame:data', 'Data', 'Each kind of record the product keeps. Pick one to see what changes and reads it.', tableList.map(() => SMALL), 4)
    frame.x = right
    frame.y = 0
    frames.push(frame)
    tableList.forEach((name, i) => {
      const p = at(i)
      const t = tables.get(name)!
      const writers = [...t.writes].filter((w) => w.startsWith('screen:')).length
      const change = tableChange.get(lower(name)) ?? null
      cards.push({
        id: `table:${name}`, kind: 'table', key: name, label: name, sub: writers > 0 ? `changed from ${writers} screen${writers === 1 ? '' : 's'}` : t.writes.size > 0 ? 'changed behind the scenes' : 'only read',
        x: frame.x + p.x, y: frame.y + p.y, w: SMALL.w, h: SMALL.h, frame: frame.id, facts: [], needs: null,
        change, changeNote: change === 'new' ? 'new table' : change === 'changed' ? 'changed' : null, access: null, accessNote: null,
        notes: noteCount.get(`table:${name}`) ?? 0,
      })
      for (const w of t.writes) links.push({ from: w, to: `table:${name}`, kind: 'writes' })
      for (const r of t.reads) if (!t.writes.has(r)) links.push({ from: r, to: `table:${name}`, kind: 'reads' })
    })
  }

  // ── Behind the scenes: callers no screen shows, and work done later ─────
  const behind: { id: string; kind: NoteTarget; key: string; label: string; sub: string; facts: string[]; change: Change | null; note: string | null; needs: string | null }[] = []
  for (const [name, routes] of behindGroups) {
    const changed = routes.filter((r) => changedRoutes.has(keyOf(r))).length
    const open = routes.filter((r) => r.noCheck && !publicOk.has(keyOf(r))).length
    behind.push({ id: `group:behind:${name}`, kind: 'group', key: `behind:${name}`, label: name, sub: 'routes no screen calls', facts: [`${routes.length} route${routes.length === 1 ? '' : 's'}`], change: changed > 0 ? 'changed' : null, note: changed > 0 ? `${changed} changed` : null, needs: open > 0 ? `${open} open to anyone` : null })
  }
  for (const q of view.background.queues) behind.push({ id: `job:${q.name}`, kind: 'job', key: q.name, label: `${q.name} queue`, sub: 'work done later', facts: [`${q.jobs.length} kind${q.jobs.length === 1 ? '' : 's'} of job`], change: null, note: null, needs: null })
  if (view.background.timers.length + view.background.sockets.length > 0) {
    behind.push({ id: 'job:always', kind: 'job', key: 'always', label: 'Always running', sub: 'timers and live connections', facts: [`${view.background.timers.length + view.background.sockets.length}`], change: null, note: null, needs: null })
  }
  if (behind.length > 0) {
    const { frame, at } = placeFrame('frame:behind', 'Behind the scenes', 'Reached by webhooks, other services, API keys or a schedule — not by a screen.', behind.map(() => SMALL), 4)
    const data = frames.find((f) => f.id === 'frame:data')
    frame.x = right
    frame.y = data === undefined ? 0 : data.y + data.h + 32
    frames.push(frame)
    behind.forEach((b, i) => {
      const p = at(i)
      cards.push({
        id: b.id, kind: b.kind, key: b.key, label: b.label, sub: b.sub, x: frame.x + p.x, y: frame.y + p.y, w: SMALL.w, h: SMALL.h, frame: frame.id,
        facts: b.facts, needs: b.needs, change: b.change, changeNote: b.note, access: null, accessNote: null, notes: noteCount.get(`${b.kind}:${b.key}`) ?? 0,
      })
    })
  }

  // ── Who can do what, when a Check changes it ────────────────────────────
  if ((check?.roleChanges.length ?? 0) > 0) {
    const byRole = new Map<string, number>()
    for (const c of check!.roleChanges) byRole.set(c.role, (byRole.get(c.role) ?? 0) + 1)
    const list = [...byRole]
    const { frame, at } = placeFrame('frame:roles', 'Who can do what changes', undefined, list.map(() => SMALL), Math.min(4, list.length))
    const lowest = Math.max(...frames.filter((f) => f.x < right).map((f) => f.y + f.h))
    frame.x = 0
    frame.y = lowest + 32
    frames.push(frame)
    list.forEach(([role, n], i) => {
      const p = at(i)
      cards.push({ id: `role:${role}`, kind: 'role', key: role, label: role, sub: `${n} change${n === 1 ? '' : 's'}`, x: frame.x + p.x, y: frame.y + p.y, w: SMALL.w, h: SMALL.h, frame: frame.id, facts: [], needs: null, change: 'changed', changeNote: 'may do something else now', access: null, accessNote: null, notes: noteCount.get(`role:${role}`) ?? 0 })
    })
  }

  // Where each screen leads, and the parts it uses.
  for (const g of view.groups) for (const s of g.screens) {
    for (const to of s.goesTo) links.push({ from: `screen:${s.path}`, to: `screen:${to}`, kind: 'goes' })
    for (const part of view.shared) if (part.screens.includes(s.name)) links.push({ from: `screen:${s.path}`, to: `part:${part.file}`, kind: 'uses' })
  }
  void roles
  return { frames, cards, links }
}

/** Routes no screen calls, grouped by what they're for: "/api/v1/internal/ai/…" is "internal". */
export function groupBehind(routes: readonly RouteRow[]): Map<string, RouteRow[]> {
  const out = new Map<string, RouteRow[]>()
  for (const r of routes) {
    const segs = r.path.replace(/^\/api(\/v\d+)?/, '').split('/').filter((s) => s !== '' && !s.startsWith(':'))
    const name = segs[0] ?? 'root'
    out.set(name, [...(out.get(name) ?? []), r])
  }
  return new Map([...out].sort((a, b) => b[1].length - a[1].length))
}

/** A screen the work removes, drawn crossed out. */
function ghost(s: { name: string; path: string }): ScreenRow {
  return { goesTo: [], path: s.path, file: null, name: s.name, component: null, signIn: 'unknown', app: '', where: '', routes: [] }
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** Everything a card is connected to, one step out. */
export function neighbours(map: ProductMap, id: string): Link[] {
  return map.links.filter((l) => l.from === id || l.to === id)
}
