import { isBoundary, type Fact, type FactKind } from '../model/facts.js'
import { withDenominators } from './rarity.js'
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

    // Kind before rarity. Comparing "1 of 48 routes" against "1 of 4 writers"
    // is comparing incommensurable denominators — the ratios are arithmetic
    // but the comparison is meaningless. Rarity only orders within a kind.
    const weight = KIND_WEIGHT[a.fact.kind] - KIND_WEIGHT[b.fact.kind]
    if (weight !== 0) return weight

    const rarity = compareRarity(a, b)
    if (rarity !== 0) return rarity

    // Raw code-unit order, not localeCompare: collation is locale-dependent
    // and returns 0 for NFC/NFD pairs, which would leave distinct facts tied
    // and their order decided by upstream Map insertion.
    const sa = subject(a.fact)
    const sb = subject(b.fact)
    return sa < sb ? -1 : sa > sb ? 1 : 0
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

/**
 * One sentence of English — the only prose in the output, and the line that
 * answers "do I need to read this?" in about three seconds. Built from counts,
 * so it can no more be wrong than the table below it.
 */
export function summarise(changes: readonly Change[], firstRun = false, voice: 'technical' | 'plain' = 'technical'): string {
  if (voice === 'plain') return summarisePlain(changes, firstRun)
  // A first run has nothing to compare against. Saying "nothing new to the
  // shape" would be a positive claim with no evidence, and markdown and JSON
  // consumers keying on this string would be told a falsehood.
  if (firstRun) return 'first run — mark established, nothing to compare yet'
  if (changes.length === 0) return 'nothing new to the shape'

  const added = changes.filter((c) => c.type === 'added')
  const removed = changes.filter((c) => c.type === 'removed')
  const changed = changes.filter((c) => c.type === 'changed')
  const clauses: string[] = []

  const routes = added.filter((c) => c.fact.kind === 'route')
  if (routes.length > 0) {
    const bare = routes.filter((c) => c.fact.kind === 'route' && c.fact.middleware !== 'unresolved' && c.fact.middleware.length === 0)
    let clause = `added ${count(routes.length, 'route')}`
    if (bare.length === 1) clause += ', one with no middleware'
    else if (bare.length > 1) clause += `, ${bare.length} with no middleware`
    clauses.push(clause)
  }

  const writes = added.filter((c) => c.fact.kind === 'write')
  for (const w of writes.slice(0, 2)) {
    if (w.fact.kind !== 'write') continue
    clauses.push(`made ${w.fact.module} write to ${w.fact.table} for the first time`)
  }
  if (writes.length > 2) clauses.push(`and ${writes.length - 2} other first-time writes`)

  const externals = added.filter((c) => c.fact.kind === 'external')
  if (externals.length === 1 && externals[0]!.fact.kind === 'external') {
    clauses.push(`started calling ${externals[0]!.fact.host}`)
  } else if (externals.length > 1) {
    clauses.push(`started calling ${count(externals.length, 'external service')}`)
  }

  const libs = added.filter((c) => c.fact.kind === 'library')
  if (libs.length === 1 && libs[0]!.fact.kind === 'library') clauses.push(`pulled in ${libs[0]!.fact.name}`)
  else if (libs.length > 1) clauses.push(`pulled in ${count(libs.length, 'dependency', 'dependencies')}`)

  const exports_ = added.filter((c) => c.fact.kind === 'export')
  if (exports_.length > 0) clauses.push(`exported ${count(exports_.length, 'new symbol')}`)

  if (clauses.length === 0) {
    if (changed.length > 0) clauses.push(`changed ${count(changed.length, 'thing')}`)
    if (removed.length > 0) clauses.push(`removed ${count(removed.length, 'thing')}`)
  } else if (removed.length > 0) {
    clauses.push(`removed ${count(removed.length, 'thing')}`)
  }

  return `Your agent ${join(clauses)}.`
}

/** Same facts, the reader's words. Still counts, still no adjectives. */
function summarisePlain(changes: readonly Change[], firstRun: boolean): string {
  if (firstRun) return "This is my first look, so there's nothing to compare against yet."
  if (changes.length === 0) return 'Your agent changed nothing that affects how your app is put together.'

  const added = changes.filter((c) => c.type === 'added')
  const clauses: string[] = []

  const routes = added.filter((c) => c.fact.kind === 'route')
  const open = routes.filter((c) => c.fact.kind === 'route' && c.fact.middleware !== 'unresolved' && c.fact.middleware.length === 0)
  if (routes.length > 0) {
    clauses.push(open.length > 0
      ? `added ${count(routes.length, 'new URL')}, ${open.length === routes.length ? '' : `${open.length} of which `}with nothing checking who can use ${open.length === 1 ? 'it' : 'them'}`.replace(', with', ' with')
      : `added ${count(routes.length, 'new URL')}`)
  }

  const writes = added.filter((c) => c.fact.kind === 'write')
  if (writes.length > 0) {
    const tables = [...new Set(writes.map((c) => (c.fact.kind === 'write' ? c.fact.table : '')))]
    clauses.push(`let ${count(writes.length, 'new part')} of your app change your ${tables.slice(0, 2).join(' and ')} data`)
  }

  const externals = added.filter((c) => c.fact.kind === 'external')
  if (externals.length === 1 && externals[0]!.fact.kind === 'external') {
    clauses.push(`started talking to ${externals[0]!.fact.host}`)
  } else if (externals.length > 1) {
    clauses.push(`started talking to ${count(externals.length, 'outside service')}`)
  }

  const libs = added.filter((c) => c.fact.kind === 'library')
  if (libs.length === 1 && libs[0]!.fact.kind === 'library') clauses.push(`installed ${libs[0]!.fact.name}`)
  else if (libs.length > 1) clauses.push(`installed ${count(libs.length, 'package')}`)

  if (clauses.length === 0) {
    const removed = changes.filter((c) => c.type === 'removed').length
    return removed > 0
      ? `Your agent removed ${count(removed, 'thing')} and adjusted some code.`
      : 'Your agent adjusted some code, but nothing about how your app is put together.'
  }
  return `Your agent ${join(clauses)}.`
}

function count(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`
}

function join(parts: readonly string[]): string {
  if (parts.length === 0) return 'changed something'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]!}`
}

export function toReport(
  changes: readonly Change[],
  gaps: readonly Fact[],
  session: Report['session'],
  population: readonly Fact[] = [],
  firstRun = false,
  voice: 'technical' | 'plain' = 'technical',
): Report {
  const ranked = rank(withDenominators(changes, population))
  const { top, also } = split(ranked)
  return { summary: summarise(ranked, firstRun, voice), top, also, gaps, totalChanges: changes.length, session, firstRun }
}
