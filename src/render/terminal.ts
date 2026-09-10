import type { Fact } from '../model/facts.js'
import type { Change, Report } from '../model/report.js'
import { subject } from '../diff/rank.js'
import { words, type Voice } from './words.js'
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
  /** 'plain' translates every term for a reader who does not write code. It
   *  never adds a judgement the technical voice would not make. */
  voice?: Voice
}

export function renderTerminal(report: Report, opts: TerminalOptions = {}): string {
  const cols = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, opts.columns ?? process.stdout.columns ?? 80))
  const nothing = report.top.length === 0 && report.also.length === 0
  const voice = opts.voice ?? 'technical'

  return nothing ? allClear(report, cols, voice) : full(report, cols, { ...opts, voice })
}

/** The state the tool is in most of the time. Being visibly, reliably boring is
 *  what turns this from a fear product into one people keep. */
function allClear(report: Report, cols: number, voice: Voice): string {
  const w = words(voice)
  // "nothing new to the shape" is an exhaustive claim. When a framework we
  // cannot read is present, the claim is false and must be qualified — this is
  // the exact silence the tool exists to prevent, and the all-clear is where it
  // would otherwise hide.
  const headline = report.firstRun === true
    ? (voice === 'plain'
        ? "first look — I've made a note of what's here. Run again after your next session."
        : 'first run — mark established, nothing to compare yet')
    : w.headline(report)
  const lines = [` ${bold('appguide')} ${dim('·')} ${session(report)} ${dim('·')} ${headline}`]
  const cover = coverageLines(report.gaps, cols, voice)
  lines.push(...(cover.length > 0
    ? cover
    : [`   ${dim(voice === 'plain' ? 'I could read everything it touched' : 'everything it touched was readable')}`]))
  return frame(lines, cols)
}

function full(report: Report, cols: number, opts: TerminalOptions): string {
  const voice = opts.voice ?? 'technical'
  const w = words(voice)
  // Numbered so a reader can say "explain #1" instead of retyping a path.
  let n = 0
  const head: string[] = [
    ` ${bold('appguide')} ${dim('·')} ${session(report)}`,
    '',
    ...prose(report.summary, cols),
  ]

  const top: string[] = []
  if (report.top.length > 0) {
    top.push('', ` ${dim(w.labels.top)}`)
    for (const change of report.top) top.push(...entry(change, cols, true, voice, ++n))
  }

  const coverage: string[] = []
  if (report.gaps.length > 0) {
    coverage.push('', ` ${dim(w.labels.gaps)}`, ...coverageLines(report.gaps, cols, voice),
      `   ${dim(truncate(voice === 'plain'
        ? `→ anything your agent changed in ${report.gaps.length === 1 ? 'it' : 'these'} is missing from the list above`
        : `→ a change ${report.gaps.length === 1 ? 'in it' : 'in any of these'} would not appear above`, cols - 4))}`)
  }

  const hidden = opts.hiddenCount ?? report.totalChanges
  const footer = ['', `   ${dim(truncate(w.footer(hidden, report.top.length > 0, cols), cols - 4))}`]

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
    also.push('', ` ${dim(w.labels.also)}`)
    for (const change of shown) also.push(...entry(change, cols, false, voice, ++n))
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
function entry(change: Change, cols: number, showEvidence: boolean, voice: Voice = 'technical', index = 0): string[] {
  const w = words(voice)
  const gutter = 3 + KIND_COL
  const rest = cols - gutter - 1
  const subjWidth = Math.max(18, Math.floor(rest * 0.45))
  const rightWidth = rest - subjWidth

  const marker = change.type === 'removed' ? '-' : change.type === 'changed' ? '~' : ' '
  const kind = pad(truncate(w.kind(change.fact), KIND_COL - 1), KIND_COL)
  const subj = pad(truncate(subject(change.fact), subjWidth), subjWidth)

  // Never truncate the number: the number is the claim. If the property and
  // the ratio do not both fit, the property moves to the evidence line rather
  // than the ratio losing digits.
  const { full, ratio, property } = corroboration(change, voice)
  const fits = width(full) <= rightWidth
  const right = fits ? full : truncate(ratio, rightWidth)

  const label = index > 0 && voice === 'plain' ? dim(`#${index}`) : dim(marker)
  const lines = [`  ${pad(label, voice === 'plain' && index > 0 ? 4 : 1)}${dim(kind)}${subj} ${dim(right)}`.trimEnd()]
  if (showEvidence) {
    const where = `${change.fact.where.file}:${change.fact.where.line}`
    const note = fits ? secondary(change, voice) : property
    lines.push(
      `${' '.repeat(gutter + (voice === 'plain' && index > 0 ? 3 : 0))}${dim(pad(truncate(where, subjWidth), subjWidth))} ${dim(truncate(note, rightWidth))}`.trimEnd(),
    )
    const why = w.why(change)
    if (why !== '') lines.push(`${' '.repeat(gutter + (voice === 'plain' ? 3 : 0))}${dim(truncate(why, cols - gutter - 5))}`)
  }
  return lines
}

/** Never an adjective. A ratio the reader can verify and the tool cannot get
 *  wrong. */
function corroboration(change: Change, voice: Voice = 'technical'): { full: string; ratio: string; property: string } {
  const w = words(voice)
  const d = change.denominator
  if (d !== undefined) {
    const prop = voice === 'plain' ? plainProperty(d.property) : d.property
    const noun = voice === 'plain' ? plainNoun(d.noun) : d.noun
    const ratio = `${d.matching} of ${d.total} ${noun}`
    // The compact form still carries the property. A number stripped of what it
    // counts is exactly the ambiguity the denominator rule exists to remove.
    return {
      full: `${prop} · ${ratio}`,
      ratio: `${d.matching}/${d.total} ${prop}`,
      property: ratio,
    }
  }
  const text = w.detail(change)
  return { full: text, ratio: text, property: text }
}

/**
 * Phrased per kind. A generic "N others do not" reads as nonsense once the
 * property is something like "first write from billing/".
 */
const plainNoun = (noun: string): string => noun
  .replace(/\broutes\b/, 'URLs')
  .replace(/^modules write (.+)$/, 'places change $1')
  .replace(/\bdependencies\b/, 'packages')
  .replace(/\bexternal calls\b/, 'outside services')
const plainProperty = (p: string): string => p
  .replace(/^no middleware$/, 'nothing checks it')
  .replace(/^new dependency$/, 'new package')
  .replace(/^new outbound call$/, 'new outside service')
  .replace(/^first write from /, 'first change from ')

function secondary(change: Change, voice: Voice = 'technical'): string {
  const d = change.denominator
  if (d === undefined) return change.type === 'changed' ? 'changed since you last looked' : ''
  const others = d.total - d.matching
  if (others <= 0) return ''
  const plain = voice === 'plain'
  switch (change.fact.kind) {
    case 'route': return plain ? 'every other URL is checked' : 'every other route has one'
    case 'write': return plain
      ? `${others} other place${others === 1 ? '' : 's'} already could`
      : `${others} other module${others === 1 ? '' : 's'} write it`
    case 'library': return plain
      ? `${others} other packages were already here`
      : `${others} other dependencies were already here`
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

export function coverageLines(gaps: readonly Fact[], cols: number, voice: Voice = 'technical'): string[] {
  if (gaps.length === 0) return []
  const w = words(voice)
  const shown = gaps.slice(0, COVERAGE_MAX)
  const lines = shown.map((g) => `   ${dim(truncate(voice === 'plain' ? w.gap(g) : describeGap(g), cols - 4))}`)
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
