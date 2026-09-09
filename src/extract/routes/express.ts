import { ts } from 'ts-morph'
import type { Fact, Middleware } from '../../model/facts.js'
import type { RouteDetector } from './types.js'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

/**
 * Syntactic detection: `app.get('/x', auth, handler)` and `router.post(...)`.
 * Prefix mounting via `app.use('/api', router)` is resolved one level, which
 * covers the common shape; anything computed is reported as a gap rather than
 * guessed at.
 */
export const express: RouteDetector = {
  name: 'express',
  packages: ['express', '@types/express'],
  detect({ files }) {
    const facts: Fact[] = []
    for (const file of files) {
      const src = file.ast
      const prefixes = mountPrefixes(src)
      const apps = appBindings(src)
      if (apps.size === 0) continue

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text.toLowerCase()
          const receiver = objectName(node.expression)
          const [first, ...rest] = node.arguments
          // Without this check, `req.get('Authorization')` — Express's own
          // header API — becomes a route with no middleware and lands straight
          // in the top block. So does cache.get, searchParams.get, redis.get.
          if (METHODS.has(method) && first !== undefined && apps.has(receiver)) {
            const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
            if (ts.isStringLiteralLike(first)) {
              const prefix = prefixes.get(receiver)
              const mounted = prefix !== undefined || apps.get(receiver) === 'app'
              facts.push({
                kind: 'route',
                method: method === 'all' ? 'ALL' : method.toUpperCase(),
                path: normalise(`${prefix ?? ''}${first.text}`),
                middleware: middlewareOf(rest, src),
                framework: 'express',
                // A router mounted in another file has an unknown prefix. Two
                // such routers can legitimately share a path, so scope them by
                // the file that defines them.
                ...(mounted ? {} : { scope: file.path }),
                where: { file: file.path, line },
              })
              if (!mounted) {
                facts.push({
                  kind: 'gap', reason: 'computed-route-path', subject: `${file.path}:${line}`,
                  detail: 'router is mounted elsewhere — the real path has a prefix I cannot see',
                  where: { file: file.path, line },
                })
              }
            } else if (rest.length > 0) {
              // A computed path is a route we know exists and cannot name.
              facts.push({
                kind: 'gap', reason: 'computed-route-path', subject: `${file.path}:${line}`,
                detail: `${method.toUpperCase()} route path is built at runtime`,
                where: { file: file.path, line },
              })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(src)
    }
    return facts
  },
}

/**
 * Identifiers that are actually an Express app or router. Everything with a
 * `.get()` is not a route; most of them are maps, caches and header bags.
 */
function appBindings(src: ts.SourceFile): Map<string, 'app' | 'router'> {
  const out = new Map<string, 'app' | 'router'>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const init = node.initializer
      if (ts.isCallExpression(init)) {
        const callee = init.expression
        if (ts.isIdentifier(callee) && callee.text === 'express') out.set(node.name.text, 'app')
        else if (ts.isIdentifier(callee) && callee.text === 'Router') out.set(node.name.text, 'router')
        else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router') out.set(node.name.text, 'router')
      }
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

const objectName = (expr: ts.PropertyAccessExpression): string =>
  ts.isIdentifier(expr.expression) ? expr.expression.text : ''

/** `//a//b/` → `/a/b`; a trailing slash is not a different route. */
export function normalise(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}
