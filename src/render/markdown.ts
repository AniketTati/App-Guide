import type { Change, Report } from '../model/report.js'
import { subject } from '../diff/rank.js'

/**
 * For a PR comment or a Slack paste. Shareability is the distribution
 * mechanism: nobody forwards a terminal screenshot, and a finding that cannot
 * be forwarded never reaches the person who cares about it.
 */
export function renderMarkdown(report: Report): string {
  const out: string[] = [`**appguide** — ${report.session.files} files`, '', report.summary]
  if (report.firstRun === true) {
    out.push('', '_Nothing is compared on a first run. Run again after your next session._')
    return `${out.join('\n')}\n`
  }

  if (report.top.length > 0) {
    out.push('', '| | change | evidence |', '|---|---|---|')
    for (const c of report.top) out.push(row(c))
  }
  if (report.also.length > 0) {
    out.push('', '<details><summary>Also changed</summary>', '', '| | change | evidence |', '|---|---|---|')
    for (const c of report.also) out.push(row(c))
    out.push('', '</details>')
  }
  if (report.gaps.length > 0) {
    out.push('', '> **Not covered.** A change in any of these would not appear above.')
    for (const g of report.gaps) {
      if (g.kind === 'gap') out.push(`> - \`${g.subject}\` — ${g.detail}`)
    }
  }
  return `${out.join('\n')}\n`
}

function row(c: Change): string {
  const d = c.denominator
  const evidence = d === undefined
    ? `\`${c.fact.where.file}:${c.fact.where.line}\``
    : `${d.property} · **${d.matching} of ${d.total}** ${d.noun} — \`${c.fact.where.file}:${c.fact.where.line}\``
  return `| ${c.fact.kind} | ${c.type === 'added' ? '' : `${c.type} `}\`${subject(c.fact)}\` | ${evidence} |`
}
