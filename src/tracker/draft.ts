import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from './tasks.js'

/**
 * A task drafted for the PM's tracker, in the tracker's own shape: the field
 * order its template uses, in a dated section of its own, before the log and
 * summary a tracker keeps at its end. Written only when the PM asks, after
 * seeing the exact text.
 */
export interface TaskDraft {
  id: string
  title: string
  why: string
  /** Each line names a file, a screen or a route: what the task is about. */
  evidence: string[]
  criteria: string[]
}

const ID = /^[A-Z]{1,3}\d{1,3}$/

/** The next ID in the family the tracker used last: after EE1, EE2. */
export function suggestId(tasks: readonly Task[], file: string): string {
  const mine = tasks.filter((t) => t.file === file).sort((a, b) => a.line - b.line)
  const last = mine[mine.length - 1] ?? tasks[tasks.length - 1]
  const family = last === undefined ? 'T' : /^[A-Z]+/.exec(last.id)![0]
  const used = new Set(tasks.map((t) => t.id))
  let n = Math.max(0, ...tasks.filter((t) => /^[A-Z]+/.exec(t.id)![0] === family).map((t) => Number(/\d+$/.exec(t.id)![0]))) + 1
  while (used.has(`${family}${n}`)) n++
  return `${family}${n}`
}

/** Why a draft cannot be written yet, or null. */
export function problemWith(d: TaskDraft, tasks: readonly Task[]): string | null {
  if (!ID.test(d.id)) return 'An ID is one to three capital letters and a number, like EE2.'
  if (tasks.some((t) => t.id === d.id)) return `${d.id} is already a task in your tracker.`
  if (d.title.trim() === '') return 'Say what should change.'
  if (d.criteria.every((c) => c.trim() === '')) return 'Add at least one "done when" — Claude checks its work against these.'
  return null
}

export function formatTask(d: TaskDraft): string {
  const lines = [
    `### ${d.id} — ${oneLine(d.title)}`,
    '',
    '- **Status:** TODO',
  ]
  if (d.why.trim() !== '') lines.push(`- **Why it matters:** ${oneLine(d.why)}`)
  if (d.evidence.length > 0) {
    lines.push('- **Evidence:**')
    for (const e of d.evidence) lines.push(`  - ${oneLine(e)}`)
  }
  lines.push('- **Acceptance criteria:**')
  for (const c of d.criteria.filter((x) => x.trim() !== '')) lines.push(`  - ${oneLine(c)}`)
  lines.push('- **Worklog:**', '')
  return lines.join('\n')
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The tracker with the task in today's App Guide section — made if missing,
 *  before the tracker's closing log and summary if it has them. */
export function insertTask(tracker: string, task: string, date: string): { text: string; line: number } {
  const heading = `## Asked for in App Guide (${date})`
  const lines = tracker.split('\n')
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at !== -1) {
    let end = at + 1
    while (end < lines.length && !/^## /.test(lines[end]!)) end++
    while (end > at + 1 && lines[end - 1]!.trim() === '') end--
    lines.splice(end, 0, '', ...task.trimEnd().split('\n'))
    return { text: `${lines.join('\n').replace(/\n*$/, '')}\n`, line: end + 2 }
  }
  const closing = lines.findIndex((l) => /^## (Run log|Closing summary|Summary)\b/i.test(l))
  const block = [heading, '', ...task.trimEnd().split('\n'), '']
  if (closing === -1) {
    const body = tracker.replace(/\n*$/, '')
    return { text: `${body}\n\n${block.join('\n')}`, line: body.split('\n').length + 4 }
  }
  lines.splice(closing, 0, ...block)
  return { text: lines.join('\n'), line: closing + 3 }
}

/** Write it — the one change the app makes to a repository, and only this file. */
export async function addTask(root: string, file: string, task: string, date: string): Promise<{ line: number }> {
  const path = join(root, file)
  const current = await readFile(path, 'utf8')
  const { text, line } = insertTask(current, task, date)
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
  return { line }
}
