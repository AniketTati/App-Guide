import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Tasks as the PM's own tracker writes them — read, never rewritten. Two
 * shapes appear in one file:
 *
 *   ## S2 — Agent tools ignore the `own` permission scope
 *   - **Status:** VERIFY-PENDING
 *   - **Acceptance criteria:**
 *     - …
 *   - **Worklog:**
 *     - **Verified:** …
 *
 *   - **DD1 — Liability caps were reasoned about, not measured. — DONE.**
 *     - …
 */
export interface Task {
  id: string
  title: string
  /** As written: TODO, IN-PROGRESS, DONE, VERIFY-PENDING, BLOCKED, … */
  status: string | null
  file: string
  line: number
  /** Every top-level `**Label:** text` in the task, by label. */
  fields: Record<string, string>
  criteria: string[]
  worklog: { label: string; text: string }[]
  /** Repository paths the task names, line numbers dropped. */
  cites: string[]
  /** File names it mentions with or without a path — `review-queue.ts`. */
  mentions: string[]
  /** The task as written, below its first line. */
  text: string
}

const ID = /[A-Z]{1,3}\d{1,3}/
// `## S2 — title`, `### P1: title`, `### W3. title`
const HEADING = new RegExp(`^(#{2,4})\\s+(${ID.source})(?:\\s+[—–-]+|\\s*[:.])\\s+(.+?)\\s*$`)
const BOLD_ITEM = new RegExp(`^(\\s*)[-*]\\s+\\*\\*(${ID.source})\\s+[—–-]+\\s+(.+?)\\*\\*\\s*$`)
const FIELD = /^[-*]\s+\*\*([^*]+?):\*\*\s*(.*)$/
const NESTED = /^\s{2,}[-*]\s+(.*)$/
const NESTED_FIELD = /^\s{2,}[-*]\s+\*\*([^*]+?):\*\*\s*(.*)$/
const STATUS_WORD = /^([A-Z][A-Z-]{2,})\b/
const PATH = /`?((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]{1,5})(?::\d+(?:[-–]\d+)?)?`?/g

export function parseTasks(file: string, text: string): Task[] {
  const lines = text.split('\n')
  const tasks: Task[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1]!.length
      let end = i + 1
      while (end < lines.length) {
        const l = lines[end]!
        const h = /^(#{1,6})\s/.exec(l)
        if ((h !== null && h[1]!.length <= level) || /^-{3,}\s*$/.test(l)) break
        end++
      }
      tasks.push(fromHeading(file, i + 1, heading[2]!, heading[3]!, lines.slice(i + 1, end)))
      continue
    }
    const bold = BOLD_ITEM.exec(line)
    if (bold !== null) {
      const indent = bold[1]!.length
      let end = i + 1
      while (end < lines.length) {
        const l = lines[end]!
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break
        end++
      }
      tasks.push(fromBold(file, i + 1, bold[2]!, bold[3]!, lines.slice(i + 1, end)))
    }
  }
  return tasks
}

function fromHeading(file: string, line: number, id: string, title: string, body: string[]): Task {
  const fields: Record<string, string> = {}
  const criteria: string[] = []
  const worklog: { label: string; text: string }[] = []
  let current: string | null = null
  for (const l of body) {
    const field = FIELD.exec(l)
    if (field !== null) {
      current = field[1]!.trim()
      fields[current] = field[2]!.trim()
      continue
    }
    if (current === null) continue
    const key = current.toLowerCase()
    if (key.startsWith('acceptance')) {
      const nested = NESTED.exec(l)
      if (nested !== null) criteria.push(nested[1]!.trim())
    } else if (key === 'worklog') {
      const entry = NESTED_FIELD.exec(l)
      if (entry !== null) worklog.push({ label: entry[1]!.trim(), text: entry[2]!.trim() })
    }
  }
  const status = STATUS_WORD.exec(fields['Status'] ?? '')?.[1] ?? null
  const all = [title, ...body].join('\n')
  return { id, title: clean(title), status, file, line, fields, criteria, worklog, cites: cites(all), mentions: mentions(all), text: body.join('\n').trim() }
}

function fromBold(file: string, line: number, id: string, inner: string, body: string[]): Task {
  // "Liability caps were reasoned about, not measured. — DONE."
  const m = /^(.*?)\s+[—–-]+\s+([A-Z][A-Z-]{2,})\.?\s*$/.exec(inner)
  const title = m === null ? inner : m[1]!
  const all = [inner, ...body].join('\n')
  return {
    id, title: clean(title), status: m === null ? null : m[2]!, file, line,
    fields: {}, criteria: [], worklog: [], cites: cites(all), mentions: mentions(all),
    text: dedent(body).join('\n').trim(),
  }
}

const clean = (title: string): string => title.replace(/\.\s*$/, '').trim()

function cites(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PATH)) {
    const path = m[1]!
    if (/^https?:|^www\./.test(path) || path.includes('://')) continue
    out.add(path)
  }
  return [...out].sort()
}

const FILE_NAME = /(?:^|[\s`(/])([\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|py|prisma|sql|json|md|css|go|rb|rs))\b/g

function mentions(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(FILE_NAME)) out.add(m[1]!)
  return [...out].sort()
}

/** Nested lines lose the indent they had under their bullet. */
function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  const cut = indents.length === 0 ? 0 : Math.min(...indents)
  return lines.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length)))
}

/**
 * The task IDs a commit is for, from the group its subject ends with:
 * "…found (DD5-DD7)" -> DD5, DD6, DD7. Only a group made entirely of IDs
 * counts, so "(and the portal)" is not read as a task.
 */
export function taskIdsOf(subject: string): string[] {
  const group = /\(([^()]*)\)\s*$/.exec(subject)?.[1]
  if (group === undefined) return []
  const out: string[] = []
  for (const part of group.split(',').map((p) => p.trim())) {
    const single = /^([A-Z]{1,3})(\d{1,3})$/.exec(part)
    const range = /^([A-Z]{1,3})(\d{1,3})\s*[-–]\s*(?:([A-Z]{1,3}))?(\d{1,3})$/.exec(part)
    if (single !== null) out.push(part)
    else if (range !== null && (range[3] === undefined || range[3] === range[1])) {
      const [from, to] = [Number(range[2]), Number(range[4])]
      if (to < from || to - from > 50) return []
      for (let n = from; n <= to; n++) out.push(`${range[1]}${n}`)
    } else return []
  }
  return out
}

/**
 * Every task the repository's trackers define. Files named like a tracker at
 * the top come first, then the planning documents in docs/; when two define
 * the same ID, the first wins.
 */
export async function readTasks(root: string): Promise<Task[]> {
  const top = (await readdir(root).catch(() => [] as string[])).filter((f) => /\.md$/i.test(f)).sort()
  const docs = (await readdir(join(root, 'docs')).catch(() => [] as string[])).filter((f) => /\.md$/i.test(f)).sort().map((f) => `docs/${f}`)
  const order = [...top.filter((f) => /tracker/i.test(f)), ...top.filter((f) => !/tracker/i.test(f)), ...docs]
  const seen = new Set<string>()
  const out: Task[] = []
  for (const file of order) {
    let text: string
    try { text = await readFile(join(root, file), 'utf8') } catch { continue }
    for (const task of parseTasks(file, text)) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      out.push(task)
    }
  }
  return out
}

/** Statuses that mean the PM is the next person to act. */
export const WAITING = new Set(['VERIFY-PENDING', 'BLOCKED'])
