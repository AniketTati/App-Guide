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
const MAX_LINES = 26
const FRAME_LINES = 3

export interface TerminalOptions {
  columns?: number
  /** Shown in the footer hint; the count behind `--all`. */
  hiddenCount?: number
  /** 'plain' translates every term for a reader who does not write code. It
   *  never adds a judgement the technical voice would not make. */
  voice?: Voice
  /** The invocation appguide was installed with. Every command the receipt
   *  tells someone to run starts with this — a bare `appguide` is on nobody's
   *  PATH, so printing it hands the reader a command that fails. */
  command?: string
}

const DEFAULT_COMMAND = 'npx appguide'

/** An explicit width wins, then a real terminal's, then $COLUMNS — which is all
 *  there is when output is piped, as it is inside a hook. */
export const terminalWidth = (explicit: number | undefined, stdoutColumns: number | undefined, env: string | undefined): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, explicit ?? stdoutColumns ?? (Number(env) || 80)))

export function renderTerminal(report: Report, opts: TerminalOptions = {}): string {
  const cols = terminalWidth(opts.columns, process.stdout.columns, process.env['COLUMNS'])
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
  const head = ` ${bold('appguide')} ${dim('·')} ${session(report, voice)} ${dim('·')} `
  const lines = width(head) + width(headline) <= cols
    ? [`${head}${headline}`]
    : [` ${bold('appguide')} ${dim('·')} ${session(report, voice)}`, `   ${dim(truncate(headline, cols - 4))}`]
  const cover = coverageLines(report.gaps, cols, voice)
  lines.push(...(cover.length > 0
    ? cover
    : [`   ${dim(voice === 'plain' ? 'I could read everything it touched' : 'everything it touched was readable')}`]))
  return frame(lines, cols)
}

function full(report: Report, cols: number, opts: TerminalOptions): string {
  const voice = opts.voice ?? 'technical'
  const w = words(voice)
  const command = opts.command ?? DEFAULT_COMMAND
  const total = report.top.length + report.also.length

  const head: string[] = [
    ` ${bold('appguide')} ${dim('·')} ${session(report, voice)}`,
    '',
    ...prose(report.summary, cols),
  ]

  const coverage: string[] = []
  if (report.gaps.length > 0) {
    coverage.push('', ` ${dim(w.labels.gaps)}`, ...coverageLines(report.gaps, cols, voice),
      ...words_(voice === 'plain'
        ? `→ anything your agent changed in ${report.gaps.length === 1 ? 'it' : 'these'} is missing from the list above`
        : `→ a change ${report.gaps.length === 1 ? 'in it' : 'in any of these'} would not appear above`, cols - 4)
        .map((l) => `   ${dim(l)}`))
  }

  const footer = (hidden: number): string[] => [
    '',
    ...[...(hidden > 0 ? [seeAll(hidden, voice, command)] : []), w.footer(opts.hiddenCount ?? total, report.top.length > 0, cols, command)]
      .join('\n').split('\n').map((l) => `   ${dim(truncate(l, cols - 4))}`),
  ]

  // Findings are placed whole and in order until the budget runs out, and
  // whatever did not fit is counted in the footer, which never gives ground.
  // The previous approach trimmed lines, and the line it trimmed first was the
  // one saying more findings existed.
  let budget = MAX_LINES - head.length - coverage.length - footer(1).length
  const body: string[] = []
  let shown = 0
  const place = (label: string, changes: readonly Change[], evidence: boolean, offset: number): boolean => {
    let labelled = false
    for (let i = 0; i < changes.length; i++) {
      const lines = entry(changes[i]!, cols, evidence, voice, offset + i + 1)
      const need = lines.length + (labelled ? 0 : 2)
      if (need > budget) return false
      if (!labelled) { body.push('', ` ${dim(label)}`); labelled = true }
      body.push(...lines)
      budget -= need
      shown++
    }
    return true
  }
  // Never show a lower-priority finding while a higher-priority one is hidden.
  if (place(w.labels.top, report.top, true, 0)) place(w.labels.also, report.also, false, report.top.length)

  return frame([...head, ...body, ...coverage, ...footer(total - shown)], cols)
}

function frame(lines: readonly string[], cols: number): string {
  const rule = dim('─'.repeat(cols))
  return [rule, ...lines, rule, ''].join('\n')
}

/** How many files were read — not how many the agent touched, which is what
 *  a bare "11 files" beside a three-file session was taken to mean. */
const session = (report: Report, voice: Voice = 'technical'): string => {
  const n = report.session.files
  const files = `${n} file${n === 1 ? '' : 's'}`
  return voice === 'plain' ? `read ${files}` : `${files} read`
}

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
  // The "#1" label is 3 columns wider than the plain marker, and forgetting it
  // here is what pushed lines past the rule.
  const numberWidth = voice === 'plain' && index > 0 ? 3 : 0
  const gutter = 3 + KIND_COL + numberWidth
  const rest = cols - gutter - 1
  const subjWidth = Math.max(18, Math.floor(rest * 0.45))
  const rightWidth = rest - subjWidth

  const marker = change.type === 'removed' ? '-' : change.type === 'changed' ? '~' : ' '
  const kind = pad(truncate(w.kind(change.fact), KIND_COL - 1), KIND_COL)
  const full_subject = subject(change.fact)
  // If the subject does not fit beside the number, it gets the whole line.
  // Clipping it is unacceptable: which URL is unprotected is the entire answer,
  // and an answer ending in an ellipsis is not one.
  const roomy = width(full_subject) <= subjWidth
  const subj = pad(truncate(full_subject, subjWidth), subjWidth)

  // Never truncate the number: the number is the claim. If the property and
  // the ratio do not both fit, the property moves to the evidence line rather
  // than the ratio losing digits.
  const { full, ratio, property } = corroboration(change, voice)
  const fits = width(full) <= rightWidth
  const right = fits ? full : truncate(ratio, rightWidth)

  const label = index > 0 && voice === 'plain' ? dim(`#${index}`) : dim(marker)
  const head = `  ${pad(label, 1 + numberWidth)}${dim(kind)}`
  const wide = cols - gutter - 1
  const where = `${change.fact.where.file}:${change.fact.where.line}`

  const lines = roomy
    ? [`${head}${subj} ${dim(right)}`.trimEnd()]
    : [...wrap(full_subject, wide).map((l, i) => (i === 0 ? `${head}${l}` : `${' '.repeat(gutter)}${l}`)),
       `${' '.repeat(gutter)}${dim(truncate(full, wide))}`]

  if (showEvidence) {
    const note = roomy && fits ? secondary(change, voice) : ''
    lines.push(
      `${' '.repeat(gutter)}${dim(pad(truncate(where, subjWidth), note === '' ? 0 : subjWidth))}${note === '' ? '' : ` ${dim(truncate(note, rightWidth))}`}`.trimEnd(),
    )
    const why = w.why(change)
    if (why !== '') lines.push(`${' '.repeat(gutter)}${dim(truncate(why, wide))}`)
  }
  return lines
}

/** Never an adjective. A ratio the reader can verify and the tool cannot get
 *  wrong. */
function corroboration(change: Change, voice: Voice = 'technical'): { full: string; ratio: string; property: string } {
  const w = words(voice)
  const d = change.denominator
  if (d !== undefined && d.total === 1 && d.matching === 1) {
    // "1 of 1" is arithmetically true and reads like a glitch. When the whole
    // population is this one thing, say so in words — the same checkable count.
    const only = onlyOne(change.fact.kind, voice)
    return { full: only, ratio: only, property: only }
  }
  if (d !== undefined) {
    const prop = voice === 'plain' ? plainProperty(d.property) : d.property
    const noun = voice === 'plain' ? plainNoun(d.noun) : d.noun
    const ratio = `${d.matching} of ${d.total} ${noun}`
    // The compact form still carries the property. A number stripped of what it
    // counts is exactly the ambiguity the denominator rule exists to remove.
    return {
      full: `${prop} · ${ratio}`,
      ratio: voice === 'plain' ? ratio : `${d.matching}/${d.total} ${prop}`,
      // In plain the ratio is already in the right column, so the fallback
      // line carries the words instead — printing the same number twice, one
      // line apart, reads as a mistake.
      property: voice === 'plain' ? prop : ratio,
    }
  }
  const text = w.detail(change)
  return { full: text, ratio: text, property: text }
}

/**
 * Phrased per kind. A generic "N others do not" reads as nonsense once the
 * property is something like "first write from billing/".
 */
/** Wrap prose on spaces. */
function words_(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line !== '' && width(line) + width(word) + 1 > max) { out.push(line); line = word }
    else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') out.push(line)
  return out
}

/** Break on separators a path actually has, so a wrapped URL stays readable. */
function wrap(text: string, max: number): string[] {
  if (width(text) <= max) return [text]
  const out: string[] = []
  let line = ''
  for (const part of text.split(/(?<=[/?&])/)) {
    if (line !== '' && width(line) + width(part) > max) { out.push(line); line = part }
    else line += part
  }
  if (line !== '') out.push(line)
  return out.flatMap((l) => (width(l) <= max ? [l] : [truncate(l, max)]))
}

export function onlyOne(kind: Fact['kind'], voice: Voice): string {
  // Kept under 25 columns: the right-hand column is that narrow at 60, and a
  // phrase that has to be truncated breaks the rule it exists to honour.
  if (voice === 'plain') {
    if (kind === 'external') return 'the only outside service'
    if (kind === 'write') return 'the only one changing it'
    return 'the only one of its kind'
  }
  if (kind === 'external') return 'only external host'
  if (kind === 'write') return 'only writer'
  return 'only one of its kind'
}

const seeAll = (n: number, voice: Voice, command: string): string => voice === 'plain'
  ? `+${n} more not shown. To see them all, ask your agent to run:\n  ${command} since --all`
  : `+${n} more:\n  ${command} since --all`

export const plainNoun = (noun: string): string => noun
  .replace(/\broutes\b/, 'URLs')
  .replace(/^modules write (.+)$/, 'places change $1')
  .replace(/\bdependencies\b/, 'packages')
  .replace(/\bexternal calls\b/, 'outside services')
export const plainProperty = (p: string): string => p
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
    case 'route': return d.matching === 1
      ? (plain ? 'every other URL is checked' : 'every other route has one')
      : (plain ? `${others} of the rest ${others === 1 ? 'is' : 'are'} checked` : `${others} other${others === 1 ? ' has' : 's have'} one`)
    case 'write': return plain
      ? `${others} other place${others === 1 ? '' : 's'} already could`
      : `${others} other module${others === 1 ? '' : 's'} write it`
    case 'library': return plain
      ? `${others} other package${others === 1 ? ' was' : 's were'} already here`
      : `${others} other dependenc${others === 1 ? 'y was' : 'ies were'} already here`
    case 'external': return plain
      ? `${others} other outside service${others === 1 ? ' was' : 's were'} already used`
      : `${others} other host${others === 1 ? ' was' : 's were'} already called`
    default: return `${others} other${others === 1 ? ' does' : 's do'} not`
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

  // One line per *reason*, not per instance. Twelve router routes sharing one
  // caveat used to bury the single gap that mattered — "I can't read hono" —
  // under eleven copies of the same sentence.
  const byReason = new Map<string, Fact[]>()
  for (const g of gaps) {
    if (g.kind !== 'gap') continue
    const list = byReason.get(g.reason)
    if (list) list.push(g)
    else byReason.set(g.reason, [g])
  }

  const entries = [...byReason.values()]
  const shown = entries.slice(0, COVERAGE_MAX)
  const lines = shown.flatMap((group) => {
    const first = group[0]!
    const text = voice === 'plain' ? w.gap(first) : describeGap(first)
    const more = group.length > 1 ? ` (and ${group.length - 1} more like it)` : ''
    // A blind spot cut off mid-sentence is a blind spot nobody reads.
    return words_(`${text}${more}`, cols - 4).map((l) => `   ${dim(l)}`)
  })
  const rest = entries.length - shown.length
  if (rest > 0) lines.push(`   ${dim(`and ${rest} other kind${rest === 1 ? '' : 's'} of thing I could not read`)}`)
  return lines
}

function describeGap(g: Fact): string {
  if (g.kind !== 'gap') return ''
  switch (g.reason) {
    case 'parse-error': return `${g.subject}: ${g.detail}`
    case 'unsupported-framework': return `${g.subject}: ${g.detail}`
    case 'computed-route-path': return `${g.subject}: route path is built at runtime`
    case 'unresolved-route-prefix': return `${g.subject}: router mounted elsewhere, prefix unknown`
    case 'dynamic-dispatch': return `${g.subject}: dispatches dynamically`
    case 'raw-sql': return `${g.subject}: raw SQL, not parsed`
    case 'unresolved-import': return `${g.subject}: ${g.detail}`
  }
}

export const _internal = { prose, coverageLines, corroboration, width }
