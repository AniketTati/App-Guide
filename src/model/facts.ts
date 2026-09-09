/**
 * Everything the tool knows is a Fact. A snapshot is a sorted list of facts;
 * a diff is a set operation on their ids.
 *
 * `where` is provenance — it never contributes to identity, or every reformat
 * would read as a change.
 */

export type GapReason =
  | 'parse-error'
  | 'unresolved-import'
  | 'dynamic-dispatch'
  | 'computed-route-path'
  | 'raw-sql'
  | 'unsupported-framework'

export interface Where {
  file: string
  line: number
}

export type Middleware = readonly string[] | 'unresolved'

export type Fact =
  | { kind: 'route'; method: string; path: string; middleware: Middleware; framework: string; where: Where }
  | { kind: 'library'; name: string; version: string; direct: boolean; importers: readonly string[]; where: Where }
  | { kind: 'external'; host: string; via: string; where: Where }
  | { kind: 'write'; table: string; module: string; where: Where }
  | { kind: 'read'; table: string; module: string; where: Where }
  | { kind: 'export'; module: string; symbol: string; where: Where }
  | { kind: 'gap'; reason: GapReason; subject: string; detail: string; where: Where }

export type FactKind = Fact['kind']

/**
 * Boundary kinds change the edge of the system. They outrank interior kinds in
 * ranking, and only they are eligible for the top block.
 */
export const BOUNDARY_KINDS: ReadonlySet<FactKind> = new Set<FactKind>([
  'route',
  'library',
  'external',
  'write',
])

export function isBoundary(fact: Fact): boolean {
  return BOUNDARY_KINDS.has(fact.kind)
}
