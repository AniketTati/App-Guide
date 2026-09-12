import type { Change, Report } from '../model/report.js'
import { subject } from '../diff/rank.js'
import { words, type Voice } from './words.js'

/**
 * A prompt the reader can hand to their agent verbatim.
 *
 * The point is not automation — the receipt is already printed into the agent's
 * terminal, so it can usually see it. The point is that someone who cannot act
 * on a finding themselves can still forward one, without having to describe in
 * their own words a thing they do not have words for.
 */
export function ask(report: Report, index: number, voice: Voice = 'technical'): string | null {
  const all = [...report.top, ...report.also]
  const change = all[index - 1]
  if (change === undefined) return null
  const w = words(voice)

  const f = change.fact
  const where = `${f.where.file}:${f.where.line}`
  const lines = [
    `In my codebase, appguide reports this changed since I last looked:`,
    '',
    `  ${change.type} ${w.kind(f)}: ${subject(f)}`,
    `  at ${where}`,
  ]

  if (change.denominator !== undefined) {
    const d = change.denominator
    lines.push(d.total === 1 && d.matching === 1
      ? `  ${d.property} — the only one of its kind in the codebase`
      : `  ${d.property} — ${d.matching} of ${d.total} ${d.noun}`)
  }
  lines.push(...context(change))
  lines.push(
    '',
    'Please: read that code, explain in plain language what it does and why it',
    'might have been added, and tell me whether I should be concerned. If I',
    'should, propose the smallest change that addresses it — and ask me before',
    'changing anything.',
  )
  return `${lines.join('\n')}\n`
}

/** What the tool knows that the agent would otherwise have to re-derive. */
function context(change: Change): string[] {
  const f = change.fact
  switch (f.kind) {
    case 'route':
      return f.middleware === 'unresolved'
        ? ['  I could not determine what runs before it.']
        : [`  Things that run first: ${f.middleware.length === 0 ? 'nothing' : f.middleware.join(', ')}`]
    case 'library':
      return [`  Version ${f.version}${f.direct ? '' : ', not listed in package.json'}`,
        ...(f.importers.length > 0 ? [`  Imported by: ${f.importers.slice(0, 5).join(', ')}`] : [])]
    case 'external': return [`  Reached via ${f.via}.`]
    case 'write': return [`  ${f.module} writes to the ${f.table} table.`]
    case 'read': return [`  ${f.module} reads the ${f.table} table.`]
    default: return []
  }
}
