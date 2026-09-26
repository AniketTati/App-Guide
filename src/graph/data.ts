import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { ParsedFile } from '../extract/parse.js'
import { READ, WRITE } from '../extract/data.js'
import { importsOf, type Resolver } from './resolve.js'

type Route = Extract<Fact, { kind: 'route' }>

export interface DataUse { table: string; kind: 'write' | 'read'; line: number; file: string; via: string | null }

const CLIENTS = new Set(['prisma', 'db', 'tx', 'this.prisma', 'ctx.prisma', 'this.db', 'ctx.db'])

/**
 * The data each route's handler reads and changes: Prisma calls inside the
 * handler, transaction callbacks included, and one step into the functions it
 * calls. Deeper than that is where a static reader starts to guess.
 */
export function routeData(routes: readonly Route[], files: ReadonlyMap<string, ParsedFile>, r: Resolver): Map<Route, DataUse[]> {
  const out = new Map<Route, DataUse[]>()
  const handlers = new Map<string, ts.Node | null>()
  for (const route of routes) {
    const file = files.get(route.where.file)
    if (file === undefined) continue
    const key = `${route.where.file}:${route.where.line}`
    if (!handlers.has(key)) handlers.set(key, handlerAt(file, route.where.line))
    const handler = handlers.get(key)
    if (handler == null) continue
    const uses = prismaIn(handler, file, null)
    for (const fn of calledFunctions(handler, file, r)) uses.push(...prismaIn(fn.node, fn.file, fn.name))
    out.set(route, dedupe(uses))
  }
  return out
}

/** The handler of the route registered at this line: the last argument of
 *  `app.get(path, …, handler)`, or `handler` in `app.route({ … })`. */
function handlerAt(file: ParsedFile, line: number): ts.Node | null {
  const src = file.ast
  let found: ts.Node | null = null
  const visit = (n: ts.Node): void => {
    if (found !== null) return
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1 === line) {
      const last = n.arguments[n.arguments.length - 1]
      if (last !== undefined && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) { found = last; return }
      const spec = n.arguments.find(ts.isObjectLiteralExpression)
      for (const p of spec?.properties ?? []) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'handler' && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) { found = p.initializer; return }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return found
}

function prismaIn(node: ts.Node, file: ParsedFile, via: string | null): DataUse[] {
  const src = file.ast
  const out: DataUse[] = []
  const visit = (n: ts.Node, clients: ReadonlySet<string>): void => {
    // `prisma.$transaction(async (t) => …)`: inside, t is the client too.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction') {
      const [fn] = n.arguments
      const param = fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.parameters[0]?.name : undefined
      if (param !== undefined && ts.isIdentifier(param)) { ts.forEachChild(n, (c) => visit(c, new Set([...clients, param.text]))); return }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
      const op = n.expression.name.text
      const model = n.expression.expression.name.text
      const client = rootName(n.expression.expression.expression)
      if (clients.has(client) && !model.startsWith('$')) {
        const kind = WRITE.has(op) ? 'write' : READ.has(op) ? 'read' : null
        if (kind !== null) out.push({ table: model, kind, file: file.path, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, via })
      }
    }
    ts.forEachChild(n, (c) => visit(c, clients))
  }
  visit(node, CLIENTS)
  return out
}

/** Functions the handler calls that we can find: in its file, or imported
 *  from one of the project's own files. */
function calledFunctions(handler: ts.Node, file: ParsedFile, r: Resolver): { node: ts.Node; file: ParsedFile; name: string }[] {
  const imports = importsOf(file, r)
  const out: { node: ts.Node; file: ParsedFile; name: string }[] = []
  const seen = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !seen.has(n.expression.text)) {
      const name = n.expression.text
      seen.add(name)
      const local = functionNamed(file.ast, name)
      if (local !== undefined) out.push({ node: local, file, name })
      else {
        const imp = imports.get(name)
        const target = imp === undefined ? undefined : r.file(imp.path)
        const fn = target === undefined ? undefined : functionNamed(target.ast, imp!.name)
        if (target !== undefined && fn !== undefined) out.push({ node: fn, file: target, name })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(handler)
  return out
}

function functionNamed(src: ts.SourceFile, name: string): ts.Node | undefined {
  for (const s of src.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body !== undefined) return s.body
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer.body
    }
  }
  return undefined
}

const rootName = (e: ts.Expression): string =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${rootName(e.expression)}.${e.name.text}` : e.kind === ts.SyntaxKind.ThisKeyword ? 'this' : ''

function dedupe(uses: readonly DataUse[]): DataUse[] {
  const seen = new Set<string>()
  return uses.filter((u) => { const k = `${u.kind}:${u.table}`; if (seen.has(k)) return false; seen.add(k); return true })
}
