import { ts } from 'ts-morph'
import type { Fact } from '../../model/facts.js'
import type { RouteDetector } from './types.js'
import { normalise } from './express.js'

const HTTP = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])

/**
 * App Router route handlers, plus server actions.
 *
 * Server actions are listed first in the detector order for a reason: they are
 * the dominant mutation entry point in modern Next apps, they have no URL to
 * grep for, and "the agent added an entry point nobody asked for" is exactly
 * the case this tool exists to catch.
 */
export const nextAppRouter: RouteDetector = {
  name: 'next-app-router',
  packages: ['next'],
  detect({ files }) {
    const facts: Fact[] = []
    for (const file of files) {
      const src = file.ast
      if (/(^|\/)route\.(ts|tsx|js|jsx|mts|mjs)$/.test(file.path)) facts.push(...routeHandlers(file.path, src))
      facts.push(...pagesApi(file.path, src))
      facts.push(...serverActions(file.path, file.text, src))
    }
    return facts
  },
}

function routeHandlers(path: string, src: ts.SourceFile): Fact[] {
  const url = urlFor(path)
  if (url === null) return []
  const out: Fact[] = []
  for (const stmt of src.statements) {
    for (const name of exportedNames(stmt)) {
      if (!HTTP.has(name)) continue
      out.push({
        kind: 'route',
        method: name,
        path: url,
        // File-convention routing has no middleware argument. Next middleware
        // lives in a separate root file and applies by matcher, which we do not
        // resolve — so this is genuinely unknown, not empty.
        middleware: 'unresolved',
        framework: 'next-app-router',
        where: { file: path, line: src.getLineAndCharacterOfPosition(stmt.getStart(src)).line + 1 },
      })
    }
  }
  return out
}

/**
 * Pages Router API routes. Without this a Pages-Router app got a permanent,
 * unqualified all-clear over its entire API surface — no routes and no gap,
 * because 'next' being supported suppressed the blind-spot declaration.
 */
function pagesApi(path: string, src: ts.SourceFile): Fact[] {
  const m = /(^|\/)pages\/api\/(.+)\.(ts|tsx|js|jsx|mts|mjs)$/.exec(path)
  if (m === null) return []
  const rest = (m[2] ?? '').replace(/\/index$/, '')
  const hasDefault = src.statements.some(
    (stmt) => ts.canHaveModifiers(stmt) &&
      (ts.getModifiers(stmt) ?? []).some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword),
  )
  if (!hasDefault) return []
  return [{
    kind: 'route',
    // A Pages handler serves every verb; which ones it answers is decided at
    // runtime inside the function, so claiming one would be a guess.
    method: 'ANY',
    path: normalise(`/api/${rest}`),
    middleware: 'unresolved',
    framework: 'next-pages-api',
    where: { file: path, line: 1 },
  }]
}

function serverActions(path: string, text: string, src: ts.SourceFile): Fact[] {
  const fileLevel = /^\s*(['"])use server\1/m.test(text.split('\n').slice(0, 3).join('\n'))
  const out: Fact[] = []
  for (const stmt of src.statements) {
    const inline = ts.isFunctionDeclaration(stmt) && hasUseServer(stmt)
    if (!fileLevel && !inline) continue
    for (const name of exportedNames(stmt)) {
      if (HTTP.has(name)) continue
      out.push({
        kind: 'route',
        method: 'ACTION',
        // Server actions have no URL. The module path plus the export name is
        // the only stable identity they have.
        path: `${path}#${name}`,
        middleware: 'unresolved',
        framework: 'next-server-action',
        where: { file: path, line: src.getLineAndCharacterOfPosition(stmt.getStart(src)).line + 1 },
      })
    }
  }
  return out
}

const hasUseServer = (fn: ts.FunctionDeclaration): boolean =>
  fn.body?.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteralLike(s.expression) && s.expression.text === 'use server') ?? false

function exportedNames(stmt: ts.Statement): string[] {
  const exported = ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (!exported) return []
  if (ts.isFunctionDeclaration(stmt)) return stmt.name === undefined ? [] : [stmt.name.text]
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations
      .map((d) => (ts.isIdentifier(d.name) ? d.name.text : null))
      .filter((n): n is string => n !== null)
  }
  return []
}

/** app/api/users/[id]/route.ts → /api/users/[id]; route groups drop out. */
export function urlFor(filePath: string): string | null {
  const parts = filePath.split('/')
  const app = parts.lastIndexOf('app')
  if (app === -1) return null
  const segments = parts
    .slice(app + 1, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'))
  return normalise(`/${segments.join('/')}`)
}
