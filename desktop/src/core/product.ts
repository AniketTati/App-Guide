import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Fact } from '../../../src/model/facts.js'
import { readProduct, type Product } from '../../../src/graph/product.js'
import { rolesFor, type RoleTable } from '../../../src/graph/roles.js'
import { baseRef, checkoutAt, resolve, writeAtomically } from '../../../src/git/repo.js'
import type { ProductView, RolesView, RouteRow, ScreenRow } from '../shared/api.js'

type Route = Extract<Fact, { kind: 'route' }>

/** A product read: the view the pages get, and which files each screen runs —
 *  kept apart, since only a Check needs the second. */
export interface ProductBuild {
  view: ProductView
  /** screen path -> every file it runs. */
  reach: Record<string, string[]>
}

/** The product as it is on main, read from git and cached by commit — what
 *  Home counts, in full. */
export async function productOnMain(root: string, cacheDir: string): Promise<ProductView> {
  const base = await baseRef(root)
  return (await productAt(root, await resolve(root, base), base, cacheDir)).view
}

/**
 * The product as of a commit, cached by commit: a commit never changes. The
 * cache folder is named for the build of the app that wrote it, so a newer
 * app never shows what an older one read.
 */
export async function productAt(root: string, sha: string, base: string, cacheDir: string): Promise<ProductBuild> {
  // Product, Who-can-do-what and a Check can ask for the same commit at once.
  const key = `${cacheDir}\u0000${sha}`
  const running = building.get(key)
  if (running !== undefined) return running
  const p = build(root, base, sha, cacheDir).finally(() => building.delete(key))
  building.set(key, p)
  return p
}

const building = new Map<string, Promise<ProductBuild>>()

async function build(root: string, base: string, sha: string, cacheDir: string): Promise<ProductBuild> {
  const cached = join(cacheDir, `product-${sha}.json`)
  try { return JSON.parse(await readFile(cached, 'utf8')) as ProductBuild } catch { /* not read yet */ }
  const scratch = await mkdtemp(join(tmpdir(), 'appguide-product-'))
  try {
    await checkoutAt(root, sha, scratch)
    const product = await readProduct(scratch)
    const out = buildOf(product, base)
    await writeAtomically(cached, JSON.stringify(out))
    // The same read gives the commit's facts: keep them for the diff too.
    const facts = join(cacheDir, `${sha}.json`)
    if (!existsSync(facts)) await writeAtomically(facts, JSON.stringify(product.facts))
    return out
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * A worktree as it is on disk, uncommitted edits included. Not cached on disk
 * — it changes as Claude works — but kept for as long as its fingerprint holds.
 */
export async function productOfTree(path: string, base: string, fingerprint: string): Promise<{ build: ProductBuild; facts: Fact[] }> {
  const key = `${path}\u0000${fingerprint}`
  const hit = trees.get(key)
  if (hit !== undefined) return hit
  const p = readProduct(path).then((product) => ({ build: buildOf(product, base), facts: product.facts }))
  trees.set(key, p)
  p.catch(() => trees.delete(key))
  while (trees.size > 4) trees.delete(trees.keys().next().value!)
  return p
}

const trees = new Map<string, Promise<{ build: ProductBuild; facts: Fact[] }>>()

export function buildOf(p: Product, base: string): ProductBuild {
  return { view: productView(p, base), reach: Object.fromEntries(p.reach) }
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
    groups.push({ label: appName(app), note: 'A separate app in this repository, with screens of its own.', screens: p.screens.filter((s) => s.app === app).map(screenRow) })
  }

  const reached = new Set([...p.links.values()].flat().map((l) => l.route).concat(p.layout.map((l) => l.route)).concat(p.shared.flatMap((s) => s.links.map((l) => l.route))))
  const nameOf = new Map(p.screens.map((s) => [s.path, screenRow(s).name]))
  const routes = p.facts.filter((f): f is Route => f.kind === 'route')
  return {
    base,
    groups,
    behind: routes.filter((r) => !reached.has(r)).map(row).sort(byOpenThenPath),
    layout: p.layout.map((l) => ({ ...row(l.route), via: l.call.via })).sort(byOpenThenPath),
    shared: p.shared.map((s) => ({
      name: s.name, file: s.file,
      screens: s.screens.map((x) => nameOf.get(x) ?? x),
      routes: s.links.map((l) => row(l.route)).sort(byOpenThenPath),
    })),
    unmatched: p.unmatched.map((u) => ({ method: u.method, path: u.path, where: `${u.file}:${u.line}`, screen: u.screen, via: u.via })),
    roles: p.roles.length === 0 ? null : rolesView(p.roles, routes),
    background: {
      queues: p.background.queues.map((q) => ({
        name: q.name, declared: at(q.declared), repeats: q.repeats.length, workers: q.workers.map(at),
        jobs: q.jobs.map((j) => ({ name: j.name, addedAt: j.addedAt.map(at) })),
      })),
      timers: p.background.timers.map(at),
      sockets: p.background.sockets.map((s) => ({ where: at(s), library: s.library })),
    },
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

/** "@clm/marketing" -> "marketing": a workspace's name as people say it. */
const appName = (app: string): string => (app === '' ? 'Other screens' : app.replace(/^@[^/]+\//, '').replace(/[-_]/g, ' '))

/** `ContractDetailPage` -> "Contract detail": the code's own name, spaced. */
function humanise(component: string): string {
  const words = component.replace(/(Page|Screen|View|Route)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(' ') || component
}

const at = (w: { file: string; line: number }): string => `${w.file}:${w.line}`

const byOpenThenPath = (a: RouteRow, b: RouteRow): number => Number(b.noCheck) - Number(a.noCheck) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1)

function mostScreens(screens: readonly { app: string }[]): string {
  const n = new Map<string, number>()
  for (const s of screens) n.set(s.app, (n.get(s.app) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}
