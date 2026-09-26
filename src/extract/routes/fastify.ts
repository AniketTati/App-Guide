import { posix } from 'node:path'
import { ts } from 'ts-morph'
import type { Fact, Middleware } from '../../model/facts.js'
import type { ParsedFile } from '../parse.js'
import type { RouteDetector } from './types.js'
import { normalise } from './express.js'
import { isTestFile } from '../files.js'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])
/** The hooks that run before a handler: where a check lives. */
const CHECK_HOOKS = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler'])

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

interface FileIndex {
  file: ParsedFile
  /** Functions defined anywhere in the file, by name. */
  locals: Map<string, Fn>
  /** Exported functions by exported name; 'default' for the default export. */
  exported: Map<string, Fn>
  /** Local name -> the relative module and name it was imported from. */
  imports: Map<string, { path: string; name: string }>
  /** Local names imported from a package (a library plugin, never ours). */
  packages: Set<string>
  /** Local names bound to the Fastify factory. */
  factories: Set<string>
  /** Local names bound to fastify-plugin, which shares its parent's context. */
  sharers: Set<string>
}

interface Scope {
  prefix: string
  /** Checks inherited from enclosing plugins. The app's own hooks are left out,
   *  as Express's app-wide middleware is: they run for every route, so they
   *  cannot tell one route from another. */
  hooks: readonly string[]
  root: boolean
  /** Where the prefix could not be followed — the route is scoped to its file. */
  unmounted: boolean
}

/**
 * Fastify: `app.register(plugin, { prefix })` resolved across files, routes as
 * `app.get(path, [options], handler)` or `app.route({ method, url })`, and the
 * checks that run before each one — route-level `preHandler`/`onRequest`/…
 * and the hooks a plugin adds for every route inside it. Whatever is decided
 * while the app runs, or registered by code we cannot follow, becomes a gap.
 */
export const fastify: RouteDetector = {
  name: 'fastify',
  packages: ['fastify'],
  detect({ files }) {
    const facts: Fact[] = []
    // Tests build the app too — at other prefixes, or twice. The caller has
    // already left them out; this keeps the detector safe on its own.
    const sources = files.filter((f) => !isTestFile(f.path))
    const paths = new Set(sources.map((f) => f.path))
    const index = new Map(sources.map((f) => [f.path, indexFile(f, paths)]))
    const walked = new Set<Fn>()

    const lineOf = (idx: FileIndex, n: ts.Node): number =>
      idx.file.ast.getLineAndCharacterOfPosition(n.getStart(idx.file.ast)).line + 1
    const gap = (idx: FileIndex, n: ts.Node, reason: 'dynamic-dispatch' | 'computed-route-path' | 'unresolved-route-prefix', detail: string): void => {
      const line = lineOf(idx, n)
      facts.push({ kind: 'gap', reason, subject: `${idx.file.path}:${line}`, detail, where: { file: idx.file.path, line } })
    }

    /** A plugin function wherever it is defined, or null if it is not ours. */
    const resolve = (idx: FileIndex, name: string): { idx: FileIndex; fn: Fn } | 'package' | null => {
      const local = idx.locals.get(name)
      if (local !== undefined) return { idx, fn: local }
      if (idx.packages.has(name)) return 'package'
      const imported = idx.imports.get(name)
      if (imported === undefined) return null
      const target = index.get(imported.path)
      const fn = target?.exported.get(imported.name)
      return target !== undefined && fn !== undefined ? { idx: target, fn } : null
    }

    const walk = (idx: FileIndex, body: ts.Node, instances: ReadonlySet<string>, scope: Scope, depth: number): void => {
      if (depth > 12) return
      const src = idx.file.ast
      const lookup = constants(body, src)
      const own = scope.root ? [] : localHooks(body, instances, src, lookup)
      const checks: readonly string[] = [...scope.hooks, ...own]
      const aliases = new Set(instances)

      const visit = (node: ts.Node): void => {
        // `const r = app.withTypeProvider<Zod>()` is the same instance.
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isInstance(node.initializer, aliases)) {
          aliases.add(node.name.text)
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression
          if (ts.isElementAccessExpression(callee) && isInstance(callee.expression, aliases) && node.arguments.length >= 2) {
            gap(idx, node, 'dynamic-dispatch', 'routes are registered with a method chosen while the app runs, so which ones exist is not known until then')
          } else if (ts.isPropertyAccessExpression(callee) && isInstance(callee.expression, aliases)) {
            const name = callee.name.text
            if (name === 'register') { register(idx, node, scope, checks, depth); return }
            if (name === 'route') { routeObject(idx, node, scope, checks, lookup); return }
            if (METHODS.has(name.toLowerCase()) && node.arguments.length >= 2) { shorthand(idx, node, name.toLowerCase(), scope, checks, lookup); return }
          } else if (ts.isIdentifier(callee) && node.arguments.some((a) => isInstance(a, aliases))) {
            // `defineAdminRoutes(app)`: a helper that adds routes to the
            // instance it is given, in the same plugin.
            const helper = resolve(idx, callee.text)
            const at = node.arguments.findIndex((a) => isInstance(a, aliases))
            if (helper !== null && helper !== 'package' && !walked.has(helper.fn)) {
              const param = helper.fn.parameters[at]?.name
              if (param !== undefined && ts.isIdentifier(param)) {
                walked.add(helper.fn)
                if (helper.fn.body !== undefined) walk(helper.idx, helper.fn.body, new Set([param.text]), { ...scope, hooks: checks, root: false }, depth + 1)
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(body)
    }

    const register = (idx: FileIndex, call: ts.CallExpression, scope: Scope, checks: readonly string[], depth: number): void => {
      const [target, options] = call.arguments
      if (target === undefined) return
      const opts = options !== undefined && ts.isObjectLiteralExpression(options) ? options : undefined
      const prefixProp = opts === undefined ? undefined : property(opts, 'prefix')
      const known = prefixProp === undefined || ts.isStringLiteralLike(prefixProp)
      const child = (fn: Fn, where: FileIndex, shared: boolean): void => {
        if (walked.has(fn)) return
        walked.add(fn)
        const param = fn.parameters[0]?.name
        if (param === undefined || !ts.isIdentifier(param) || fn.body === undefined) return
        if (!known) gap(idx, call, 'unresolved-route-prefix', 'this plugin is mounted at a prefix computed while the app runs, so its full paths are not known')
        walk(where, fn.body, new Set([param.text]), {
          // fastify-plugin shares the parent's context, prefix included.
          prefix: shared || prefixProp === undefined || !ts.isStringLiteralLike(prefixProp) ? scope.prefix : `${scope.prefix}${prefixProp.text}`,
          hooks: checks,
          root: false,
          unmounted: scope.unmounted || !known,
        }, depth + 1)
      }

      let expr: ts.Expression = unwrap(target)
      let shared = false
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && idx.sharers.has(expr.expression.text) && expr.arguments[0] !== undefined) {
        shared = true
        expr = unwrap(expr.arguments[0])
      }
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return child(expr, idx, shared)
      if (ts.isIdentifier(expr)) {
        const found = resolve(idx, expr.text)
        if (found === 'package') return library(idx, call, prefixProp)
        if (found !== null) return child(found.fn, found.idx, shared)
      }
      // `bullBoard.registerPlugin()`, `import('./x')`, a plugin held in a
      // variable: a library's own routes, or ours by a road we cannot follow.
      if (ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr)) return library(idx, call, prefixProp)
      gap(idx, call, 'dynamic-dispatch', 'a plugin is registered here that I could not follow, so any routes it adds are not listed')
    }

    /** A library plugin. With a prefix it is serving pages or an API of its
     *  own — a dashboard, docs — that we cannot list; without one it is
     *  middleware like CORS or rate limiting, and adds no routes. */
    const library = (idx: FileIndex, call: ts.CallExpression, prefix: ts.Expression | undefined): void => {
      if (prefix === undefined) return
      const at = ts.isStringLiteralLike(prefix) ? ` under ${prefix.text}` : ''
      gap(idx, call, 'dynamic-dispatch', `a plugin from a library is mounted here${at}; the routes it adds are not listed`)
    }

    const emit = (idx: FileIndex, node: ts.Node, method: string, path: string, scope: Scope, middleware: Middleware): void => {
      const line = lineOf(idx, node)
      facts.push({
        kind: 'route',
        method: method === 'all' ? 'ALL' : method.toUpperCase(),
        path: normalise(`${scope.prefix}${path}`),
        middleware,
        framework: 'fastify',
        ...(scope.unmounted ? { scope: idx.file.path } : {}),
        where: { file: idx.file.path, line },
      })
    }

    const shorthand = (idx: FileIndex, call: ts.CallExpression, method: string, scope: Scope, checks: readonly string[], lookup: Lookup): void => {
      const [path, ...rest] = call.arguments
      if (path === undefined) return
      if (!ts.isStringLiteralLike(path)) {
        gap(idx, call, 'computed-route-path', `${method.toUpperCase()} route path is built at runtime`)
        return
      }
      // `app.get(path, handler)` or `app.get(path, options, handler)`.
      const opts = rest.length >= 2 && ts.isObjectLiteralExpression(rest[0]!) ? rest[0] : undefined
      emit(idx, call, method, path.text, scope, combine(checks, opts === undefined ? [] : routeHooks(opts, idx.file.ast, lookup)))
    }

    const routeObject = (idx: FileIndex, call: ts.CallExpression, scope: Scope, checks: readonly string[], lookup: Lookup): void => {
      const [spec] = call.arguments
      if (spec === undefined || !ts.isObjectLiteralExpression(spec)) {
        gap(idx, call, 'dynamic-dispatch', 'a route is defined from a value built while the app runs')
        return
      }
      const method = property(spec, 'method')
      const url = property(spec, 'url') ?? property(spec, 'path')
      const methods = method === undefined ? [] : ts.isStringLiteralLike(method) ? [method.text]
        : ts.isArrayLiteralExpression(method) && method.elements.every(ts.isStringLiteralLike) ? method.elements.map((e) => (e as ts.StringLiteralLike).text) : null
      if (methods === null || methods.length === 0 || url === undefined || !ts.isStringLiteralLike(url)) {
        gap(idx, call, url !== undefined && !ts.isStringLiteralLike(url) ? 'computed-route-path' : 'dynamic-dispatch',
          'a route\'s method or path is decided while the app runs')
        return
      }
      const middleware = combine(checks, routeHooks(spec, idx.file.ast, lookup))
      for (const m of methods) emit(idx, call, m.toLowerCase(), url.text, scope, middleware)
    }

    // From every place the app is created.
    for (const idx of index.values()) {
      for (const { scope, name } of roots(idx)) {
        walk(idx, scope, new Set([name]), { prefix: '', hooks: [], root: true, unmounted: false }, 0)
      }
    }

    // Plugins nothing we can see registers — mounted by code we cannot follow,
    // or only by tests. Their routes are real, with a prefix we do not know.
    for (const idx of index.values()) {
      for (const fn of new Set(idx.locals.values())) {
        if (walked.has(fn) || !looksLikePlugin(fn)) continue
        walked.add(fn)
        const param = fn.parameters[0]!.name as ts.Identifier
        const before = facts.length
        walk(idx, fn.body!, new Set([param.text]), { prefix: '', hooks: [], root: false, unmounted: true }, 0)
        if (facts.slice(before).some((f) => f.kind === 'route')) {
          gap(idx, fn, 'unresolved-route-prefix', 'these routes are registered by code I cannot follow, so their full paths have a prefix I cannot see')
        }
      }
    }
    return facts
  },
}

function indexFile(file: ParsedFile, paths: ReadonlySet<string>): FileIndex {
  const idx: FileIndex = { file, locals: new Map(), exported: new Map(), imports: new Map(), packages: new Set(), factories: new Set(), sharers: new Set() }
  const src = file.ast
  const isExported = (n: ts.Node): boolean =>
    (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const isDefault = (n: ts.Node): boolean =>
    (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  const exportedNames = new Map<string, string>()

  for (const stmt of src.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text
      const clause = stmt.importClause
      if (clause === undefined) continue
      const bind = (local: string, name: string): void => {
        if (spec === 'fastify' && (name === 'default' || name === 'fastify' || name === 'Fastify')) idx.factories.add(local)
        else if (spec === 'fastify-plugin') idx.sharers.add(local)
        else if (spec.startsWith('.')) {
          const target = resolveRelative(file.path, spec, paths)
          if (target !== null) idx.imports.set(local, { path: target, name })
        } else idx.packages.add(local)
      }
      if (clause.name !== undefined) bind(clause.name.text, 'default')
      const named = clause.namedBindings
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) bind(el.name.text, (el.propertyName ?? el.name).text)
      }
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined && stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) exportedNames.set((el.propertyName ?? el.name).text, el.name.text)
    }
    if (ts.isExportAssignment(stmt)) {
      const e = stmt.expression
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) idx.exported.set('default', e)
      else if (ts.isIdentifier(e)) exportedNames.set(e.text, 'default')
      else if (ts.isCallExpression(e) && e.arguments[0] !== undefined && (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0]))) {
        idx.exported.set('default', e.arguments[0])
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
      if (node.name !== undefined) idx.locals.set(node.name.text, node)
      if (isExported(node)) idx.exported.set(isDefault(node) ? 'default' : node.name?.text ?? 'default', node)
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
        let init = decl.initializer
        // `fp(async (app) => …)` wraps the plugin.
        if (ts.isCallExpression(init) && init.arguments[0] !== undefined && (ts.isArrowFunction(init.arguments[0]) || ts.isFunctionExpression(init.arguments[0]))) init = init.arguments[0]
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          idx.locals.set(decl.name.text, init)
          if (isExported(node)) idx.exported.set(decl.name.text, init)
        }
        const req = decl.initializer
        if (ts.isCallExpression(req) && ts.isIdentifier(req.expression) && req.expression.text === 'require' && req.arguments[0] !== undefined && ts.isStringLiteralLike(req.arguments[0])) {
          if (req.arguments[0].text === 'fastify') idx.factories.add(decl.name.text)
          else if (req.arguments[0].text === 'fastify-plugin') idx.sharers.add(decl.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  for (const [local, exportedAs] of exportedNames) {
    const fn = idx.locals.get(local)
    if (fn !== undefined) idx.exported.set(exportedAs, fn)
  }
  return idx
}

/** Where the app is created: `const app = Fastify(…)`, in whatever function builds it. */
function roots(idx: FileIndex): { scope: ts.Node; name: string }[] {
  const out: { scope: ts.Node; name: string }[] = []
  if (idx.factories.size === 0) return out
  const visit = (node: ts.Node, scope: ts.Node): void => {
    const next = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ? node : scope
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      let init = node.initializer
      if (ts.isAwaitExpression(init)) init = init.expression
      if (ts.isCallExpression(init)) {
        const c = init.expression
        const factory = (ts.isIdentifier(c) && idx.factories.has(c.text)) ||
          (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && idx.factories.has(c.expression.text))
        if (factory) out.push({ scope, name: node.name.text })
      }
    }
    ts.forEachChild(node, (c) => visit(c, next))
  }
  visit(idx.file.ast, idx.file.ast)
  return out
}

/** A function whose first parameter is used as a Fastify instance for routes. */
function looksLikePlugin(fn: Fn): boolean {
  const param = fn.parameters[0]
  if (param === undefined || !ts.isIdentifier(param.name) || fn.body === undefined) return false
  const typed = param.type !== undefined && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName) && param.type.typeName.text === 'FastifyInstance'
  if (typed) return true
  const name = param.name.text
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === name && (METHODS.has(node.expression.name.text) || node.expression.name.text === 'route') && node.arguments.length >= 1) found = true
    else ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return found
}

function isInstance(expr: ts.Expression, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expr)) return names.has(expr.text)
  // `app.withTypeProvider<T>()` returns the same instance, typed.
  return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'withTypeProvider' && isInstance(expr.expression.expression, names)
}

type Lookup = (name: string) => ts.Expression | undefined

/**
 * `const adminGuard = requirePermission('configure', 'user')`: a check is often
 * given a short name first. Following the name to what it stands for is
 * reading the code, not guessing — the plugin's own constants first, then the
 * file's. A name declared twice in the same place is not followed.
 */
function constants(body: ts.Node, src: ts.SourceFile): Lookup {
  const collect = (root: ts.Node): Map<string, ts.Expression | null> => {
    const out = new Map<string, ts.Expression | null>()
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
        for (const d of node.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer !== undefined) out.set(d.name.text, out.has(d.name.text) ? null : d.initializer)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return out
  }
  const near = collect(body)
  let far: Map<string, ts.Expression | null> | undefined
  return (name) => {
    const hit = near.get(name)
    if (hit !== undefined) return hit ?? undefined
    far ??= collect(src)
    return far.get(name) ?? undefined
  }
}

/** `x as any`, `(x)`, `x!`, `x satisfies T` are all still x. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}

/** `instance.addHook('preHandler', check)` directly inside this plugin. */
function localHooks(body: ts.Node, instances: ReadonlySet<string>, src: ts.SourceFile, lookup: Lookup): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addHook' && isInstance(node.expression.expression, instances)) {
      const [hook, fn] = node.arguments
      if (hook !== undefined && ts.isStringLiteralLike(hook) && CHECK_HOOKS.has(hook.text) && fn !== undefined) {
        const names = describe(fn, hook.text, src, lookup)
        out.push(...(names === null ? [`${hook.text} hook`] : names))
      }
      return
    }
    // A nested plugin's hooks are its own.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'register') return
    ts.forEachChild(node, visit)
  }
  visit(body)
  return out
}

/** Route-level checks in a route's options. null if any cannot be named. */
function routeHooks(opts: ts.ObjectLiteralExpression, src: ts.SourceFile, lookup: Lookup): string[] | null {
  const out: string[] = []
  for (const hook of CHECK_HOOKS) {
    const value = property(opts, hook)
    if (value === undefined) continue
    const names = describe(value, hook, src, lookup)
    if (names === null) return null
    out.push(...names)
  }
  return out
}

/** A check as written: `requireUser`, `requirePermission('approve', 'approval')`,
 *  `app.authenticate`. An inline function is a real check with no name. */
function describe(expr: ts.Expression, hook: string, src: ts.SourceFile, lookup: Lookup, depth = 0): string[] | null {
  expr = unwrap(expr)
  if (ts.isArrayLiteralExpression(expr)) {
    const out: string[] = []
    for (const el of expr.elements) {
      const names = describe(el, hook, src, lookup, depth)
      if (names === null) return null
      out.push(...names)
    }
    return out
  }
  if (ts.isIdentifier(expr)) {
    const stands = depth < 4 ? lookup(expr.text) : undefined
    if (stands !== undefined && (ts.isCallExpression(unwrap(stands)) || ts.isArrayLiteralExpression(unwrap(stands)) || ts.isIdentifier(unwrap(stands)))) {
      return describe(stands, hook, src, lookup, depth + 1)
    }
    return [expr.text]
  }
  if (ts.isPropertyAccessExpression(expr)) return [expr.getText(src)]
  if (ts.isCallExpression(expr)) return [expr.getText(src).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')]
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return [`inline ${hook}`]
  return null
}

function combine(inherited: readonly string[], own: string[] | null): Middleware {
  return own === null ? 'unresolved' : [...inherited, ...own]
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === name) return p.initializer
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name
  }
  return undefined
}

/** `./routes/x.js` pointing at a .ts file, or a directory index. */
function resolveRelative(from: string, spec: string, paths: ReadonlySet<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const stem = base.replace(/\.(js|ts|mjs|cjs|jsx|tsx)$/, '')
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map((e) => `${stem}${e}`), `${stem}/index.ts`, `${stem}/index.js`]
  return candidates.find((c) => paths.has(c)) ?? null
}
