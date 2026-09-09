import { isBoundary, type Fact, type FactKind } from '../model/facts.js'
import type { Change, Report } from '../model/report.js'

/** Ties break by how far out on the boundary a thing sits. */
const KIND_WEIGHT: Record<FactKind, number> = {
  route: 0, external: 1, write: 2, library: 3, read: 4, export: 5, gap: 6,
}

export const TOP_BLOCK_LIMIT = 3

/**
 * Three deterministic axes: boundary before interior, rare before common,
 * reach before leaf. Every input is a count. The function has no opinions,
 * which is what lets the tool report severity without ever judging.
 */
export function rank(changes: readonly Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const boundary = Number(isBoundary(b.fact)) - Number(isBoundary(a.fact))
    if (boundary !== 0) return boundary

    // Rarer first: a property held by 1 of 48 outranks one held by 20 of 48.
    const rarity = compareRarity(a, b)
    if (rarity !== 0) return rarity

    const weight = KIND_WEIGHT[a.fact.kind] - KIND_WEIGHT[b.fact.kind]
    if (weight !== 0) return weight

    return subject(a.fact).localeCompare(subject(b.fact))
  })
}

/**
 * A change carrying a denominator outranks one without, since only those are
 * eligible for the top block. Both missing is a tie — expressed explicitly
 * rather than by arithmetic, because Infinity - Infinity is NaN and a NaN
 * comparator makes sort order undefined. In a tool whose entire claim is
 * determinism, that is the worst possible bug.
 */
function compareRarity(a: Change, b: Change): number {
  const da = a.denominator
  const db = b.denominator
  if (da === undefined && db === undefined) return 0
  if (da === undefined) return 1
  if (db === undefined) return -1
  const va = da.total === 0 ? 1 : da.matching / da.total
  const vb = db.total === 0 ? 1 : db.matching / db.total
  return va - vb
}

/**
 * The invariant that makes false alarms structurally impossible: nothing
 * reaches the top block without a corroborating number the reader can check.
 * If we cannot produce a denominator, we cannot claim the thing matters.
 */
export function split(ranked: readonly Change[]): { top: Change[]; also: Change[] } {
  const top: Change[] = []
  const also: Change[] = []
  for (const change of ranked) {
    if (change.denominator !== undefined && change.type === 'added' && top.length < TOP_BLOCK_LIMIT) {
      top.push(change)
    } else {
      also.push(change)
    }
  }
  return { top, also }
}

export function subject(fact: Fact): string {
  switch (fact.kind) {
    case 'route': return `${fact.method} ${fact.path}`
    case 'library': return fact.name
    case 'external': return fact.host
    case 'write': return `${fact.module} → ${fact.table}`
    case 'read': return `${fact.module} ← ${fact.table}`
    case 'export': return `${fact.module}#${fact.symbol}`
    case 'gap': return fact.subject
  }
}

/** One sentence of English — the only prose in the output. */
export function summarise(top: readonly Change[], also: readonly Change[]): string {
  const total = top.length + also.length
  if (total === 0) return 'nothing new to the shape'
  const parts = top.length > 0 ? top.map((c) => subject(c.fact)) : also.slice(0, 2).map((c) => subject(c.fact))
  const rest = total - parts.length
  const list = parts.join(', ')
  return rest > 0 ? `${list}, and ${rest} more` : list
}

export function toReport(
  changes: readonly Change[],
  gaps: readonly Fact[],
  session: Report['session'],
): Report {
  const { top, also } = split(rank(changes))
  return { summary: summarise(top, also), top, also, gaps, totalChanges: changes.length, session }
}
