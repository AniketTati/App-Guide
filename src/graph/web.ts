import { posix } from 'node:path'
import { ts } from 'ts-morph'
import type { ParsedFile } from '../extract/parse.js'
import { importsOf, type Resolver } from './resolve.js'

/** A screen as the router declares it. */
export interface Screen {
  path: string
  /** The page component, as written. */
  component: string | null
  /** Where the component is defined. */
  file: string | null
  where: { file: string; line: number }
  /** From the router's own structure: under a wrapper that sends people to
   *  another screen, or beside one. 'unknown' when nothing gates anything. */
  signIn: 'required' | 'none' | 'unknown'
  /** The sidebar section and label it appears under, if any. */
  section: string | null
  label: string | null
}

export interface ApiCall {
  method: string
  /** With the client's base URL, `${…}` as `:param`, query dropped. */
  path: string
  file: string
  line: number
  /** The component the call is in, when not the screen's own file. */
  via: string | null
}

export interface WebApp {
  screens: Screen[]
  /** Calls each screen makes, by screen path. */
  calls: Map<string, ApiCall[]>
  /** Calls made by a layout every screen under it shares. */
  layout: ApiCall[]
  /** Parts three or more screens use — a dialog, an editor, a store — each
   *  listed once with its calls and the screens it appears on, instead of
   *  crediting its calls to every one of them. */
  shared: SharedPart[]
  /** Every file each screen runs, three imports deep: which screens a change
   *  to a file reaches. */
  reach: Map<string, string[]>
  sections: { label: string | null; items: { to: string; label: string }[] }[]
}

export interface SharedPart {
  name: string
  file: string
  /** Paths of the screens that reach it. */
  screens: string[]
  calls: ApiCall[]
}

interface Client { base: string }

/** Everything the web app's router and sidebar say, and what each screen calls. */
export function readWeb(files: readonly ParsedFile[], r: Resolver): WebApp {
  const clients = findClients(files)
  const routes: { decl: RouteDecl; file: ParsedFile }[] = []
  for (const f of files) for (const d of routeDecls(f, r)) routes.push({ decl: d, file: f })
  const gated = routes.some((x) => x.decl.gate)

  const screens: Screen[] = []
  const layoutComponents: { file: string; path: string }[] = []
  for (const { decl, file } of routes) {
    if (decl.layout) { for (const c of decl.componentFiles) layoutComponents.push({ file: c, path: decl.path }); continue }
    if (decl.redirect || decl.catchAll) continue
    screens.push({
      path: decl.path,
      component: decl.component,
      file: decl.componentFile,
      where: { file: file.path, line: decl.line },
      signIn: !gated ? 'unknown' : decl.underGate ? 'required' : 'none',
      section: null,
      label: null,
    })
  }

  const sections = findSections(files)
  for (const s of screens) {
    let best: { section: string | null; label: string; to: string } | null = null
    for (const sec of sections) for (const item of sec.items) {
      if (item.to === s.path) best = { section: sec.label, label: item.label, to: item.to }
      else if ((best === null || best.to !== s.path) && s.path.startsWith(`${item.to}/`) && (best === null || item.to.length > best.to.length)) best = { section: sec.label, label: '', to: item.to }
    }
    if (best !== null) { s.section = best.section ?? 'Start'; s.label = best.label === '' ? null : best.label }
  }

  // Which files each screen reaches. A module three or more screens reach is
  // shared furniture — a layout piece, an auth store — and crediting its calls
  // to every screen made 32 of 38 pages look like they call /auth.
  const reach = new Map<string, Map<string, string | null>>()
  for (const s of screens) if (s.file !== null) reach.set(s.path, closure(s.file, r, clients))
  const count = new Map<string, number>()
  for (const files of reach.values()) for (const f of files.keys()) count.set(f, (count.get(f) ?? 0) + 1)
  const shared = new Set([...count].filter(([f, n]) => n >= 3 && !screens.some((s) => s.file === f)).map(([f]) => f))

  const calls = new Map<string, ApiCall[]>()
  for (const s of screens) {
    const files = reach.get(s.path)
    if (files === undefined) { calls.set(s.path, []); continue }
    const out: ApiCall[] = []
    for (const [f, via] of files) {
      if (shared.has(f)) continue
      const parsed = r.file(f)
      if (parsed !== undefined) out.push(...callsIn(parsed, r, clients, f === s.file ? null : via))
    }
    calls.set(s.path, dedupe(out))
  }
  const layout = dedupe(layoutComponents.flatMap(({ file }) => {
    const out: ApiCall[] = []
    for (const [f, via] of closure(file, r, clients)) { const p = r.file(f); if (p !== undefined) out.push(...callsIn(p, r, clients, via)) }
    return out
  }))
  // A shared part's calls are still the product's calls: an upload dialog on
  // three pages is how contracts get uploaded. Dropping them filed the upload
  // route under "no screen calls it".
  const sharedParts: SharedPart[] = []
  for (const f of [...shared].sort()) {
    const parsed = r.file(f)
    if (parsed === undefined) continue
    const own = dedupe(callsIn(parsed, r, clients, null))
    if (own.length === 0) continue
    sharedParts.push({ name: componentName(f), file: f, screens: screens.filter((s) => reach.get(s.path)?.has(f) === true).map((s) => s.path), calls: own })
  }
  return { screens, calls, layout, shared: sharedParts, reach: new Map([...reach].map(([k, v]) => [k, [...v.keys()]])), sections }
}

/** One node of a route tree, from JSX or from a route object. */
interface RouteNode { path: string | undefined; index: boolean; element: ts.Expression | undefined; children: RouteNode[]; node: ts.Node }

interface RouteDecl {
  path: string
  line: number
  component: string | null
  componentFile: string | null
  componentFiles: string[]
  layout: boolean
  redirect: boolean
  catchAll: boolean
  gate: boolean
  underGate: boolean
}

/** `<Route path element>` trees and `{ path, element, children }` route objects. */
function routeDecls(file: ParsedFile, r: Resolver): RouteDecl[] {
  const src = file.ast
  const imports = importsOf(file, r)
  const routerNames = routerImports(file)
  if (!routerNames.has('Route') && !routerNames.has('createBrowserRouter') && !routerNames.has('useRoutes') && !routerNames.has('createHashRouter')) return []
  const out: RouteDecl[] = []
  const lineOf = (n: ts.Node): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1

  const describe = (element: ts.Expression | undefined): { names: string[]; redirect: boolean } => {
    const names: string[] = []
    let redirect = false
    if (element === undefined) return { names, redirect }
    const visit = (n: ts.Node): void => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          if (routerNames.get(tag.text) === 'Navigate') redirect = true
          else names.push(tag.text)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(element)
    return { names, redirect }
  }
  const fileOf = (name: string): string | null => imports.get(name)?.path ?? (localComponent(src, name) !== undefined ? file.path : null)
  // A wrapper written in the routes file itself — an onboarding gate around
  // the layout — renders components of its own; those are what it calls
  // through. The routes file is never followed whole: it imports every page.
  const filesOf = (name: string): string[] => {
    const own = localComponent(src, name)
    if (own === undefined) { const f = fileOf(name); return f === null || f === file.path ? [] : [f] }
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName)) {
        const f = imports.get(n.tagName.text)?.path
        if (f !== undefined && f !== file.path && !routerNames.has(n.tagName.text)) out.push(f)
      }
      ts.forEachChild(n, visit)
    }
    visit(own)
    return out
  }
  const isGate = (names: readonly string[]): boolean => names.some((n) => {
    const own = localComponent(src, n)
    if (own !== undefined) return rendersNavigate(own, routerNames)
    const f = fileOf(n)
    return f !== null && sendsElsewhere(r.file(f), routerNames)
  })

  const emit = (path: string | undefined, index: boolean, element: ts.Expression | undefined, children: readonly RouteNode[], node: ts.Node, parent: string, underGate: boolean): void => {
    const base = parent.endsWith('/*') ? parent.slice(0, -2) : parent
    const full = index ? (base === '' ? '/' : base) : path === undefined ? base : path.startsWith('/') ? path : `${base === '/' ? '' : base}/${path}`
    const { names, redirect } = describe(element)
    const page = names.find((n) => /(^|\/)(pages|screens|views|routes)\//.test(fileOf(n) ?? '')) ?? names[names.length - 1] ?? null
    const gate = children.length > 0 && isGate(names)
    out.push({
      path: normalisePath(full), line: lineOf(node),
      component: page, componentFile: page === null ? null : fileOf(page),
      // The routes file itself imports every page; following it from a layout
      // would credit the layout with every screen's calls.
      componentFiles: [...new Set(names.flatMap(filesOf))],
      layout: children.length > 0, redirect, catchAll: path === '*' || path === '/*' && children.length === 0,
      gate, underGate,
    })
    for (const c of children) emit(c.path, c.index, c.element, c.children, c.node, full === '/' ? '/' : path === undefined && !index ? parent : full, underGate || gate)
  }

  // JSX: a <Route> not inside another <Route> starts a tree.
  const jsxRoute = (n: ts.Node): RouteNode | null => {
    if (!ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n)) return null
    const opening = ts.isJsxElement(n) ? n.openingElement : n
    if (!ts.isIdentifier(opening.tagName) || routerNames.get(opening.tagName.text) !== 'Route') return null
    let path: string | undefined
    let index = false
    let element: ts.Expression | undefined
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) continue
      const v = a.initializer
      if (a.name.text === 'path' && v !== undefined && ts.isStringLiteral(v)) path = v.text
      if (a.name.text === 'index') index = true
      if (a.name.text === 'element' && v !== undefined && ts.isJsxExpression(v)) element = v.expression
    }
    const children = ts.isJsxElement(n) ? n.children.map(jsxRoute).filter((c): c is RouteNode => c !== null) : []
    return { path, index, element, children, node: n }
  }
  // Objects: { path: 'x', element: <X/>, children: [...] } inside createBrowserRouter/useRoutes.
  const objectRoute = (n: ts.Expression): RouteNode | null => {
    if (!ts.isObjectLiteralExpression(n)) return null
    const prop = (name: string): ts.Expression | undefined => {
      for (const p of n.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p.initializer
      return undefined
    }
    const pathExpr = prop('path')
    const kids = prop('children')
    const children = kids !== undefined && ts.isArrayLiteralExpression(kids) ? kids.elements.map(objectRoute).filter((c): c is RouteNode => c !== null) : []
    return { path: pathExpr !== undefined && ts.isStringLiteralLike(pathExpr) ? pathExpr.text : undefined, index: prop('index') !== undefined, element: prop('element'), children, node: n }
  }

  const visit = (n: ts.Node, insideRoute: boolean): void => {
    const jr = insideRoute ? null : jsxRoute(n)
    if (jr !== null) { emit(jr.path, jr.index, jr.element, jr.children, jr.node, '/', false); return }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes'].includes(routerNames.get(n.expression.text) ?? '')) {
      const [arr] = n.arguments
      if (arr !== undefined && ts.isArrayLiteralExpression(arr)) {
        for (const el of arr.elements) { const o = objectRoute(el); if (o !== null) emit(o.path, o.index, o.element, o.children, o.node, '/', false) }
        return
      }
    }
    ts.forEachChild(n, (c) => visit(c, insideRoute))
  }
  visit(src, false)
  return out
}

/** Names imported from react-router, local name -> exported name. */
function routerImports(file: ParsedFile): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of file.ast.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteralLike(s.moduleSpecifier)) continue
    if (!/^react-router(-dom)?$|^@remix-run\/react$/.test(s.moduleSpecifier.text)) continue
    const named = s.importClause?.namedBindings
    if (named !== undefined && ts.isNamedImports(named)) for (const el of named.elements) out.set(el.name.text, (el.propertyName ?? el.name).text)
  }
  return out
}

/** A wrapper whose own code renders a <Navigate>: it sends people elsewhere,
 *  which is what a sign-in gate does. Read from its code, never its name. */
function sendsElsewhere(file: ParsedFile | undefined, _names: ReadonlyMap<string, string>): boolean {
  return file !== undefined && rendersNavigate(file.ast, routerImports(file))
}

function rendersNavigate(node: ts.Node, router: ReadonlyMap<string, string>): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && router.get(n.tagName.text) === 'Navigate') found = true
    else ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** A component defined in this file: `function X()` or `const X = () =>`. */
function localComponent(src: ts.SourceFile, name: string): ts.Node | undefined {
  for (const s of src.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined) return d.initializer
  }
  return undefined
}

/** `const api = axios.create({ baseURL: '/api/v1' })`, by file and name. */
function findClients(files: readonly ParsedFile[]): Map<string, Map<string, Client>> {
  const out = new Map<string, Map<string, Client>>()
  for (const f of files) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && ts.isCallExpression(n.initializer)) {
        const c = n.initializer.expression
        if (ts.isPropertyAccessExpression(c) && c.name.text === 'create' && ts.isIdentifier(c.expression) && c.expression.text === 'axios') {
          const [opts] = n.initializer.arguments
          let base = ''
          if (opts !== undefined && ts.isObjectLiteralExpression(opts)) {
            for (const p of opts.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'baseURL' && ts.isStringLiteralLike(p.initializer)) base = p.initializer.text
          }
          const m = out.get(f.path) ?? new Map<string, Client>()
          m.set(n.name.text, { base })
          out.set(f.path, m)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(f.ast)
  }
  return out
}

/** Files a screen reaches through its imports, three steps deep, stopping at
 *  the HTTP client and at packages. Each with the component it came through. */
function closure(start: string, r: Resolver, clients: ReadonlyMap<string, unknown>): Map<string, string | null> {
  const out = new Map<string, string | null>([[start, null]])
  let frontier: { file: string; via: string | null }[] = [{ file: start, via: null }]
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: { file: string; via: string | null }[] = []
    for (const { file, via } of frontier) {
      const parsed = r.file(file)
      if (parsed === undefined) continue
      for (const [, imp] of importsOf(parsed, r)) {
        if (out.has(imp.path) || clients.has(imp.path)) continue
        const through = via ?? componentName(imp.path)
        out.set(imp.path, through)
        next.push({ file: imp.path, via: through })
      }
    }
    frontier = next
  }
  return out
}

const componentName = (path: string): string => posix.basename(path).replace(/\.[^.]+$/, '')

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

/** Calls through the app's HTTP client, and fetch() to its own API. */
function callsIn(file: ParsedFile, r: Resolver, clients: ReadonlyMap<string, ReadonlyMap<string, Client>>, via: string | null): ApiCall[] {
  const src = file.ast
  const imports = importsOf(file, r)
  const local = clients.get(file.path)
  const clientOf = (name: string): Client | undefined => {
    const own = local?.get(name)
    if (own !== undefined) return own
    const imp = imports.get(name)
    return imp === undefined ? undefined : clients.get(imp.path)?.get(imp.name)
  }
  const out: ApiCall[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression
      const [first, second] = n.arguments
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && METHODS.has(c.name.text) && first !== undefined) {
        const client = clientOf(c.expression.text)
        const path = client === undefined ? null : pathOf(first, src)
        if (client !== undefined && path !== null) out.push({ method: c.name.text.toUpperCase(), path: join(client.base, path), file: file.path, line: line(n, src), via })
      } else if (ts.isIdentifier(c) && c.text === 'fetch' && first !== undefined) {
        const path = pathOf(first, src)
        if (path !== null && path.startsWith('/')) out.push({ method: methodOf(second) ?? 'GET', path, file: file.path, line: line(n, src), via })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

/**
 * A literal or template path. A `${…}` that is a whole segment is a
 * parameter: `/contracts/${id}` -> `/contracts/:param`. One glued onto the end
 * of a segment is a query string or a suffix — `/audit${qs}` is `/audit` — and
 * reading it as a parameter made a real call look like a call to nothing.
 */
function pathOf(expr: ts.Expression, src: ts.SourceFile): string | null {
  void src
  let text: string
  const HOLE = '\u0000'
  if (ts.isStringLiteralLike(expr)) text = expr.text
  else if (ts.isTemplateExpression(expr)) text = expr.head.text + expr.templateSpans.map((s) => `${HOLE}${s.literal.text}`).join('')
  else return null
  const path = text.split(/[?#]/)[0]!
  return path.split('/').map((seg) => {
    if (!seg.includes(HOLE)) return seg
    const before = seg.slice(0, seg.indexOf(HOLE))
    return before !== '' && seg.endsWith(HOLE) ? before : ':param'
  }).join('/')
}

function methodOf(init: ts.Expression | undefined): string | null {
  if (init === undefined || !ts.isObjectLiteralExpression(init)) return null
  for (const p of init.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method' && ts.isStringLiteralLike(p.initializer)) return p.initializer.text.toUpperCase()
  return null
}

const line = (n: ts.Node, src: ts.SourceFile): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1
const join = (base: string, path: string): string => (path.startsWith('http') || base === '' || path.startsWith(base) ? path : `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`)
const normalisePath = (p: string): string => (`/${p}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'))

function dedupe(calls: readonly ApiCall[]): ApiCall[] {
  const seen = new Set<string>()
  return calls.filter((c) => { const k = `${c.method} ${c.path} ${c.file}:${c.line}`; if (seen.has(k)) return false; seen.add(k); return true })
}

/** Sidebar sections: arrays of `{ label?, items: [{ to, label }] }`. */
function findSections(files: readonly ParsedFile[]): WebApp['sections'] {
  const out: WebApp['sections'] = []
  const str = (o: ts.ObjectLiteralExpression, name: string): string | undefined => {
    for (const p of o.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name && ts.isStringLiteralLike(p.initializer)) return p.initializer.text
    return undefined
  }
  for (const f of files) {
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const items = n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'items')
        if (items !== undefined && ts.isArrayLiteralExpression(items.initializer)) {
          const list = items.initializer.elements.filter(ts.isObjectLiteralExpression).map((o) => ({ to: str(o, 'to'), label: str(o, 'label') }))
            .filter((i): i is { to: string; label: string } => i.to !== undefined && i.label !== undefined && i.to.startsWith('/'))
          if (list.length > 0) out.push({ label: str(n, 'label') ?? null, items: list })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(f.ast)
  }
  return out
}

/** The route a call reaches: method and path, a literal segment beating a
 *  parameter. null when nothing matches — a call to a route that isn't there. */
export function matchCall<R extends { method: string; path: string }>(call: ApiCall, routes: readonly R[]): R | null {
  const segs = call.path.split('/').filter(Boolean)
  let best: { route: R; score: number } | null = null
  for (const route of routes) {
    if (route.method !== call.method && route.method !== 'ALL') continue
    const rs = route.path.split('/').filter(Boolean)
    if (rs.length !== segs.length) continue
    let score = 0
    let ok = true
    for (let i = 0; i < rs.length; i++) {
      const a = segs[i]!, b = rs[i]!
      if (a === b) score += 2
      else if (b.startsWith(':')) score += 1
      else if (a.startsWith(':')) score += 0
      else { ok = false; break }
    }
    if (ok && (best === null || score > best.score)) best = { route, score }
  }
  return best?.route ?? null
}
