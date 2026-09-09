import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { ParsedFile } from './parse.js'

const WRITE = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'insert', 'set', 'save', 'remove'])
const READ = new Set(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy', 'select', 'query'])

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
    const clients = ormBindings(src)

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1

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
      ts.forEachChild(node, visit)
    }
    visit(src)
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
