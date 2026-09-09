import type { Fact } from '../model/facts.js'
import type { Change, Report } from '../model/report.js'
import { subject } from '../diff/rank.js'
import { bold, dim, pad, truncate, width } from './ansi.js'

const KIND_COL = 9 // 'external' is 8 — a column of exactly the widest kind leaves no gap
const MIN_WIDTH = 60
const MAX_WIDTH = 100
/** Short by contract. After twenty three-line receipts, a twenty-line one
 *  triggers a reaction before the eye reads a word — so length is the severity
 *  channel, and it only works if it is bounded. */
const MAX_LINES = 22

export interface TerminalOptions {
  columns?: number
  /** Shown in the footer hint; the count behind `--all`. */
  hiddenCount?: number
}

export function renderTerminal(report: Report, opts: TerminalOptions = {}): string {
  const cols = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, opts.columns ?? process.stdout.columns ?? 80))
  const nothing = report.top.length === 0 && report.also.length === 0

  return nothing ? allClear(report, cols) : full(report, cols, opts)
}

/** The state the tool is in most of the time. Being visibly, reliably boring is
 *  what turns this from a fear product into one people keep. */
function allClear(report: Report, cols: number): string {
  // "nothing new to the shape" is an exhaustive claim. When a framework we
  // cannot read is present, the claim is false and must be qualified — this is
  // the exact silence the tool exists to prevent, and the all-clear is where it
  // would otherwise hide.
  const headline = report.firstRun === true
    ? 'first run — mark established, nothing to compare yet'
    : report.gaps.length > 0
      ? 'nothing new in what I can read'
      : 'nothing new to the shape'
  const lines = [` ${bold('appguide')} ${dim('·')} ${session(report)} ${dim('·')} ${headline}`]
  const cover = coverageLines(report.gaps, cols)
  lines.push(...(cover.length > 0 ? cover : [`   ${dim('everything it touched was readable')}`]))
  return frame(lines, cols)
}

function full(report: Report, cols: number, opts: TerminalOptions): string {
  const head: string[] = [
    ` ${bold('appguide')} ${dim('·')} ${session(report)}`,
    '',
    ...prose(report.summary, cols),
  ]

  const top: string[] = []
  if (report.top.length > 0) {
    top.push('', ` ${dim('NEW TO THIS CODEBASE')}`)
    for (const change of report.top) top.push(...entry(change, cols, true))
  }

  const coverage: string[] = []
  if (report.gaps.length > 0) {
    coverage.push('', ` ${dim('NOT COVERED')}`, ...coverageLines(report.gaps, cols),
      `   ${dim(`→ a change ${report.gaps.length === 1 ? 'in it' : 'in any of these'} would not appear above`)}`)
  }

  const hidden = opts.hiddenCount ?? report.totalChanges
  const footer = ['', `   ${dim(`appguide since --all (${hidden}) · --mark`)}`]

  // Everything above is fixed cost. `also` is the only section allowed to give
  // ground — the coverage block never is, because a receipt that drops its own
  // blind spots to save room is the failure this tool exists to prevent.
  const FRAME = 3
  const fixed = head.length + top.length + coverage.length + footer.length + FRAME
  const also: string[] = []
  const available = MAX_LINES + FRAME - fixed
  // A section header with nothing under it is noise: the footer's `--all (n)`
  // already says there is more. Show the section only if at least one entry
  // fits beneath it.
  if (report.also.length > 0 && available >= 3) {
    const capacity = available - 2
    const needsMore = report.also.length > capacity
    const shown = report.also.slice(0, needsMore ? capacity - 1 : capacity)
    // A header whose only content is "+N more" says nothing the footer's
    // `--all (n)` does not already say.
    if (shown.length === 0) return frame([...head, ...top, ...coverage, ...footer], cols)
    also.push('', ` ${dim('ALSO CHANGED')}`)
    for (const change of shown) also.push(...entry(change, cols, false))
    const rest = report.also.length - shown.length
    if (rest > 0) also.push(`   ${dim(`+${rest} more`)}`)
  }

  return frame([...head, ...top, ...also, ...coverage, ...footer], cols)
}

function frame(lines: readonly string[], cols: number): string {
  const rule = dim('─'.repeat(cols))
  return [rule, ...lines, rule, ''].join('\n')
}

const session = (report: Report): string =>
  `${report.session.files} file${report.session.files === 1 ? '' : 's'}`

/** The only prose in the output. It reads three times faster than a table for
 *  the "do I care" question, so it is the one thing allowed to wrap. */
const PROSE_MAX_LINES = 4

function prose(summary: string, cols: number): string[] {
  const limit = cols - 2
  const out: string[] = []
  let line = ''
  const flush = (): void => { if (line !== '') { out.push(` ${line}`); line = '' } }

  for (let word of summary.split(' ')) {
    // A package or module name can exceed the whole line on its own. Breaking
    // it is ugly; letting it overflow breaks the width budget silently.
    while (width(word) > limit) {
      flush()
      const head = truncate(word, limit)
      out.push(` ${head}`)
      word = word.slice(head.length - 1)
    }
    if (line !== '' && width(line) + width(word) + 1 > limit) flush()
    line = line === '' ? word : `${line} ${word}`
  }
  flush()
  return out.length > PROSE_MAX_LINES
    ? [...out.slice(0, PROSE_MAX_LINES - 1), ` ${truncate(out[PROSE_MAX_LINES - 1]!.trim(), limit)}`]
    : out
}

/**
 * Three columns: kind (dim), subject (full brightness), corroborating count
 * (dim). Every exception gets a second indented line with file:line — the
 * show-your-work line that turns "a tool told me" into "I can check that".
 */
function entry(change: Change, cols: number, showEvidence: boolean): string[] {
  const gutter = 3 + KIND_COL
  const rest = cols - gutter - 1
  const subjWidth = Math.max(18, Math.floor(rest * 0.45))
  const rightWidth = rest - subjWidth

  const marker = change.type === 'removed' ? '-' : change.type === 'changed' ? '~' : ' '
  const kind = pad(change.fact.kind, KIND_COL)
  const subj = pad(truncate(subject(change.fact), subjWidth), subjWidth)

  // Never truncate the number: the number is the claim. If the property and
  // the ratio do not both fit, the property moves to the evidence line rather
  // than the ratio losing digits.
  const { full, ratio, property } = corroboration(change)
  const fits = width(full) <= rightWidth
  const right = fits ? full : truncate(ratio, rightWidth)

  const lines = [`  ${dim(marker)}${dim(kind)}${subj} ${dim(right)}`.trimEnd()]
  if (showEvidence) {
    const where = `${change.fact.where.file}:${change.fact.where.line}`
    const note = fits ? secondary(change) : property
    lines.push(
      `${' '.repeat(gutter)}${dim(pad(truncate(where, subjWidth), subjWidth))} ${dim(truncate(note, rightWidth))}`.trimEnd(),
    )
  }
  return lines
}

/** Never an adjective. A ratio the reader can verify and the tool cannot get
 *  wrong. */
function corroboration(change: Change): { full: string; ratio: string; property: string } {
  const d = change.denominator
  if (d !== undefined) {
    // The compact form still carries the property. A number stripped of what it
    // counts is exactly the ambiguity the denominator rule exists to remove.
    return {
      full: `${d.property} · ${d.matching} of ${d.total} ${d.noun}`,
      ratio: `${d.matching}/${d.total} ${d.property}`,
      property: `${d.matching} of ${d.total} ${d.noun}`,
    }
  }
  const f = change.fact
  let plain = ''
  if (f.kind === 'route') plain = f.middleware === 'unresolved' ? 'chain unresolved' : (f.middleware.join(', ') || 'no middleware')
  else if (f.kind === 'library') plain = `${f.version}${f.direct ? '' : ' (transitive)'}`
  else if (f.kind === 'external') plain = f.via
  return { full: plain, ratio: plain, property: plain }
}

/**
 * Phrased per kind. A generic "N others do not" reads as nonsense once the
 * property is something like "first write from billing/".
 */
function secondary(change: Change): string {
  const d = change.denominator
  if (d === undefined) return change.type === 'changed' ? 'changed since you last looked' : ''
  const others = d.total - d.matching
  if (others <= 0) return ''
  switch (change.fact.kind) {
    case 'route': return `every other route has one`
    case 'write': return `${others} other module${others === 1 ? '' : 's'} write it`
    case 'library': return `${others} other dependencies were already here`
    default: return `${others} others do not`
  }
}

/**
 * Scoped to what this session touched — never a global percentage, which reads
 * as a grade on the user's own code.
 *
 * One gap per line, and the overflow count on its own line. An earlier version
 * joined them and truncated the result, so the user learned about one and a
 * half of five blind spots and never learned the other three existed — the
 * tool's core promise, inverted.
 */
const COVERAGE_MAX = 3

export function coverageLines(gaps: readonly Fact[], cols: number): string[] {
  if (gaps.length === 0) return []
  const shown = gaps.slice(0, COVERAGE_MAX)
  const lines = shown.map((g) => `   ${dim(truncate(describeGap(g), cols - 4))}`)
  const rest = gaps.length - shown.length
  if (rest > 0) lines.push(`   ${dim(`and ${rest} more I could not read`)}`)
  return lines
}

function describeGap(g: Fact): string {
  if (g.kind !== 'gap') return ''
  switch (g.reason) {
    case 'parse-error': return `${g.subject}: ${g.detail}`
    case 'unsupported-framework': return `${g.subject}: ${g.detail}`
    case 'computed-route-path': return `${g.subject}: route path is built at runtime`
    case 'dynamic-dispatch': return `${g.subject}: dispatches dynamically`
    case 'raw-sql': return `${g.subject}: raw SQL, not parsed`
    case 'unresolved-import': return `${g.subject}: ${g.detail}`
  }
}

export const _internal = { prose, coverageLines, corroboration, width }
