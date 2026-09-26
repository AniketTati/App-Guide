import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fact } from '../model/facts.js'
import { readRepo } from '../run.js'
import { resolver } from './resolve.js'
import { matchCall, readWeb, type ApiCall, type Screen } from './web.js'
import { routeData, type DataUse } from './data.js'
import { readRoles, type RoleTable } from './roles.js'

type Route = Extract<Fact, { kind: 'route' }>

/** What the product does, as one picture: its screens, what each calls, and
 *  the routes behind them. Read-only, like everything else. */
export interface Product {
  facts: Fact[]
  screens: (Screen & { app: string })[]
  /** screen path -> the routes it reaches, each with how it was found. */
  links: Map<string, { route: Route; call: ApiCall }[]>
  /** Calls every screen under a layout shares. */
  layout: { route: Route; call: ApiCall }[]
  /** Calls that match no route: a button that reaches nothing. */
  unmatched: (ApiCall & { screen: string | null })[]
  sections: { label: string | null; items: { to: string; label: string }[] }[]
  /** What each route's handler reads and changes. */
  data: Map<Route, DataUse[]>
  /** Every role -> permissions table found; roles keyed by an enum first. */
  roles: RoleTable[]
}

export async function readProduct(root: string): Promise<Product> {
  const repo = await readRepo(root, { versions: 'declared' })
  const text = async (paths: readonly string[]): Promise<Map<string, string>> =>
    new Map(await Promise.all(paths.map(async (p) => [p, await readFile(join(root, p), 'utf8').catch(() => '')] as const)))
  const r = resolver(repo.parsed, await text(repo.configs), await text(repo.manifests))
  const web = readWeb(repo.parsed, r)
  const routes = repo.facts.filter((f): f is Route => f.kind === 'route')
  const appOf = (file: string): string => repo.workspace.find((m) => file.startsWith(`${m.dir}/`))?.name ?? ''

  const links = new Map<string, { route: Route; call: ApiCall }[]>()
  const unmatched: Product['unmatched'] = []
  for (const s of web.screens) {
    const out: { route: Route; call: ApiCall }[] = []
    for (const call of web.calls.get(s.path) ?? []) {
      const route = matchCall(call, routes)
      if (route === null) unmatched.push({ ...call, screen: s.path })
      else if (!out.some((o) => o.route === route)) out.push({ route, call })
    }
    links.set(s.path, out)
  }
  const layout: Product['layout'] = []
  for (const call of web.layout) {
    const route = matchCall(call, routes)
    if (route === null) unmatched.push({ ...call, screen: null })
    else if (!layout.some((o) => o.route === route)) layout.push({ route, call })
  }
  return {
    facts: repo.facts,
    screens: web.screens.map((s) => ({ ...s, app: appOf(s.where.file) })),
    links, layout, unmatched, sections: web.sections,
    data: routeData(routes, new Map(repo.parsed.map((f) => [f.path, f])), r),
    roles: readRoles(repo.parsed, r),
  }
}
