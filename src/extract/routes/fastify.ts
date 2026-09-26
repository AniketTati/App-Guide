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
/** Methods on a reply that end a request without the handler's answer. */
const REFUSING_REPLIES = new Set(['unauthorized', 'forbidden', 'notFound', 'badRequest', 'redirect'])
/** A check written inside a handler: an explicit 401 or 403; or a 404 decided
 *  by a lookup that is handed the caller — `if (!await mayTouch(req, id))
 *  return 404` is how "only your own" is written. A 404 for a missing row, a
 *  400 for bad input, is the handler's own work. */
const HANDLER_REFUSALS = new Set([401, 403])
const IN_HANDLER = 'in-handler check'

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

interface FileIndex {
  file: ParsedFile
  /** Functions defined anywhere in the file, by name. */
  locals: Map<string, Fn>
  /** Exported functions by exported name; 'default' for the default export. */
  exported: Map<string, Fn>
  /** Exported constants by name: `export const ownScopeContractGuard = …`. */
  exportedConsts: Map<string, ts.Expression>
  /** Local name -> the relative module and name it was imported from. */
  imports: Map<string, { path: string; name: string }>
  /** Local names imported from a package (a library, never ours to read). */
  packages: Set<string>
  /** Local names bound to the Fastify factory. */
  factories: Set<string>
  /** Local names bound to fastify-plugin, which shares its parent's context. */
  sharers: Set<string>
}

/** How to read a name where it appears: a helper's parameters bound to what
 *  its caller passed, then the constants in scope. */
interface Env {
  idx: FileIndex
  bindings: ReadonlyMap<string, { expr: ts.Expression; env: Env }>
  consts: (name: string) => ts.Expression | undefined
}

/** A check installed by an `onRoute` hook: it is added to every route
 *  registered after it, in its plugin and below, whose URL matches. */
interface RouteGuard { checks: readonly string[]; pattern: RegExp | null }

interface Scope {
  prefix: string
  /** Checks inherited from enclosing plugins. The app's own hooks are left out,
   *  as Express's app-wide middleware is: they run for every route, so they
   *  cannot tell one route from another. */
  hooks: readonly string[]
  /** onRoute guards in force. Shared with helpers called on the same
   *  instance; copied for child plugins, which inherit what came before. */
  guards: RouteGuard[]
  root: boolean
  /** Where the prefix could not be followed — the route is scoped to its file. */
  unmounted: boolean
}

type Verdict = 'refuses' | 'passes' | 'unknown'

/**
 * Fastify: `app.register(plugin, { prefix })` resolved across files, routes as
 * `app.get(path, [options], handler)` or `app.route({ method, url })`, and the
 * checks that run before each one.
 *
 * A check is a hook whose code can refuse the request — a 4xx, a throw, an
 * error passed to `done` — followed through the functions it calls. A hook
 * whose code is read and cannot refuse (one that only records, say) is not a
 * check. A hook we cannot read, from a package, still counts: dropping it would
 * turn "a check we cannot see into" into "no check found".
 */
export const fastify: RouteDetector = {
  name: 'fastify',
  packages: ['fastify'],
  detect({ files }) {
    const facts: Fact[] = []
    // Tests build the app too — at other prefixes, or twice.
    const sources = files.filter((f) => !isTestFile(f.path))
    const paths = new Set(sources.map((f) => f.path))
    const index = new Map(sources.map((f) => [f.path, indexFile(f, paths)]))
    const reached = new Set<Fn>()
    const verdicts = new Map<Fn, Verdict>()

    const lineOf = (idx: FileIndex, n: ts.Node): number =>
      idx.file.ast.getLineAndCharacterOfPosition(n.getStart(idx.file.ast)).line + 1
    const gap = (idx: FileIndex, n: ts.Node, reason: 'dynamic-dispatch' | 'computed-route-path' | 'unresolved-route-prefix', detail: string): void => {
      const line = lineOf(idx, n)
      facts.push({ kind: 'gap', reason, subject: `${idx.file.path}:${line}`, detail, where: { file: idx.file.path, line } })
    }

    /** A function wherever it is defined; 'package' if it is a library's. */
    const resolveFn = (idx: FileIndex, name: string): { idx: FileIndex; fn: Fn } | 'package' | null => {
      const local = idx.locals.get(name)
      if (local !== undefined) return { idx, fn: local }
      if (idx.packages.has(name)) return 'package'
      const imported = idx.imports.get(name)
      if (imported === undefined) return null
      const target = index.get(imported.path)
      const fn = target?.exported.get(imported.name)
      return target !== undefined && fn !== undefined ? { idx: target, fn } : null
    }
    /** An imported constant: `import { ownScopeContractGuard } from '../lib/…'`. */
    const importedConst = (idx: FileIndex, name: string): { idx: FileIndex; expr: ts.Expression } | null => {
      const imported = idx.imports.get(name)
      const target = imported === undefined ? undefined : index.get(imported.path)
      const expr = target?.exportedConsts.get(imported!.name)
      return target !== undefined && expr !== undefined ? { idx: target, expr } : null
    }
    const envFor = (idx: FileIndex, body: ts.Node, bindings: ReadonlyMap<string, { expr: ts.Expression; env: Env }> = new Map()): Env =>
      ({ idx, bindings, consts: constants(body, idx.file.ast) })

    /** Follow a name to the expression it stands for, as far as the code says. */
    const deref = (expr: ts.Expression, env: Env, depth = 0): { expr: ts.Expression; env: Env } => {
      const e = unwrap(expr)
      if (!ts.isIdentifier(e) || depth > 6) return { expr: e, env }
      const bound = env.bindings.get(e.text)
      if (bound !== undefined) return deref(bound.expr, bound.env, depth + 1)
      const local = env.consts(e.text)
      if (local !== undefined && !ts.isArrowFunction(unwrap(local)) && !ts.isFunctionExpression(unwrap(local))) return deref(local, env, depth + 1)
      const imported = importedConst(env.idx, e.text)
      if (imported !== null) return deref(imported.expr, envFor(imported.idx, imported.idx.file.ast), depth + 1)
      return { expr: e, env }
    }

    /** Can this function's code refuse a request? Followed through what it calls. */
    const verdictOf = (idx: FileIndex, fn: Fn, depth: number): Verdict => {
      const memo = verdicts.get(fn)
      if (memo !== undefined) return memo
      if (depth > 4) return 'unknown'
      verdicts.set(fn, 'passes') // a cycle adds nothing
      const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''))
      // A callback hook refuses by calling `done(err)`.
      const done = fn.parameters.length >= 3 ? params[2] : undefined
      let result: Verdict = 'passes'
      const note = (v: Verdict): void => { if (v === 'refuses' || (v === 'unknown' && result === 'passes')) result = v }
      const visit = (node: ts.Node): void => {
        if (result === 'refuses') return
        if (ts.isThrowStatement(node)) { result = 'refuses'; return }
        if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression)
          if (ts.isPropertyAccessExpression(callee)) {
            const name = callee.name.text
            const [first] = node.arguments
            if ((name === 'status' || name === 'code') && first !== undefined && ts.isNumericLiteral(first)) {
              const code = Number(first.text)
              if (code >= 400 && code < 500) { result = 'refuses'; return }
            }
            if (REFUSING_REPLIES.has(name)) { result = 'refuses'; return }
            const root = rootIdentifier(callee)
            if (root !== null && idx.packages.has(root) && passesRequest(node, params)) note('unknown')
          } else if (ts.isIdentifier(callee)) {
            if (done !== undefined && callee.text === done) {
              const [arg] = node.arguments
              if (arg !== undefined && !isNothing(arg)) { result = 'refuses'; return }
            } else {
              const target = resolveFn(idx, callee.text)
              if (target === 'package') { if (passesRequest(node, params)) note('unknown') }
              else if (target !== null) {
                // `recordingModelOutput(done)`: the callback is passed on, so it
                // is read under the name it has there.
                note(verdictOf(target.idx, target.fn, depth + 1))
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      if (fn.body !== undefined) visit(fn.body)
      verdicts.set(fn, result)
      return result
    }

    /** A check as written, and whether its code can refuse. */
    const checksOf = (expr: ts.Expression, hook: string, env: Env, depth = 0): { name: string; verdict: Verdict }[] | null => {
      const e = unwrap(expr)
      if (depth > 6) return null
      if (ts.isArrayLiteralExpression(e)) {
        const out: { name: string; verdict: Verdict }[] = []
        for (const el of e.elements) {
          if (ts.isSpreadElement(el)) return null
          const inner = checksOf(el, hook, env, depth)
          if (inner === null) return null
          out.push(...inner)
        }
        return out
      }
      if (ts.isConditionalExpression(e)) {
        const test = evaluate(e.condition, env)
        if (test !== undefined) return checksOf(test ? e.whenTrue : e.whenFalse, hook, env, depth + 1)
        return null
      }
      if (ts.isIdentifier(e)) {
        const target = deref(e, env)
        if (target.expr !== e) return checksOf(target.expr, hook, target.env, depth + 1)
        const fn = resolveFn(env.idx, e.text)
        const verdict: Verdict = fn === null || fn === 'package' ? 'unknown' : verdictOf(fn.idx, fn.fn, 0)
        return [{ name: e.text, verdict }]
      }
      if (ts.isPropertyAccessExpression(e)) return [{ name: e.getText(env.idx.file.ast), verdict: 'unknown' }]
      if (ts.isCallExpression(e)) {
        // A factory: `requirePermission('approve', 'approval')` returns the hook.
        const callee = unwrap(e.expression)
        const fn = ts.isIdentifier(callee) ? resolveFn(env.idx, callee.text) : null
        const verdict: Verdict = fn === null || fn === 'package' ? 'unknown' : verdictOf(fn.idx, fn.fn, 0)
        return [{ name: e.getText(env.idx.file.ast).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/,?\s+\)/g, ')'), verdict }]
      }
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return [{ name: `inline ${hook}`, verdict: verdictOf(env.idx, e, 0) }]
      return null
    }
    /** The names of the checks that can refuse, or null if one cannot be named. */
    const named = (expr: ts.Expression, hook: string, env: Env): string[] | null => {
      const found = checksOf(expr, hook, env)
      return found === null ? null : found.filter((c) => c.verdict !== 'passes').map((c) => c.name)
    }

    /** `if (!pattern.test(route.url)) return` at the top of an onRoute hook. */
    const guardOf = (fn: Fn, env: Env): RouteGuard | null => {
      const route = fn.parameters[0]?.name
      if (route === undefined || !ts.isIdentifier(route) || fn.body === undefined || !ts.isBlock(fn.body)) return null
      let pattern: RegExp | null = null
      const checks: string[] = []
      for (const stmt of fn.body.statements) {
        if (ts.isIfStatement(stmt) && ts.isPrefixUnaryExpression(stmt.expression) && stmt.expression.operator === ts.SyntaxKind.ExclamationToken) {
          const test = unwrap(stmt.expression.operand)
          if (ts.isCallExpression(test) && ts.isPropertyAccessExpression(test.expression) && test.expression.name.text === 'test') {
            const re = deref(test.expression.expression, env).expr
            if (ts.isRegularExpressionLiteral(re)) {
              const m = /^\/(.*)\/([a-z]*)$/s.exec(re.text)
              if (m !== null) { try { pattern = new RegExp(m[1]!, m[2]) } catch { return null } }
            } else return null
          }
        }
        // `route.preHandler = [...existing, guard]` or `route.preHandler.push(guard)`.
        const visit = (node: ts.Node): void => {
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && node.left.expression.text === route.text &&
              CHECK_HOOKS.has(node.left.name.text)) {
            const value = unwrap(node.right)
            const added = ts.isArrayLiteralExpression(value) ? value.elements.filter((el) => !ts.isSpreadElement(el)) : [value]
            for (const a of added) checks.push(...(named(a, node.left.name.text, env) ?? [`${node.left.name.text} hook`]))
          }
          ts.forEachChild(node, visit)
        }
        visit(stmt)
      }
      return checks.length > 0 ? { checks, pattern } : null
    }

    const walk = (env: Env, body: ts.Node, instances: ReadonlySet<string>, scope: Scope, stack: readonly Fn[]): void => {
      if (stack.length > 12) return
      const idx = env.idx
      const own = scope.root ? [] : localHooks(body, instances, (expr, hook) => named(expr, hook, env))
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
            if (name === 'register') { register(env, node, scope, checks, stack); return }
            if (name === 'route') { routeObject(env, node, scope, checks); return }
            if (name === 'addHook') {
              const [hook, fn] = node.arguments
              if (hook !== undefined && ts.isStringLiteralLike(hook) && hook.text === 'onRoute' && fn !== undefined) {
                const target = unwrap(fn)
                const hookFn = ts.isArrowFunction(target) || ts.isFunctionExpression(target) ? target : null
                const guard = hookFn === null ? null : guardOf(hookFn, env)
                if (guard !== null) scope.guards.push(guard)
              }
              return
            }
            if (METHODS.has(name.toLowerCase()) && node.arguments.length >= 2) { shorthand(env, node, name.toLowerCase(), scope, checks); return }
          } else if (ts.isIdentifier(callee) && node.arguments.some((a) => isInstance(a, aliases))) {
            // `guardOwnScopeRoutes(app, /\/:id/, guard)`: a helper working on
            // the instance it is given, in this same plugin — read at every
            // call, with its parameters bound to what this call passes.
            const helper = resolveFn(idx, callee.text)
            if (helper !== null && helper !== 'package' && !stack.includes(helper.fn) && helper.fn.body !== undefined) {
              const at = node.arguments.findIndex((a) => isInstance(a, aliases))
              const param = helper.fn.parameters[at]?.name
              if (param !== undefined && ts.isIdentifier(param)) {
                const bindings = new Map<string, { expr: ts.Expression; env: Env }>()
                helper.fn.parameters.forEach((p, i) => {
                  if (!ts.isIdentifier(p.name) || i === at) return
                  const arg = node.arguments[i]
                  if (arg !== undefined) bindings.set(p.name.text, { expr: arg, env })
                  else if (p.initializer !== undefined) bindings.set(p.name.text, { expr: p.initializer, env: envFor(helper.idx, helper.fn) })
                })
                reached.add(helper.fn)
                walk(envFor(helper.idx, helper.fn.body, bindings), helper.fn.body, new Set([param.text]),
                  { ...scope, hooks: checks, root: false }, [...stack, helper.fn])
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(body)
    }

    const register = (env: Env, call: ts.CallExpression, scope: Scope, checks: readonly string[], stack: readonly Fn[]): void => {
      const idx = env.idx
      const [target, options] = call.arguments
      if (target === undefined) return
      const opts = options !== undefined && ts.isObjectLiteralExpression(options) ? options : undefined
      const prefixProp = opts === undefined ? undefined : property(opts, 'prefix')
      const prefixValue = prefixProp === undefined ? undefined : deref(prefixProp, env).expr
      const known = prefixProp === undefined || (prefixValue !== undefined && ts.isStringLiteralLike(prefixValue))
      const child = (fn: Fn, where: FileIndex, shared: boolean): void => {
        if (stack.includes(fn)) return
        reached.add(fn)
        const param = fn.parameters[0]?.name
        if (param === undefined || !ts.isIdentifier(param) || fn.body === undefined) return
        if (!known) gap(idx, call, 'unresolved-route-prefix', 'this plugin is mounted at a prefix computed while the app runs, so its full paths are not known')
        const own = prefixValue !== undefined && ts.isStringLiteralLike(prefixValue) ? prefixValue.text : ''
        walk(envFor(where, fn.body), fn.body, new Set([param.text]), {
          // fastify-plugin shares the parent's context, prefix included.
          prefix: shared ? scope.prefix : `${scope.prefix}${own}`,
          hooks: checks,
          guards: shared ? scope.guards : [...scope.guards],
          root: false,
          unmounted: scope.unmounted || !known,
        }, [...stack, fn])
      }

      let expr: ts.Expression = unwrap(target)
      let shared = false
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && idx.sharers.has(expr.expression.text) && expr.arguments[0] !== undefined) {
        shared = true
        expr = unwrap(expr.arguments[0])
      }
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return child(expr, idx, shared)
      if (ts.isIdentifier(expr)) {
        const found = resolveFn(idx, expr.text)
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

    const emit = (env: Env, node: ts.Node, method: string, path: string, scope: Scope, middleware: Middleware, handler: ts.Expression | undefined): void => {
      const full = normalise(`${scope.prefix}${path}`)
      let checks: Middleware = middleware
      if (checks !== 'unresolved') {
        const guarded = scope.guards.filter((g) => g.pattern === null || g.pattern.test(full)).flatMap((g) => g.checks)
        const inside = handler !== undefined && refusesInHandler(handler, env) ? [IN_HANDLER] : []
        checks = [...checks, ...guarded, ...inside]
      }
      facts.push({
        kind: 'route',
        method: method === 'all' ? 'ALL' : method.toUpperCase(),
        path: full,
        middleware: checks,
        framework: 'fastify',
        ...(scope.unmounted ? { scope: env.idx.file.path } : {}),
        where: { file: env.idx.file.path, line: lineOf(env.idx, node) },
      })
    }

    /** An explicit 401/403 in the handler, or in a function it calls. */
    const refusesInHandler = (handler: ts.Expression, env: Env): boolean => {
      const target = deref(handler, env).expr
      const fn = ts.isArrowFunction(target) || ts.isFunctionExpression(target) ? { idx: env.idx, fn: target as Fn }
        : ts.isIdentifier(target) ? resolveFn(env.idx, target.text) : null
      if (fn === null || fn === 'package' || fn.fn.body === undefined) return false
      const param = fn.fn.parameters[0]?.name
      const caller = param !== undefined && ts.isIdentifier(param) ? param.text : null
      const scan = (where: FileIndex, body: ts.Node, depth: number): boolean => {
        let found = false
        const visit = (node: ts.Node): void => {
          if (found) return
          if (depth === 0 && caller !== null && ts.isIfStatement(node) && handsOverCaller(node.expression, caller, fn.idx) && notFound(node.thenStatement)) { found = true; return }
          if (ts.isCallExpression(node)) {
            const callee = unwrap(node.expression)
            if (ts.isPropertyAccessExpression(callee)) {
              const [first] = node.arguments
              if ((callee.name.text === 'status' || callee.name.text === 'code') && first !== undefined && ts.isNumericLiteral(first) && HANDLER_REFUSALS.has(Number(first.text))) { found = true; return }
              if (callee.name.text === 'unauthorized' || callee.name.text === 'forbidden') { found = true; return }
            } else if (ts.isIdentifier(callee) && depth < 1) {
              const inner = resolveFn(where, callee.text)
              if (inner !== null && inner !== 'package' && inner.fn.body !== undefined && scan(inner.idx, inner.fn.body, depth + 1)) { found = true; return }
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(body)
        return found
      }
      return scan(fn.idx, fn.fn.body, 0)
    }

    /**
     * A call in `cond` that learns who is calling: given the caller's own
     * identity from the request (`req.user.sub` — never their organisation,
     * which every lookup is scoped by), or given the request whole and, up to
     * two calls deep, reading that identity from it. A lookup handed the
     * request that only reads its address is not a check.
     */
    const handsOverCaller = (cond: ts.Expression, caller: string, idx: FileIndex): boolean => {
      let yes = false
      const visit = (n: ts.Node): void => {
        if (yes) return
        if (ts.isCallExpression(n)) {
          if (n.arguments.some((a) => identityOf(unwrap(a), caller, idx.file.ast))) { yes = true; return }
          const at = n.arguments.findIndex((a) => { const x = unwrap(a); return ts.isIdentifier(x) && x.text === caller })
          if (at !== -1 && readsCallerThrough(n, at, idx, 0)) { yes = true; return }
        }
        ts.forEachChild(n, visit)
      }
      visit(cond)
      return yes
    }

    /** `req.user.sub`, `req.user.id` — the caller's identity, not their organisation. */
    const identityOf = (e: ts.Expression, caller: string, src: ts.SourceFile): boolean => {
      if (!ts.isPropertyAccessExpression(e)) return false
      const chain = e.getText(src).replace(/\s+/g, '').split('.')
      return chain[0] === caller && chain[1] === 'user' && chain.length >= 3 && !chain.slice(2).some((seg) => /org|tenant|workspace|team/i.test(seg))
    }

    /** Whether the function a call reaches reads the caller's identity from
     *  the argument at `at`. */
    const readsCallerThrough = (call: ts.CallExpression, at: number, idx: FileIndex, depth: number): boolean => {
      const callee = unwrap(call.expression)
      if (!ts.isIdentifier(callee) || depth > 2) return false
      const inner = resolveFn(idx, callee.text)
      if (inner === null || inner === 'package' || inner.fn.body === undefined) return false
      const p = inner.fn.parameters[at]?.name
      if (p === undefined || !ts.isIdentifier(p)) return false
      const param = p.text
      const src = inner.idx.file.ast
      let yes = false
      const visit = (n: ts.Node): void => {
        if (yes) return
        if (ts.isPropertyAccessExpression(n) && identityOf(n, param, src)) { yes = true; return }
        // const { sub, role } = req.user
        if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined
          && unwrap(n.initializer).getText(src).replace(/\s+/g, '') === `${param}.user`
          && n.name.elements.some((el) => !/org|tenant|workspace|team/i.test((el.propertyName ?? el.name).getText(src)))) { yes = true; return }
        if (ts.isCallExpression(n)) {
          const next = n.arguments.findIndex((a) => { const x = unwrap(a); return ts.isIdentifier(x) && x.text === param })
          if (next !== -1 && readsCallerThrough(n, next, inner.idx, depth + 1)) { yes = true; return }
        }
        ts.forEachChild(n, visit)
      }
      visit(inner.fn.body)
      return yes
    }

    const notFound = (stmt: ts.Node): boolean => {
      let yes = false
      const visit = (n: ts.Node): void => {
        if (yes) return
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression)
          const [first] = n.arguments
          if (ts.isPropertyAccessExpression(callee) && (((callee.name.text === 'status' || callee.name.text === 'code') && first !== undefined && ts.isNumericLiteral(first) && Number(first.text) === 404) || callee.name.text === 'notFound')) { yes = true; return }
        }
        ts.forEachChild(n, visit)
      }
      visit(stmt)
      return yes
    }

    const shorthand = (env: Env, call: ts.CallExpression, method: string, scope: Scope, checks: readonly string[]): void => {
      const [path, ...rest] = call.arguments
      if (path === undefined) return
      if (!ts.isStringLiteralLike(path)) {
        gap(env.idx, call, 'computed-route-path', `${method.toUpperCase()} route path is built at runtime`)
        return
      }
      // `app.get(path, handler)`, `app.get(path, options, handler)`, or
      // `app.get(path, { preHandler, handler })`.
      const first = rest[0]
      const opts = first !== undefined && ts.isObjectLiteralExpression(first) && (rest.length >= 2 || property(first, 'handler') !== undefined) ? first : undefined
      const handler = (opts === undefined ? undefined : property(opts, 'handler')) ?? (rest.length >= 2 || opts === undefined ? rest[rest.length - 1] : undefined)
      emit(env, call, method, path.text, scope, combine(checks, opts === undefined ? [] : routeHooks(opts, (e, h) => named(e, h, env))), handler)
    }

    const routeObject = (env: Env, call: ts.CallExpression, scope: Scope, checks: readonly string[]): void => {
      const [spec] = call.arguments
      if (spec === undefined || !ts.isObjectLiteralExpression(spec)) {
        gap(env.idx, call, 'dynamic-dispatch', 'a route is defined from a value built while the app runs')
        return
      }
      const method = property(spec, 'method')
      const url = property(spec, 'url') ?? property(spec, 'path')
      const methods = method === undefined ? [] : ts.isStringLiteralLike(method) ? [method.text]
        : ts.isArrayLiteralExpression(method) && method.elements.every(ts.isStringLiteralLike) ? method.elements.map((e) => (e as ts.StringLiteralLike).text) : null
      if (methods === null || methods.length === 0 || url === undefined || !ts.isStringLiteralLike(url)) {
        gap(env.idx, call, url !== undefined && !ts.isStringLiteralLike(url) ? 'computed-route-path' : 'dynamic-dispatch',
          'a route\'s method or path is decided while the app runs')
        return
      }
      const middleware = combine(checks, routeHooks(spec, (e, h) => named(e, h, env)))
      for (const m of methods) emit(env, call, m.toLowerCase(), url.text, scope, middleware, property(spec, 'handler'))
    }

    // From every place the app is created.
    for (const idx of index.values()) {
      for (const { scope, name } of roots(idx)) {
        walk(envFor(idx, scope), scope, new Set([name]), { prefix: '', hooks: [], guards: [], root: true, unmounted: false }, [])
      }
    }

    // Plugins nothing we can see registers — mounted by code we cannot follow,
    // or only by tests. Their routes are real, with a prefix we do not know.
    for (const idx of index.values()) {
      for (const fn of new Set(idx.locals.values())) {
        if (reached.has(fn) || !looksLikePlugin(fn)) continue
        reached.add(fn)
        const param = fn.parameters[0]!.name as ts.Identifier
        const before = facts.length
        walk(envFor(idx, fn.body!), fn.body!, new Set([param.text]), { prefix: '', hooks: [], guards: [], root: false, unmounted: true }, [fn])
        if (facts.slice(before).some((f) => f.kind === 'route')) {
          gap(idx, fn, 'unresolved-route-prefix', 'these routes are registered by code I cannot follow, so their full paths have a prefix I cannot see')
        }
      }
    }
    return facts
  },
}

function indexFile(file: ParsedFile, paths: ReadonlySet<string>): FileIndex {
  const idx: FileIndex = {
    file, locals: new Map(), exported: new Map(), exportedConsts: new Map(), imports: new Map(),
    packages: new Set(), factories: new Set(), sharers: new Set(),
  }
  const src = file.ast
  const modifiers = (n: ts.Node): readonly ts.ModifierLike[] => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [])
  const isExported = (n: ts.Node): boolean => modifiers(n).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const isDefault = (n: ts.Node): boolean => modifiers(n).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
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
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) idx.exportedConsts.set(decl.name.text, decl.initializer)
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

/** A function that registers routes on its first parameter. */
function looksLikePlugin(fn: Fn): boolean {
  const param = fn.parameters[0]
  if (param === undefined || !ts.isIdentifier(param.name) || fn.body === undefined) return false
  const name = param.name.text
  let routes = false
  const visit = (node: ts.Node): void => {
    if (routes) return
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === name && (METHODS.has(node.expression.name.text) || node.expression.name.text === 'route') && node.arguments.length >= 1) routes = true
    else ts.forEachChild(node, visit)
  }
  visit(fn.body)
  // A helper that only adds hooks is not a plugin with routes of its own.
  return routes
}

function isInstance(expr: ts.Expression, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expr)) return names.has(expr.text)
  // `app.withTypeProvider<T>()` returns the same instance, typed.
  return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'withTypeProvider' && isInstance(expr.expression.expression, names)
}

/** `instance.addHook('preHandler', check)` directly inside this plugin. */
function localHooks(body: ts.Node, instances: ReadonlySet<string>, name: (e: ts.Expression, hook: string) => string[] | null): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addHook' && isInstance(node.expression.expression, instances)) {
      const [hook, fn] = node.arguments
      if (hook !== undefined && ts.isStringLiteralLike(hook) && CHECK_HOOKS.has(hook.text) && fn !== undefined) {
        const names = name(fn, hook.text)
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
function routeHooks(opts: ts.ObjectLiteralExpression, name: (e: ts.Expression, hook: string) => string[] | null): string[] | null {
  const out: string[] = []
  for (const hook of CHECK_HOOKS) {
    const value = property(opts, hook)
    if (value === undefined) continue
    const names = name(value, hook)
    if (names === null) return null
    out.push(...names)
  }
  return out
}

/**
 * `const adminGuard = requirePermission('configure', 'user')`: a check is often
 * given a short name first. The plugin's own constants first, then the file's.
 * A name declared twice in the same place is not followed.
 */
function constants(body: ts.Node, src: ts.SourceFile): (name: string) => ts.Expression | undefined {
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

/** A literal comparison we can decide from the code: `param === 'id'`. */
function evaluate(expr: ts.Expression, env: Env): boolean | undefined {
  const e = unwrap(expr)
  if (!ts.isBinaryExpression(e)) return undefined
  const op = e.operatorToken.kind
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined
  const value = (x: ts.Expression): string | undefined => {
    let v = unwrap(x)
    for (let i = 0; i < 6 && ts.isIdentifier(v); i++) {
      const bound = env.bindings.get(v.text)
      if (bound === undefined) break
      v = unwrap(bound.expr)
      if (ts.isIdentifier(v)) { const again = bound.env.bindings.get(v.text); if (again !== undefined) { v = unwrap(again.expr) } }
    }
    return ts.isStringLiteralLike(v) ? v.text : undefined
  }
  const a = value(e.left), b = value(e.right)
  if (a === undefined || b === undefined) return undefined
  return op === ts.SyntaxKind.EqualsEqualsEqualsToken ? a === b : a !== b
}

/** `x as any`, `(x)`, `x!`, `x satisfies T` are all still x. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) e = e.expression
  return e
}

const rootIdentifier = (expr: ts.Expression): string | null =>
  ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? rootIdentifier(expr.expression) : null

/** Whether a call hands on the request, the reply or the callback. */
function passesRequest(call: ts.CallExpression, params: readonly string[]): boolean {
  return call.arguments.some((a) => ts.isIdentifier(a) && params.includes(a.text))
}

const isNothing = (e: ts.Expression): boolean =>
  e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')

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
