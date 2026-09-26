import { ts } from 'ts-morph'
import type { ParsedFile } from '../extract/parse.js'
import { importsOf, type Resolver } from './resolve.js'

type Where = { file: string; line: number }

export interface Queue {
  name: string
  declared: Where
  /** Each kind of job put on it, and every place that puts it there. */
  jobs: { name: string; addedAt: Where[] }[]
  /** Where the work is done. */
  workers: Where[]
  /** Jobs that repeat on a schedule. */
  repeats: Where[]
}

export interface Background {
  queues: Queue[]
  /** Timers started when the app starts: `setInterval` at a module's top. */
  timers: Where[]
  /** Live connections the app serves: a WebSocket or collaboration server. */
  sockets: (Where & { library: string })[]
}

const QUEUE_LIBS = new Set(['bullmq', 'bull', 'bee-queue'])
const SOCKET_LIBS: Record<string, string> = { '@hocuspocus/server': 'Server', ws: 'WebSocketServer', 'socket.io': 'Server' }

/**
 * Work the product does away from any screen: job queues, what puts work on
 * them and what does it, repeating jobs, timers, and live-connection servers.
 * Recognised by where a name was imported from — `Worker` from bullmq is a
 * job worker, `Worker` from worker_threads is not.
 */
export function readBackground(files: readonly ParsedFile[], r: Resolver): Background {
  const queues = new Map<string, Queue>()
  // (file, local name) -> queue name, for every queue binding we can see.
  const bindings = new Map<string, string>()
  const lineOf = (f: ParsedFile, n: ts.Node): number => f.ast.getLineAndCharacterOfPosition(n.getStart(f.ast)).line + 1

  // First pass: queues declared with a literal name.
  for (const f of files) {
    const lib = namesFrom(f, QUEUE_LIBS)
    if (lib.size === 0) continue
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && ts.isNewExpression(n.initializer)) {
        const ctor = n.initializer.expression
        const [first] = n.initializer.arguments ?? []
        if (ts.isIdentifier(ctor) && lib.get(ctor.text) === 'Queue' && first !== undefined && ts.isStringLiteralLike(first)) {
          if (!queues.has(first.text)) queues.set(first.text, { name: first.text, declared: { file: f.path, line: lineOf(f, n) }, jobs: [], workers: [], repeats: [] })
          bindings.set(`${f.path}\u0000${n.name.text}`, first.text)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(f.ast)
  }

  const queueOf = (f: ParsedFile, imports: ReturnType<typeof importsOf>, expr: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(expr)) return queues.has(expr.text) ? expr.text : null
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'name') return queueOf(f, imports, expr.expression)
    if (!ts.isIdentifier(expr)) return null
    const local = bindings.get(`${f.path}\u0000${expr.text}`)
    if (local !== undefined) return local
    const imp = imports.get(expr.text)
    return imp === undefined ? null : bindings.get(`${imp.path}\u0000${imp.name}`) ?? null
  }

  const timers: Where[] = []
  const sockets: Background['sockets'] = []
  for (const f of files) {
    const lib = namesFrom(f, QUEUE_LIBS)
    const imports = importsOf(f, r)
    const socketNames = new Map<string, string>()
    for (const [pkg, exported] of Object.entries(SOCKET_LIBS)) for (const [local, name] of namesFrom(f, new Set([pkg]))) if (name === exported) socketNames.set(local, pkg)

    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
        const [first] = n.arguments ?? []
        if (lib.get(n.expression.text) === 'Worker' && first !== undefined) {
          const q = queueOf(f, imports, first)
          if (q !== null) queues.get(q)!.workers.push({ file: f.path, line: lineOf(f, n) })
        }
        const pkg = socketNames.get(n.expression.text)
        if (pkg !== undefined) sockets.push({ file: f.path, line: lineOf(f, n), library: pkg })
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text
        const q = method === 'add' || method === 'addBulk' || method === 'upsertJobScheduler' ? queueOf(f, imports, n.expression.expression) : null
        if (q !== null) {
          const queue = queues.get(q)!
          const where = { file: f.path, line: lineOf(f, n) }
          const [name, , opts] = n.arguments
          if (method === 'upsertJobScheduler' || (opts !== undefined && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'repeat'))) queue.repeats.push(where)
          const jobName = name !== undefined && ts.isStringLiteralLike(name) ? name.text : method === 'addBulk' ? '(several at once)' : '(named while it runs)'
          const job = queue.jobs.find((j) => j.name === jobName)
          if (job === undefined) queue.jobs.push({ name: jobName, addedAt: [where] })
          else job.addedAt.push(where)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(f.ast)

    // A timer started at a module's top runs for as long as the app does.
    for (const stmt of f.ast.statements) {
      if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression) && ts.isIdentifier(stmt.expression.expression) && stmt.expression.expression.text === 'setInterval') {
        timers.push({ file: f.path, line: lineOf(f, stmt) })
      }
    }
  }
  for (const q of queues.values()) q.jobs.sort((a, b) => (a.name < b.name ? -1 : 1))
  return { queues: [...queues.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), timers, sockets }
}

/** Local name -> exported name, for everything imported from these packages. */
function namesFrom(f: ParsedFile, packages: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of f.ast.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteralLike(s.moduleSpecifier) || !packages.has(s.moduleSpecifier.text)) continue
    const named = s.importClause?.namedBindings
    if (named !== undefined && ts.isNamedImports(named)) for (const el of named.elements) out.set(el.name.text, (el.propertyName ?? el.name).text)
    if (s.importClause?.name !== undefined) out.set(s.importClause.name.text, 'default')
  }
  return out
}
