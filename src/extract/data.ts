import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { ParsedFile } from './parse.js'

export const WRITE = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'insert', 'set', 'save', 'remove'])
export const READ = new Set(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy', 'select', 'query', 'findUniqueOrThrow', 'findFirstOrThrow'])

/**
 * Which module touches which table.
 *
 * Prisma reads as `prisma.user.create(...)`; Drizzle as `db.insert(users)`.
 * Both are matched syntactically — a type checker would be more accurate and
 * an order of magnitude slower, and this runs after every agent session.
 */
export function scanData(files: readonly ParsedFile[], declared: ReadonlySet<string>): Fact[] {
  const prisma = declared.has('@prisma/client') || declared.has('prisma')
  const drizzle = declared.has('drizzle-orm')
  if (!prisma && !drizzle) return []

  const facts: Fact[] = []
  const seen = new Set<string>()
  // Repo-wide: tables are declared in a schema module and imported everywhere.
  const tables = new Set<string>()
  if (drizzle) for (const f of files) for (const t of drizzleTables(f.ast)) tables.add(t)

  for (const file of files) {
    const mod = moduleOf(file.path)
    const src = file.ast
    const lineOf = (n: ts.Node): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1

    const visit = (node: ts.Node, clients: ReadonlySet<string>): void => {
      // Inside `prisma.$transaction(async (tx) => …)`, and inside a function
      // handed a transaction client, that parameter is the client. Missing it
      // lost every write made inside a transaction — 53 of them in one real
      // API — with no gap to say so.
      const scoped = prisma ? transactionClients(node, clients, src) : null
      if (scoped !== null) {
        ts.forEachChild(node, (c) => visit(c, scoped))
        return
      }

      // Hand-written SQL names its tables inside a string. We do not read it,
      // and we must not be silent that it exists.
      if (prisma && isRawSql(node, clients)) {
        const line = lineOf(node)
        facts.push({
          kind: 'gap', reason: 'raw-sql', subject: `${file.path}:${line}`,
          detail: 'hand-written SQL — the tables it reads or changes are not listed',
          where: { file: file.path, line },
        })
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const line = lineOf(node)

        // Prisma: <client>.<model>.<method>(), where <client> is a binding we
        // resolved to a PrismaClient — including this.prisma and ctx.prisma,
        // which are the dominant idioms in service classes and tRPC.
        const inner = node.expression.expression
        if (prisma && ts.isPropertyAccessExpression(inner) && clients.has(rootName(inner.expression))) {
          push(inner.name.text, method, mod, file.path, line)
        }
        // Drizzle: db.insert(users) / db.select().from(users). The argument must
        // resolve to a table declared with pgTable/sqliteTable/mysqlTable, or
        // Array.from(nodes) reads as a query against a table called `nodes`.
        if (drizzle && (WRITE.has(method) || method === 'from')) {
          const [arg] = node.arguments
          if (arg !== undefined && ts.isIdentifier(arg) && tables.has(arg.text)) {
            push(arg.text, method === 'from' ? 'select' : method, mod, file.path, line)
          }
        }
      }
      ts.forEachChild(node, (c) => visit(c, clients))
    }
    visit(src, ormBindings(src))
  }

  function push(table: string, method: string, mod: string, file: string, line: number): void {
    const kind = WRITE.has(method) ? 'write' : READ.has(method) ? 'read' : null
    if (kind === null) return
    const key = `${kind}:${table}:${mod}`
    if (seen.has(key)) return
    seen.add(key)
    facts.push({ kind, table, module: mod, where: { file, line } })
  }

  return facts
}

/** Identifiers holding a Prisma client, plus the conventional receiver names.
 *  Without this, `el.classList.remove()` is a write to a table called
 *  `classList`. */
function ormBindings(src: ts.SourceFile): Set<string> {
  const out = new Set<string>(['prisma', 'this.prisma', 'ctx.prisma', 'db', 'this.db', 'ctx.db'])
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer !== undefined && ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'PrismaClient'
    ) out.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const RAW_SQL = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'])

/** `prisma.$queryRaw\`…\`` (a tagged template) or `prisma.$executeRawUnsafe(…)`. */
function isRawSql(node: ts.Node, clients: ReadonlySet<string>): boolean {
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : ts.isCallExpression(node) ? node.expression : undefined
  return callee !== undefined && ts.isPropertyAccessExpression(callee) && RAW_SQL.has(callee.name.text) && clients.has(rootName(callee.expression))
}

/**
 * The client set to use inside `node`, when `node` introduces a transaction
 * client: a `$transaction` callback's first parameter, or a function parameter
 * typed as a Prisma client or transaction client. null when it introduces none.
 */
function transactionClients(node: ts.Node, clients: ReadonlySet<string>, src: ts.SourceFile): ReadonlySet<string> | null {
  const withParam = (fn: ts.SignatureDeclarationBase, index: number): ReadonlySet<string> | null => {
    const param = fn.parameters[index]?.name
    return param !== undefined && ts.isIdentifier(param) ? new Set([...clients, param.text]) : null
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === '$transaction' && clients.has(rootName(node.expression.expression))) {
    const [fn] = node.arguments
    if (fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const scoped = withParam(fn, 0)
      if (scoped !== null) return scoped
    }
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
    const typed = node.parameters.findIndex((p) => p.type !== undefined && /\b(TransactionClient|PrismaClient)\b/.test(p.type.getText(src)))
    if (typed !== -1) return withParam(node, typed)
  }
  return null
}

/** Tables declared with a drizzle table builder in this file. */
function drizzleTables(src: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer !== undefined && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      /^(pg|sqlite|mysql)Table$/.test(node.initializer.expression.text)
    ) out.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const rootName = (expr: ts.Expression): string =>
  ts.isIdentifier(expr) ? expr.text
    : ts.isPropertyAccessExpression(expr) ? `${rootName(expr.expression)}.${expr.name.text}`
    : expr.kind === ts.SyntaxKind.ThisKeyword ? 'this' : ''

/** The directory, which is the unit people reason about — "billing writes to
 *  users" is the finding, not "billing/usage.ts:112 writes to users". */
function moduleOf(path: string): string {
  const parts = path.split('/')
  return parts.length <= 1 ? '.' : parts.slice(0, -1).join('/')
}
