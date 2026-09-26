import { basename } from 'node:path'
import type { Fact } from '../../../src/model/facts.js'
import type { Change } from '../../../src/model/report.js'
import type { Task } from '../../../src/tracker/tasks.js'
import type { Check, Work } from '../../../src/check/work.js'
import type { Commit } from '../../../src/git/repo.js'
import { plain } from '../../../src/render/words.js'
import type { BlindSpot, ChangeKind, ChangeView, CheckView, CommitView, ProductCounts, TaskView, WorkView } from '../shared/api.js'

/** Engine results into views, in the PM's words. No I/O here. */

export function taskView(t: Task): TaskView {
  return { id: t.id, title: t.title, status: t.status, file: t.file, line: t.line, fields: t.fields, criteria: t.criteria, worklog: t.worklog, text: t.text }
}

export function changeView(c: Change): ChangeView | null {
  const f = c.fact
  const where = `${f.where.file}:${f.where.line}`
  const count = c.denominator === undefined ? undefined
    : c.denominator.total === 1 && c.denominator.matching === 1 ? undefined
    : `${c.denominator.property} · ${c.denominator.matching} of ${c.denominator.total} ${c.denominator.noun}`
  const base = { type: c.type, where, ...(count === undefined ? {} : { count }) }
  switch (f.kind) {
    case 'route': {
      const checks = f.middleware === 'unresolved' ? 'unresolved' as const : [...f.middleware]
      const detail = c.type === 'removed' ? 'no longer served'
        : checks === 'unresolved' ? "I couldn't tell what checks it"
        : checks.length === 0 ? 'no check found before it runs'
        : c.type === 'changed' ? 'what runs before it changed'
        : `${checks.length} check${checks.length === 1 ? '' : 's'} before it runs`
      return { ...base, kind: 'route', title: `${f.method} ${f.path}`, detail, checks }
    }
    case 'write':
      return { ...base, kind: 'data', title: f.table, detail: c.type === 'removed' ? `${f.module} no longer changes it` : `${f.module} now changes it` }
    case 'read':
      return { ...base, kind: 'data', title: f.table, detail: c.type === 'removed' ? `${f.module} no longer reads it` : `${f.module} now reads it` }
    case 'external':
      return { ...base, kind: 'service', title: f.host, detail: c.type === 'removed' ? 'no longer called' : f.via === 'url' ? 'called directly' : `called through ${f.via}` }
    case 'library': {
      const was = c.previous?.kind === 'library' ? c.previous.version : undefined
      const detail = c.type === 'removed' ? 'removed'
        : c.type === 'changed' ? (was !== undefined && was !== f.version ? `${was} → ${f.version}` : 'how it is used changed')
        : `${f.version}${f.direct ? '' : ", which isn't in a package list"}`
      return { ...base, kind: 'package', title: f.name, detail }
    }
    case 'export':
      // Where it lives is already on the row.
      return { ...base, kind: 'code', title: f.symbol, detail: '' }
    case 'gap':
      return null
  }
}

export function groupChanges(changes: readonly Change[]): Record<ChangeKind, ChangeView[]> {
  const out: Record<ChangeKind, ChangeView[]> = { route: [], data: [], service: [], package: [], code: [] }
  for (const c of changes) {
    const v = changeView(c)
    if (v !== null) out[v.kind].push(v)
  }
  // Routes with no check found first; then by address.
  out.route.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || (a.title < b.title ? -1 : 1))
  for (const k of ['data', 'service', 'package', 'code'] as const) out[k].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return out
}

const isOpen = (v: ChangeView): boolean => Array.isArray(v.checks) && v.checks.length === 0

/** One line per kind of blind spot, with how many and where the first is. */
export function blindSpots(facts: readonly Fact[]): BlindSpot[] {
  const groups = new Map<string, Extract<Fact, { kind: 'gap' }>[]>()
  for (const f of facts) {
    if (f.kind !== 'gap') continue
    const key = f.reason === 'unsupported-framework' || f.reason === 'unsupported-language' ? `${f.reason}:${f.subject}` : f.reason
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }
  const out: BlindSpot[] = []
  for (const list of groups.values()) {
    const first = list[0]!
    const count = first.reason === 'unsupported-language' ? Number(/^(\d+)/.exec(first.detail)?.[1] ?? list.length) : list.length
    out.push({ text: blindText(first, list.length), short: blindShort(first, list.length, count), count, example: `${first.where.file}:${first.where.line}` })
  }
  return out.sort((a, b) => b.count - a.count)
}

/** A few words for the status bar, after "Can't read". */
function blindShort(g: Extract<Fact, { kind: 'gap' }>, n: number, count: number): string {
  const s = n === 1 ? '' : 's'
  switch (g.reason) {
    case 'unsupported-language': return `${count.toLocaleString()} ${g.subject} file${count === 1 ? '' : 's'}`
    case 'unsupported-framework': return g.subject
    case 'raw-sql': return `${n} hand-written quer${n === 1 ? 'y' : 'ies'}`
    case 'dynamic-dispatch': return `routes added in ${n} place${s} I can't follow`
    case 'computed-route-path': return `${n} address${n === 1 ? '' : 'es'} built at runtime`
    case 'unresolved-route-prefix': return `${n} route group${s} mounted out of sight`
    case 'unresolved-import': return `${n} undeclared package${s}`
    case 'parse-error': return `${n} file${s} that didn't parse`
  }
}

function blindText(g: Extract<Fact, { kind: 'gap' }>, n: number): string {
  const many = n > 1
  switch (g.reason) {
    case 'unsupported-language': return `${g.detail.replace(/ — .*$/, '')}: I can't read ${g.subject} yet`
    case 'unsupported-framework': return plain.gap(g)
    case 'raw-sql': return `${n} hand-written database quer${many ? 'ies' : 'y'} — the tables ${many ? 'they' : 'it'} touch aren't listed`
    case 'dynamic-dispatch': return `${n} place${many ? 's' : ''} where routes are added in a way I can't follow`
    case 'computed-route-path': return `${n} route${many ? 's' : ''} whose address is built while the app runs`
    case 'unresolved-route-prefix': return `${n} group${many ? 's' : ''} of routes mounted somewhere I can't see`
    case 'unresolved-import': return `${n} package${many ? 's' : ''} used but not in any package list`
    case 'parse-error': return `${n} file${many ? 's' : ''} I couldn't read`
  }
}

export function productCounts(facts: readonly Fact[]): ProductCounts {
  const routes = facts.filter((f): f is Extract<Fact, { kind: 'route' }> => f.kind === 'route')
  return {
    routes: routes.length,
    noCheck: routes.filter((r) => Array.isArray(r.middleware) && r.middleware.length === 0).length,
    tables: new Set(facts.flatMap((f) => (f.kind === 'write' || f.kind === 'read' ? [f.table] : []))).size,
    services: new Set(facts.flatMap((f) => (f.kind === 'external' ? [f.host] : []))).size,
    packages: facts.filter((f) => f.kind === 'library' && f.direct).length,
    files: 0,
  }
}

export function workView(w: Work, all: readonly Work[], tasks: ReadonlyMap<string, Task>, checked: { at: string; head: string; dirty: number } | undefined): WorkView {
  const others = all.filter((o) => o.id !== w.id)
  const sharesWith = others
    .map((o) => ({ label: labelOf(o), files: o.changed.filter((f) => w.changed.includes(f)).length }))
    .filter((s) => s.files > 0)
  return {
    id: w.id,
    branch: w.branch,
    where: w.primary ? 'checkout' : 'worktree',
    label: labelOf(w),
    ahead: w.ahead,
    uncommitted: w.uncommitted.length,
    changed: w.changed.length,
    tasks: w.tasks.map((id) => {
      const t = tasks.get(id)
      return { id, title: t?.title ?? 'not in any tracker', status: t?.status ?? null }
    }),
    sharesWith,
    lastCommit: w.lastCommit,
    checkedAt: checked?.at ?? null,
    movedSinceCheck: checked !== undefined && (checked.head !== w.head || checked.dirty !== w.uncommitted.length),
  }
}

export const labelOf = (w: Work): string => (w.primary ? 'your checkout' : basename(w.path ?? w.branch ?? w.id))

export const commitView = (c: Commit & { tasks: string[] }): CommitView => ({ sha: c.sha.slice(0, 7), subject: c.subject, date: c.date, tasks: c.tasks })

export function checkView(c: Check, all: readonly Work[], tasks: ReadonlyMap<string, Task>, checked: { at: string; head: string; dirty: number } | undefined): CheckView {
  const work = workView(c.work, all, tasks, checked)
  const changes = groupChanges([...c.report.top, ...c.report.also])
  return {
    work,
    base: c.base,
    sentence: c.report.summary,
    commits: c.commits.map(commitView),
    tasks: c.tasks.map(taskView),
    unknownTasks: c.unknownTasks,
    changes,
    tests: c.tests,
    outside: c.outside,
    shared: c.overlaps,
    blind: blindSpots(c.facts.head),
    followUp: followUp(c, work, changes),
  }
}

/** What the PM can paste into Claude after reading a Check: the facts, and a
 *  question — never an instruction to change anything on its own. */
function followUp(c: Check, work: WorkView, changes: Record<ChangeKind, ChangeView[]>): string {
  const lines = [
    `I'm checking the work on ${work.branch ?? work.label} before it merges. App Guide read it against ${c.base}:`,
    '',
    `- ${c.report.summary}`,
  ]
  const open = changes.route.filter(isOpen)
  if (open.length > 0) lines.push(`- New or changed routes with no check found: ${open.map((r) => `${r.title} (${r.where})`).join('; ')}`)
  if (c.outside.length > 0) lines.push(`- Files changed that its tasks (${c.tasks.map((t) => t.id).join(', ') || 'none named'}) don't mention: ${c.outside.slice(0, 12).join(', ')}${c.outside.length > 12 ? ` and ${c.outside.length - 12} more` : ''}`)
  if (c.overlaps.length > 0) lines.push(`- Files also changed by other work in flight: ${c.overlaps.slice(0, 8).map((o) => `${o.file} (${o.with.join(', ')})`).join('; ')}`)
  if (c.unknownTasks.length > 0) lines.push(`- Commits name tasks no tracker defines: ${c.unknownTasks.join(', ')}`)
  lines.push('', 'Before changing anything: explain why each of these is needed, and tell me what I should check by hand.')
  return lines.join('\n')
}
