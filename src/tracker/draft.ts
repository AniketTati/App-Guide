import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from './tasks.js'

/**
 * A task drafted for the PM's tracker, in the tracker's own shape: the way its
 * newest entries are written, in a dated section of its own, before the log
 * and summary a tracker keeps at its end. Written only when the PM asks, after
 * seeing the exact text, and only if the file is still what they saw.
 */
export interface TaskDraft {
  id: string
  title: string
  why: string
  /** Each line names a file, a screen or a route: what the task is about. */
  evidence: string[]
  criteria: string[]
  /** In the tracker's words: Critical, High, Medium or Low. */
  severity: string | null
}

/** `## S2 — title` with **Field:** lines, or `- **EE1 — title. — DONE.**` with notes under it. */
export type Shape = 'heading' | 'list'

const ID = /^[A-Z]{1,3}\d{1,3}$/
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const

/** The shape the tracker's newest task is written in. */
export function shapeOf(tasks: readonly Task[], file: string, tracker: string): Shape {
  const mine = tasks.filter((t) => t.file === file).sort((a, b) => a.line - b.line)
  const last = mine[mine.length - 1]
  if (last === undefined) return 'heading'
  return /^\s*[-*]\s+\*\*/.test(tracker.split('\n')[last.line - 1] ?? '') ? 'list' : 'heading'
}

export const sectionHeading = (date: string): string => `## Asked for in App Guide (${date})`

/**
 * The ID a new task gets. Today's App Guide section keeps one family: FF1,
 * then FF2. A new section starts the family after the tracker's newest — after
 * EE, FF — so a PM's ask is never filed under someone else's piece of work.
 * Never an ID or a family any branch already uses.
 */
export function suggestId(tasks: readonly Task[], file: string, tracker: string, date: string, used: ReadonlySet<string>): string {
  const familyOf = (id: string): string => /^[A-Z]+/.exec(id)![0]
  const usedFamilies = new Set([...used].map(familyOf))
  const mine = tasks.filter((t) => t.file === file).sort((a, b) => a.line - b.line)
  const section = sectionRange(tracker, date)
  const inSection = section === null ? [] : mine.filter((t) => t.line > section[0] && t.line <= section[1])
  let family: string
  if (inSection.length > 0) family = familyOf(inSection[0]!.id)
  else {
    family = nextFamily(mine.length === 0 ? 'S' : familyOf(mine[mine.length - 1]!.id))
    for (let i = 0; i < 400 && usedFamilies.has(family); i++) family = nextFamily(family)
  }
  let n = 1 + Math.max(0, ...[...used].filter((id) => familyOf(id) === family).map((id) => Number(/\d+$/.exec(id)![0])))
  while (used.has(`${family}${n}`)) n++
  return `${family}${n}`
}

/** After EE, FF; after Z, AA; after TC, TD. */
export function nextFamily(f: string): string {
  if ([...f].every((c) => c === f[0])) return f[0] === 'Z' ? 'A'.repeat(Math.min(f.length + 1, 3)) : String.fromCharCode(f.charCodeAt(0) + 1).repeat(f.length)
  const chars = [...f]
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'Z') { chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1); return chars.join('') }
    chars[i] = 'A'
  }
  return chars.length < 3 ? `A${chars.join('')}` : 'AAA'
}

/** Lines [heading, last] of today's App Guide section, if it has one. */
function sectionRange(tracker: string, date: string): [number, number] | null {
  const lines = tracker.split('\n')
  const at = lines.findIndex((l) => l.trim() === sectionHeading(date))
  if (at === -1) return null
  let end = at + 1
  while (end < lines.length && !/^## /.test(lines[end]!)) end++
  return [at + 1, end]
}

/** Why a draft cannot be written yet, or null. */
export function problemWith(d: TaskDraft, used: ReadonlySet<string>): string | null {
  if (!ID.test(d.id)) return 'An ID is one to three capital letters and a number, like FF1.'
  if (used.has(d.id)) return `${d.id} is already a task — in your tracker or on a branch.`
  if (d.title.trim() === '') return 'Say what should change.'
  if (d.criteria.every((c) => c.trim() === '')) return 'Add at least one “done when” — Claude checks its work against these.'
  return null
}

export function formatTask(d: TaskDraft, shape: Shape): string {
  const criteria = d.criteria.filter((x) => x.trim() !== '')
  if (shape === 'list') {
    const lines = [`- **${d.id} — ${oneLine(d.title).replace(/\.$/, '')}${d.severity === null ? '' : ` (${d.severity})`}. — TODO.**`]
    if (d.why.trim() !== '') lines.push(`  - Why it matters: ${oneLine(d.why)}`)
    if (d.evidence.length > 0) {
      lines.push('  - Where:')
      for (const e of d.evidence) lines.push(`    - ${oneLine(e)}`)
    }
    lines.push('  - Done when:')
    for (const c of criteria) lines.push(`    - ${oneLine(c)}`)
    return `${lines.join('\n')}\n`
  }
  const lines = [`### ${d.id} — ${oneLine(d.title)}`, '', '- **Status:** TODO']
  if (d.severity !== null) lines.push(`- **Severity:** ${d.severity}`)
  if (d.why.trim() !== '') lines.push(`- **Why it matters:** ${oneLine(d.why)}`)
  if (d.evidence.length > 0) {
    lines.push('- **Evidence:**')
    for (const e of d.evidence) lines.push(`  - ${oneLine(e)}`)
  }
  lines.push('- **Acceptance criteria:**')
  for (const c of criteria) lines.push(`  - ${oneLine(c)}`)
  lines.push('- **Worklog:**', '')
  return lines.join('\n')
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * The tracker with the task in today's App Guide section — made if missing,
 * before the tracker's closing log and summary if it has them — and `block`,
 * exactly the lines added, heading included when the section is new.
 */
export function insertTask(tracker: string, task: string, date: string): { text: string; line: number; block: string } {
  const heading = sectionHeading(date)
  const lines = tracker.split('\n')
  const body = task.trimEnd().split('\n')
  const range = sectionRange(tracker, date)
  if (range !== null) {
    let end = range[1]
    while (end > range[0] && lines[end - 1]!.trim() === '') end--
    lines.splice(end, 0, '', ...body)
    return { text: `${lines.join('\n').replace(/\n*$/, '')}\n`, line: end + 2, block: body.join('\n') }
  }
  const closing = lines.findIndex((l) => /^## (Run log|Closing summary|Summary)\b/i.test(l))
  const block = [heading, '', ...body, '']
  if (closing === -1) {
    const kept = tracker.replace(/\n*$/, '')
    return { text: `${kept}\n\n${block.join('\n')}`, line: kept.split('\n').length + 4, block: block.join('\n').trimEnd() }
  }
  lines.splice(closing, 0, ...block)
  return { text: lines.join('\n'), line: closing + 3, block: block.join('\n').trimEnd() }
}

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * Write it — the one change the app makes to a repository, and only this
 * file — if the file is still exactly what the PM saw when they approved the
 * text; checked again just before the new version takes its place.
 */
export async function addTask(root: string, file: string, task: string, date: string, expected: string): Promise<{ line: number }> {
  const path = join(root, file)
  const current = await readFile(path, 'utf8')
  if (digest(current) !== expected) throw new Error(`${file} changed since you saw the preview — look at it again.`)
  const { text, line } = insertTask(current, task, date)
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text, 'utf8')
  if (digest(await readFile(path, 'utf8')) !== expected) {
    await rm(tmp, { force: true })
    throw new Error(`${file} changed while the task was being added — nothing was written.`)
  }
  await rename(tmp, path)
  return { line }
}
