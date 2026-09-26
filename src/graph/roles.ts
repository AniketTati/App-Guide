import { ts } from 'ts-morph'
import type { ParsedFile } from '../extract/parse.js'
import { importsOf, type Resolver } from './resolve.js'

export interface Grant { action: string; resource: string; scope: string | null }
export interface RoleTable {
  /** The table's name as the code writes it: DEFAULT_ROLE_PERMISSIONS. */
  name: string
  file: string
  line: number
  /** Whether its keys are an enum's members — how user roles are usually named. */
  keyedByEnum: boolean
  roles: { role: string; grants: Grant[] }[]
}

/**
 * A role -> permissions table, read as the code writes it:
 *
 *   export const DEFAULT_ROLE_PERMISSIONS = {
 *     [SystemRole.LEGAL_COUNSEL]: [p(A.VIEW, R.CONTRACT), p(A.APPROVE, R.WORKFLOW, S.TEAM)],
 *   }
 *
 * Found by its shape — an object whose every value is a list of calls to one
 * function with two or three arguments — with enum members resolved to their
 * values across files and a missing argument taken from that function's
 * default. What it is called does not matter.
 */
export function readRoles(files: readonly ParsedFile[], r: Resolver): RoleTable[] {
  const values = enumValues(files)
  const found: RoleTable[] = []
  for (const file of files) {
    const imports = importsOf(file, r)
    // A local alias of an imported enum: `PermissionAction as A`.
    const alias = (name: string): string => imports.get(name)?.name ?? name
    const valueOf = (e: ts.Expression): string | null => {
      if (ts.isStringLiteralLike(e)) return e.text
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return values.get(`${alias(e.expression.text)}.${e.name.text}`) ?? null
      return null
    }
    // A permission table is declared once, at the top of a module; an object of
    // the same shape built inside a function is data, not a table.
    for (const stmt of file.ast.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const n of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(n.name) || n.initializer === undefined || !ts.isObjectLiteralExpression(n.initializer)) continue
        const table = asTable(n.initializer, file, valueOf)
        if (table !== null) found.push({ name: n.name.text, file: file.path, line: file.ast.getLineAndCharacterOfPosition(n.getStart(file.ast)).line + 1, keyedByEnum: table.keyedByEnum, roles: table.roles })
      }
    }
  }
  // More than one table can have this shape — roles for people, scopes for
  // API keys. All are returned, named as the code names them; tables keyed by
  // an enum first, since that is how roles are usually declared.
  return found.sort((a, b) => Number(b.keyedByEnum) - Number(a.keyedByEnum) || b.roles.length - a.roles.length)
}

function asTable(obj: ts.ObjectLiteralExpression, file: ParsedFile, valueOf: (e: ts.Expression) => string | null): { roles: RoleTable['roles']; keyedByEnum: boolean } | null {
  if (obj.properties.length < 2) return null
  let callee: string | null = null
  let keyedByEnum = true
  const roles: RoleTable['roles'] = []
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) return null
    const key = ts.isComputedPropertyName(p.name) ? valueOf(p.name.expression) : ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null
    if (key === null) return null
    if (!ts.isComputedPropertyName(p.name) || !ts.isPropertyAccessExpression(p.name.expression)) keyedByEnum = false
    const grants: Grant[] = []
    for (const el of p.initializer.elements) {
      if (!ts.isCallExpression(el) || !ts.isIdentifier(el.expression) || el.arguments.length < 2 || el.arguments.length > 3) return null
      if (callee !== null && el.expression.text !== callee) return null
      callee = el.expression.text
      const [a, res, s] = el.arguments
      const action = valueOf(a!)
      const resource = valueOf(res!)
      if (action === null || resource === null) return null
      const scope = s !== undefined ? valueOf(s) : defaultOf(file.ast, callee, 2, valueOf)
      grants.push({ action, resource, scope })
    }
    roles.push({ role: key, grants })
  }
  return roles.length >= 2 ? { roles, keyedByEnum } : null
}

/** The default a function gives a parameter it was not passed. */
function defaultOf(src: ts.SourceFile, fn: string, index: number, valueOf: (e: ts.Expression) => string | null): string | null {
  for (const s of src.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === fn) {
      const init = s.parameters[index]?.initializer
      return init === undefined ? null : valueOf(init)
    }
  }
  return null
}

/** `enum X { A = 'a' }` and `const X = { A: 'a' }` everywhere, as "X.A" -> "a". */
function enumValues(files: readonly ParsedFile[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    for (const s of f.ast.statements) {
      if (ts.isEnumDeclaration(s)) {
        for (const m of s.members) {
          const name = ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name) ? m.name.text : null
          if (name !== null && m.initializer !== undefined && ts.isStringLiteralLike(m.initializer)) out.set(`${s.name.text}.${name}`, m.initializer.text)
        }
      }
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
        let init = d.initializer
        while (init !== undefined && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression
        if (!ts.isIdentifier(d.name) || init === undefined || !ts.isObjectLiteralExpression(init)) continue
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && ts.isStringLiteralLike(p.initializer)) out.set(`${d.name.text}.${p.name.text}`, p.initializer.text)
        }
      }
    }
  }
  return out
}

/**
 * The roles that pass a route's permission check, read from the check's own
 * arguments: `requirePermission('approve', 'workflow')` is matched against the
 * table's grants, wildcards included. null when the route has no check the
 * table speaks about.
 */
export function rolesFor(checks: readonly string[], table: RoleTable): { role: string; scope: string | null }[] | null {
  for (const check of checks) {
    const m = /^\w+\('([^']+)',\s*'([^']+)'\)$/.exec(check)
    if (m === null) continue
    const [, action, resource] = m as unknown as [string, string, string]
    const known = table.roles.some((r) => r.grants.some((g) => (g.action === action || g.action === '*') && (g.resource === resource || g.resource === '*')))
    if (!known) continue
    return table.roles.flatMap((r) => {
      const g = r.grants.find((x) => (x.action === action || x.action === '*') && (x.resource === resource || x.resource === '*'))
      return g === undefined ? [] : [{ role: r.role, scope: g.scope }]
    })
  }
  return null
}
