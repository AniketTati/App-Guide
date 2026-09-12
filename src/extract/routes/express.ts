import { posix } from 'node:path'
import { ts } from 'ts-morph'
import type { Fact, Middleware } from '../../model/facts.js'
import type { ParsedFile } from '../parse.js'
import type { RouteDetector } from './types.js'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

/**
 * Syntactic detection: `app.get('/x', auth, handler)` and `router.post(...)`.
 *
 * Mount prefixes are resolved within a file (`app.use('/api', router)`) and
 * across files (`app.use('/api/v1', require('./routes/v1'))`), because routers
 * in their own files is the most common real Express layout. Anything decided
 * while the app runs — a computed path, a method chosen from a variable in a
 * loop — becomes a gap. Never a guess, and never silence.
 */
export const express: RouteDetector = {
  name: 'express',
  packages: ['express', '@types/express'],
  detect({ files }) {
    const facts: Fact[] = []
    const fileMounts = crossFileMounts(files)

    for (const file of files) {
      const src = file.ast
      const prefixes = mountPrefixes(src)
      const apps = appBindings(src)
      // A file's inherited prefix is only unambiguous if it defines one router.
      const routers = [...apps.values()].filter((k) => k === 'router').length
      const inherited = routers === 1 ? fileMounts.get(file.path) : undefined
      const lineOf = (n: ts.Node): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1

      const visit = (node: ts.Node, helperApp: string | null): void => {
        // `app.resource = function (path, obj) { this.get(path + '/:id', …) }`.
        // Inside a function hung off the app, `this` is the app.
        if (
          ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) &&
          apps.has(node.left.expression.text) && ts.isFunctionExpression(node.right)
        ) {
          const owner = node.left.expression.text
          ts.forEachChild(node.right, (c) => visit(c, owner))
          return
        }

        if (ts.isCallExpression(node)) {
          const callee = node.expression

          // `app[verb](url, handler)`: which method, and usually which path,
          // is decided while the app runs. We cannot list these routes — and
          // we must not be silent that they exist.
          if (
            ts.isElementAccessExpression(callee) &&
            receiverApp(callee.expression, apps, helperApp) !== null &&
            !ts.isStringLiteralLike(callee.argumentExpression) &&
            node.arguments.length >= 2
          ) {
            const line = lineOf(node)
            facts.push({
              kind: 'gap', reason: 'dynamic-dispatch', subject: `${file.path}:${line}`,
              detail: 'routes are registered in a loop or helper, so which ones exist depends on data read while the app runs',
              where: { file: file.path, line },
            })
          }

          if (ts.isPropertyAccessExpression(callee)) {
            const method = callee.name.text.toLowerCase()
            const receiver = receiverApp(callee.expression, apps, helperApp)
            const [first, ...rest] = node.arguments
            // Express's own rule: app.get('env') with one argument reads a
            // setting. A route needs a path and at least one handler.
            if (METHODS.has(method) && receiver !== null && first !== undefined && rest.length >= 1) {
              const line = lineOf(node)
              if (ts.isStringLiteralLike(first)) {
                const kind = apps.get(receiver)
                const prefix = prefixes.get(receiver) ?? (kind === 'router' ? inherited : undefined)
                const mounted = prefix !== undefined || kind === 'app'
                facts.push({
                  kind: 'route',
                  method: method === 'all' ? 'ALL' : method.toUpperCase(),
                  path: normalise(`${prefix ?? ''}${first.text}`),
                  middleware: middlewareOf(rest, src),
                  framework: 'express',
                  // A router whose mount we could not find has an unknown
                  // prefix. Scope it so two such routers sharing a path do not
                  // collide into one fabricated change.
                  ...(mounted ? {} : { scope: file.path }),
                  where: { file: file.path, line },
                })
                if (!mounted) {
                  facts.push({
                    kind: 'gap', reason: 'unresolved-route-prefix', subject: `${file.path}:${line}`,
                    detail: 'router is mounted elsewhere — the real path has a prefix I cannot see',
                    where: { file: file.path, line },
                  })
                }
              } else {
                facts.push({
                  kind: 'gap', reason: 'computed-route-path', subject: `${file.path}:${line}`,
                  detail: `${method.toUpperCase()} route path is built at runtime`,
                  where: { file: file.path, line },
                })
              }
            }
          }
        }
        ts.forEachChild(node, (c) => visit(c, helperApp))
      }
      visit(src, null)
    }
    return facts
  },
}

/** An identifier bound to an app or router, or `this` inside a helper on one. */
function receiverApp(
  expr: ts.Expression,
  apps: ReadonlyMap<string, 'app' | 'router'>,
  helperApp: string | null,
): string | null {
  if (ts.isIdentifier(expr)) return apps.has(expr.text) ? expr.text : null
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return helperApp
  return null
}

/**
 * Identifiers that are actually an Express app or router. Everything with a
 * `.get()` is not a route; most of them are maps, caches and header bags.
 */
function appBindings(src: ts.SourceFile): Map<string, 'app' | 'router'> {
  const out = new Map<string, 'app' | 'router'>()
  const kindOf = (init: ts.Expression): 'app' | 'router' | null => {
    let e = init
    // `var app = module.exports = express()` — look through the assignment.
    while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) e = e.right
    if (!ts.isCallExpression(e)) return null
    const callee = e.expression
    if (ts.isIdentifier(callee) && callee.text === 'express') return 'app'
    if (ts.isIdentifier(callee) && callee.text === 'Router') return 'router'
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router') return 'router'
    return null
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const kind = kindOf(node.initializer)
      if (kind !== null) out.set(node.name.text, kind)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  // `app` is conventional enough to accept without a local declaration; a file
  // that only receives it as a parameter is still defining real routes.
  if (!out.has('app')) out.set('app', 'app')
  return out
}

/** `app.use('/api', router)` → router carries the '/api' prefix. */
function mountPrefixes(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use' &&
      node.arguments.length >= 2
    ) {
      const [path, ...mounted] = node.arguments
      if (path !== undefined && ts.isStringLiteralLike(path)) {
        for (const arg of mounted) if (ts.isIdentifier(arg)) out.set(arg.text, path.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

/**
 * Maps a file to the full prefix its router is served under, following
 * `app.use('/api/v1', require('./routes/v1'))`, `import v1 from './v1'` plus
 * `app.use('/v1', v1)`, and nesting through routers that are themselves mounted.
 */
function crossFileMounts(files: readonly ParsedFile[]): Map<string, string> {
  const paths = new Set(files.map((f) => f.path))
  const edges: Array<{ parent: string; prefix: string; child: string }> = []

  for (const file of files) {
    const imports = new Map<string, string>()
    const resolve = (spec: string): string | null => resolveRelative(file.path, spec, paths)

    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const spec = requireSpec(node.initializer)
        const target = spec === null ? null : resolve(spec)
        if (target !== null) imports.set(node.name.text, target)
      }
      if (ts.isImportDeclaration(node) && node.importClause?.name !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = resolve(node.moduleSpecifier.text)
        if (target !== null) imports.set(node.importClause.name.text, target)
      }
      ts.forEachChild(node, collect)
    }
    collect(file.ast)

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use') {
        const args = [...node.arguments]
        const head = args[0]
        const prefix = head !== undefined && ts.isStringLiteralLike(head) ? head.text : null
        for (const arg of prefix === null ? args : args.slice(1)) {
          let child: string | null = null
          if (ts.isIdentifier(arg)) child = imports.get(arg.text) ?? null
          else {
            const spec = requireSpec(arg)
            child = spec === null ? null : resolve(spec)
          }
          if (child !== null && child !== file.path) edges.push({ parent: file.path, prefix: prefix ?? '', child })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file.ast)
  }

  const out = new Map<string, string>()
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (const { parent, prefix, child } of edges) {
      const full = normalise(`${out.get(parent) ?? ''}${prefix}`)
      const stored = full === '/' ? '' : full
      if (out.get(child) !== stored) { out.set(child, stored); changed = true }
    }
    if (!changed) break
  }
  return out
}

function requireSpec(expr: ts.Expression): string | null {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require') {
    const [arg] = expr.arguments
    if (arg !== undefined && ts.isStringLiteralLike(arg) && arg.text.startsWith('.')) return arg.text
  }
  return null
}

/** `./routes/v1`, `./routes/v1.js` (pointing at a .ts file), or a directory index. */
function resolveRelative(from: string, spec: string, paths: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const stem = base.replace(/\.(js|ts|mjs|cjs|jsx|tsx)$/, '')
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => `${stem}${ext}`),
    ...['/index.ts', '/index.js'].map((ext) => `${stem}${ext}`),
  ]
  return candidates.find((c) => paths.has(c)) ?? null
}

/**
 * Everything between the path and the final handler. Three states, never blank:
 * a blank cell reads as "no middleware", which is a lie when we simply could
 * not resolve the chain.
 */
function middlewareOf(args: readonly ts.Expression[], src: ts.SourceFile): Middleware {
  if (args.length <= 1) return []
  const chain = args.slice(0, -1)
  const names: string[] = []
  for (const arg of chain) {
    if (ts.isIdentifier(arg)) names.push(arg.text)
    else if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) names.push(`${arg.expression.text}()`)
    else if (ts.isPropertyAccessExpression(arg)) names.push(arg.getText(src))
    else return 'unresolved'
  }
  return names
}

/** `//a//b/` → `/a/b`; a trailing slash is not a different route. */
export function normalise(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}
