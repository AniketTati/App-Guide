import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { ParsedFile } from './parse.js'

/**
 * The exported surface of each module. Interior rather than boundary, so these
 * rank last and never reach the top block — but a symbol appearing or vanishing
 * is still a structural change worth being able to see.
 */
export function scanExports(files: readonly ParsedFile[]): Fact[] {
  const facts: Fact[] = []
  for (const file of files) {
    if (/\.(test|spec)\.[tj]sx?$/.test(file.path)) continue
    const src = file.ast
    for (const stmt of src.statements) {
      const line = src.getLineAndCharacterOfPosition(stmt.getStart(src)).line + 1
      for (const name of exportedNames(stmt)) {
        facts.push({ kind: 'export', module: file.path, symbol: name, where: { file: file.path, line } })
      }
    }
  }
  return facts
}

function exportedNames(stmt: ts.Statement): string[] {
  const isExported = ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

  if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
    return stmt.exportClause.elements.map((e) => e.name.text)
  }
  if (!isExported) return []
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return stmt.name === undefined ? ['default'] : [stmt.name.text]
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) return [stmt.name.text]
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
  }
  return []
}
