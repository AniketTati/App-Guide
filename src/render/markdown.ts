import type { Change, Report } from '../model/report.js'
import { subject } from '../diff/rank.js'
import { words, type Voice } from './words.js'
import { plainNoun, plainProperty } from './terminal.js'

/**
 * For a PR comment or a Slack paste. Shareability is the distribution
 * mechanism: nobody forwards a terminal screenshot, and a finding that cannot
 * be forwarded never reaches the person who cares about it.
 */
export function renderMarkdown(report: Report, voice: Voice = 'technical'): string {
  const w = words(voice)
  const out: string[] = [`**appguide** — ${report.session.files} files`, '', report.summary]
  if (report.firstRun === true) {
    out.push('', '_Nothing is compared on a first run. Run again after your next session._')
    return `${out.join('\n')}\n`
  }

  if (report.top.length > 0) {
    out.push('', '| | change | evidence |', '|---|---|---|')
    for (const c of report.top) out.push(row(c, w, voice))
  }
  if (report.also.length > 0) {
    out.push('', '<details><summary>Also changed</summary>', '', '| | change | evidence |', '|---|---|---|')
    for (const c of report.also) out.push(row(c, w, voice))
    out.push('', '</details>')
  }
  if (report.gaps.length > 0) {
    out.push('', '> **Not covered.** A change in any of these would not appear above.')
    for (const g of report.gaps) {
      if (g.kind === 'gap') out.push(`> - ${voice === 'plain' ? w.gap(g) : `\`${g.subject}\` — ${g.detail}`}`)
    }
  }
  return `${out.join('\n')}\n`
}

function row(c: Change, w: ReturnType<typeof words>, voice: Voice): string {
  const d = c.denominator
  const plain = voice === 'plain'
  const at = `\`${c.fact.where.file}:${c.fact.where.line}\``
  // The labels were translated but the evidence column still said "no
  // middleware" and "modules write users" — the version a friend can't read.
  if (d !== undefined) {
    const prop = plain ? plainProperty(d.property) : d.property
    const noun = plain ? plainNoun(d.noun) : d.noun
    const count = d.total === 1 && d.matching === 1 ? '**the only one**' : `**${d.matching} of ${d.total}** ${noun}`
    return `| ${w.kind(c.fact)} | ${c.type === 'added' ? '' : `${c.type} `}\`${subject(c.fact)}\` | ${prop} · ${count} — ${at} |`
  }
  if (plain && w.detail(c) !== '') {
    return `| ${w.kind(c.fact)} | ${c.type === 'added' ? '' : `${c.type} `}\`${subject(c.fact)}\` | ${w.detail(c)} — ${at} |`
  }
  return `| ${w.kind(c.fact)} | ${c.type === 'added' ? '' : `${c.type} `}\`${subject(c.fact)}\` | ${at} |`
}
