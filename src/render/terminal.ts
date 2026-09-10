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
const FRAME_LINES = 3

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
  const head = ` ${bold('appguide')} ${dim('·')} ${session(report)} ${dim('·')} `
  const lines = width(head) + width(headline) <= cols
    ? [`${head}${headline}`]
    : [` ${bold('appguide')} ${dim('·')} ${session(report)}`, `   ${dim(truncate(headline, cols - 4))}`]
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

  // A wrapped subject makes an entry taller, so at a narrow terminal three
  // findings may not fit. Drop the last rather than overflow — the budget is
  // what makes length a severity signal, and an entry that spills is worse
  // than one deferred to `--all`.
  const top: string[] = []
  let topShown = 0
  if (report.top.length > 0) {
    const reserve = 4 /* header + blank + label */ + (report.gaps.length > 0 ? 4 : 0) + 3 /* footer */ + FRAME_LINES
    let used = 0
    const body: string[] = []
    for (const change of report.top) {
      const rendered = entry(change, cols, true, voice, n + 1)
      if (used + rendered.length + reserve + prose(report.summary, cols).length > MAX_LINES + FRAME_LINES) break
      body.push(...rendered)
      used += rendered.length
      n += 1
      topShown += 1
    }
    if (body.length > 0) top.push('', ` ${dim(w.labels.top)}`, ...body)
  }
  const deferred = report.top.length - topShown

  const coverage: string[] = []
  if (report.gaps.length > 0) {
    coverage.push('', ` ${dim(w.labels.gaps)}`, ...coverageLines(report.gaps, cols, voice),
      ...words_(voice === 'plain'
        ? `→ anything your agent changed in ${report.gaps.length === 1 ? 'it' : 'these'} is missing from the list above`
        : `→ a change ${report.gaps.length === 1 ? 'in it' : 'in any of these'} would not appear above`, cols - 4)
        .map((l) => `   ${dim(l)}`))
  }

  const hidden = opts.hiddenCount ?? report.totalChanges
  const footer = ['', ...w.footer(hidden, report.top.length > 0, cols).split('\n').map((l) => `   ${dim(truncate(l, cols - 4))}`)]

  // Everything above is fixed cost. `also` is the only section allowed to give
  // ground — the coverage block never is, because a receipt that drops its own
  // blind spots to save room is the failure this tool exists to prevent.
  const fixed = head.length + top.length + coverage.length + footer.length + FRAME_LINES
  const also: string[] = []
  const available = MAX_LINES + FRAME_LINES - fixed
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
    const rest = report.also.length - shown.length + deferred
    if (rest > 0) also.push(`   ${dim(seeAll(rest, voice))}`)
  } else if (report.also.length + deferred > 0) {
    // No room for the section at all. Still say the rest exists — the summary
    // sentence may have led with a kind that never made the list.
    also.push('', `   ${dim(seeAll(report.also.length + deferred, voice))}`)
  }

  // Estimating what will fit is fragile once entries can wrap, so the budget is
  // enforced as a post-condition instead. Sections give ground in a fixed
  // order, and coverage and the footer never do: a receipt that drops its own
  // blind spots to save a line is the failure this tool exists to prevent.
  const body = fit([head, top, also], coverage.length + footer.length)
  return frame([...body, ...coverage, ...footer], cols)
}

/** Trims `also` first, then `top`, never the sections passed as fixed cost. */
function fit(sections: readonly string[][], fixedCost: number): string[] {
  const [head = [], top = [], also = []] = sections
  const budget = MAX_LINES - fixedCost
  const trimmable = [also, top]
  const kept = [[...also], [...top]]

  const total = (): number => head.length + kept[1]!.length + kept[0]!.length
  for (let i = 0; i < trimmable.length && total() > budget; i++) {
    // Keep at least the section label plus one line, or the header is orphaned.
    while (total() > budget && kept[i]!.length > 0) kept[i]!.pop()
  }
  const [alsoKept = [], topKept = []] = kept
  return [...head, ...(topKept.length > 2 ? topKept : []), ...(alsoKept.length > 2 ? alsoKept : [])]
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

const seeAll = (n: number, voice: Voice): string => voice === 'plain'
  ? `+${n} more — ask your agent to run: appguide --all`
  : `+${n} more · appguide since --all`

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
    case 'route': return d.matching === 1
      ? (plain ? 'every other URL is checked' : 'every other route has one')
      : (plain ? `${others} of the rest are checked` : `${others} others have one`)
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
