import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Fact } from '../../../src/model/facts.js'
import { readProduct, type Product } from '../../../src/graph/product.js'
import { rolesFor, type RoleTable } from '../../../src/graph/roles.js'
import { baseRef, checkoutAt, resolve, writeAtomically } from '../../../src/git/repo.js'
import type { ProductView, RolesView, RouteRow, ScreenRow } from '../shared/api.js'

type Route = Extract<Fact, { kind: 'route' }>

/** Bumped whenever the view is built differently. */
const VIEW_VERSION = 3

/** The product as it is on main, read from git and cached by commit — what
 *  Home counts, in full. */
export async function productOnMain(root: string, cacheDir: string): Promise<ProductView> {
  const base = await baseRef(root)
  const sha = await resolve(root, base)
  // Product and Who-can-do-what can ask for the same commit at once.
  const key = `${cacheDir}\u0000${sha}`
  const running = building.get(key)
  if (running !== undefined) return running
  const p = build(root, base, sha, cacheDir).finally(() => building.delete(key))
  building.set(key, p)
  return p
}

const building = new Map<string, Promise<ProductView>>()

async function build(root: string, base: string, sha: string, cacheDir: string): Promise<ProductView> {
  // Versioned: a newer app must not show a view an older one built.
  const cached = join(cacheDir, `product-v${VIEW_VERSION}-${sha}.json`)
  try { return JSON.parse(await readFile(cached, 'utf8')) as ProductView } catch { /* not read yet */ }
  const scratch = await mkdtemp(join(tmpdir(), 'appguide-product-'))
  try {
    await checkoutAt(root, sha, scratch)
    const view = productView(await readProduct(scratch), base)
    await writeAtomically(cached, JSON.stringify(view))
    return view
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export function productView(p: Product, base: string): ProductView {
  const table = p.roles[0] ?? null
  const row = (route: Route): RouteRow => ({
    method: route.method,
    path: route.path,
    checks: route.middleware === 'unresolved' ? 'unresolved' : [...route.middleware],
    noCheck: Array.isArray(route.middleware) && route.middleware.length === 0,
    who: table === null || !Array.isArray(route.middleware) ? null : rolesFor(route.middleware, table),
    data: (p.data.get(route) ?? []).map((d) => ({ table: d.table, kind: d.kind, via: d.via })),
    where: `${route.where.file}:${route.where.line}`,
  })

  const screenRow = (s: Product['screens'][number]): ScreenRow => ({
    path: s.path,
    file: s.file,
    name: s.label ?? (s.component !== null ? humanise(s.component) : s.path),
    component: s.component,
    signIn: s.signIn,
    app: s.app,
    where: `${s.where.file}:${s.where.line}`,
    routes: (p.links.get(s.path) ?? []).map((l) => row(l.route)).sort(byOpenThenPath),
  })

  // The sidebar's own order; then signed-in screens it does not list; then
  // screens with no sign-in; each other app (a marketing site) last.
  const main = mostScreens(p.screens)
  const groups: ProductView['groups'] = []
  const placed = new Set<string>()
  for (const sec of p.sections) {
    const label = sec.label ?? 'Start'
    const screens = p.screens.filter((s) => s.app === main && s.section === label).map(screenRow)
    if (screens.length > 0 && !groups.some((g) => g.label === label)) { groups.push({ label, screens }); for (const s of screens) placed.add(s.path) }
  }
  const elsewhere = p.screens.filter((s) => s.app === main && !placed.has(s.path) && s.signIn !== 'none').map(screenRow)
  if (elsewhere.length > 0) groups.push({ label: 'Elsewhere', note: 'Signed-in screens the sidebar doesn’t list — reached by a link or a button.', screens: elsewhere })
  const open = p.screens.filter((s) => s.app === main && s.signIn === 'none').map(screenRow)
  if (open.length > 0) groups.push({ label: 'No sign-in', note: 'Screens anyone with the address can open.', screens: open })
  for (const app of [...new Set(p.screens.map((s) => s.app))].filter((a) => a !== main)) {
    groups.push({ label: app === '' ? 'Other screens' : app, note: 'A separate app in this repository.', screens: p.screens.filter((s) => s.app === app).map(screenRow) })
  }

  const reached = new Set([...p.links.values()].flat().map((l) => l.route).concat(p.layout.map((l) => l.route)))
  const routes = p.facts.filter((f): f is Route => f.kind === 'route')
  return {
    base,
    groups,
    behind: routes.filter((r) => !reached.has(r)).map(row).sort(byOpenThenPath),
    layout: p.layout.map((l) => row(l.route)).sort(byOpenThenPath),
    unmatched: p.unmatched.map((u) => ({ method: u.method, path: u.path, where: `${u.file}:${u.line}`, screen: u.screen })),
    roles: p.roles.length === 0 ? null : rolesView(p.roles, routes),
    readAt: new Date().toISOString(),
  }
}

function rolesView(tables: readonly RoleTable[], routes: readonly Route[]): RolesView {
  const out: RolesView = { tables: [], routes: {} }
  for (const t of tables) {
    const resources = [...new Set(t.roles.flatMap((r) => r.grants.map((g) => g.resource)))].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a < b ? -1 : 1))
    out.tables.push({
      name: t.name,
      where: `${t.file}:${t.line}`,
      roles: t.roles.map((r) => r.role),
      rows: resources.map((resource) => ({
        resource,
        cells: Object.fromEntries(t.roles.map((r) => {
          const byScope = new Map<string | null, string[]>()
          // A grant on every resource applies to this one too — leaving it out
          // of the row made a role that can do everything look like it could
          // do nothing here.
          for (const g of r.grants.filter((x) => x.resource === resource || (x.resource === '*' && resource !== '*'))) byScope.set(g.scope, [...(byScope.get(g.scope) ?? []), g.action])
          return [r.role, [...byScope].map(([scope, actions]) => ({ actions, scope }))]
        })),
      })),
    })
  }
  // Which routes each permission opens, from the routes' own checks.
  for (const r of routes) {
    if (!Array.isArray(r.middleware)) continue
    for (const c of r.middleware) {
      const m = /^\w+\('([^']+)',\s*'([^']+)'\)$/.exec(c)
      if (m === null) continue
      const key = `${m[1]} ${m[2]}`
      ;(out.routes[key] ??= []).push({ method: r.method, path: r.path })
    }
  }
  return out
}

/** `ContractDetailPage` -> "Contract detail": the code's own name, spaced. */
function humanise(component: string): string {
  const words = component.replace(/(Page|Screen|View|Route)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(' ') || component
}

const byOpenThenPath = (a: RouteRow, b: RouteRow): number => Number(b.noCheck) - Number(a.noCheck) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1)

function mostScreens(screens: readonly { app: string }[]): string {
  const n = new Map<string, number>()
  for (const s of screens) n.set(s.app, (n.get(s.app) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}
