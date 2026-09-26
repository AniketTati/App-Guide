import { basename } from 'node:path'
import type { Fact } from '../../../src/model/facts.js'
import type { Change } from '../../../src/model/report.js'
import type { Task } from '../../../src/tracker/tasks.js'
import type { Check, Work } from '../../../src/check/work.js'
import type { Commit } from '../../../src/git/repo.js'
import { plain } from '../../../src/render/words.js'
import type { SchemaChange, Unseen } from '../../../src/check/unseen.js'
import type { ProductBuild } from './product.js'
import type { BlindSpot, ChangeKind, ChangeView, CheckView, CommitView, ProductCounts, ProductView, RolesView, RouteRow, TaskView, UnmatchedView, WorkView } from '../shared/api.js'

/** Engine results into views, in the PM's words. No I/O here. */

export function taskView(t: Task): TaskView {
  return {
    id: t.id, title: t.title, status: t.status, file: t.file, line: t.line, fields: t.fields, criteria: t.criteria, worklog: t.worklog, text: t.text,
    severity: t.severity, statusNote: t.statusNote, latest: t.latest,
  }
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
    case 'unsupported-language': return `${count.toLocaleString()} ${g.subject} file${count === 1 ? '' : 's'}${areaOf(g.where.file)}`
    case 'unsupported-framework': return g.subject
    case 'raw-sql': return `${n} hand-written quer${n === 1 ? 'y' : 'ies'}`
    case 'dynamic-dispatch': return `routes added in ${n} place${s} I can't follow`
    case 'computed-route-path': return `${n} address${n === 1 ? '' : 'es'} built at runtime`
    case 'unresolved-route-prefix': return `${n} route group${s} mounted out of sight`
    case 'unresolved-import': return `${n} undeclared package${s}`
    case 'parse-error': return `${n} file${s} that didn't parse`
  }
}

/** ", in apps/agents": the part of the repository a language's files are in. */
function areaOf(file: string): string {
  const parts = file.split('/')
  const depth = /^(apps|packages|services|libs|backend|server)$/.test(parts[0] ?? '') ? 2 : 1
  return parts.length > depth ? `, in ${parts.slice(0, depth).join('/')}` : ''
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

export function productCounts(facts: readonly Fact[], publicOk: readonly string[] = []): ProductCounts {
  const routes = facts.filter((f): f is Extract<Fact, { kind: 'route' }> => f.kind === 'route')
  const open = routes.filter((r) => Array.isArray(r.middleware) && r.middleware.length === 0)
  return {
    routes: routes.length,
    noCheck: open.length,
    noCheckUnreviewed: open.filter((r) => !publicOk.includes(`${r.method} ${r.path}`)).length,
    tables: new Set(facts.flatMap((f) => (f.kind === 'write' || f.kind === 'read' ? [f.table] : []))).size,
    services: new Set(facts.flatMap((f) => (f.kind === 'external' ? [f.host] : []))).size,
    packages: facts.filter((f) => f.kind === 'library' && f.direct).length,
    files: 0,
  }
}

const FINISHED = new Set(['DONE', 'NOT-REPRODUCIBLE', 'WONTFIX', 'VERIFIED', 'CLOSED'])
const STALE_DAYS = 21

/** A branch with no commit for three weeks and nothing uncommitted. */
export const isStale = (w: Work, now = Date.now()): boolean => w.uncommitted.length === 0 && w.lastCommit !== null && now - Date.parse(w.lastCommit) > STALE_DAYS * 86_400_000

export function workView(w: Work, all: readonly Work[], tasks: ReadonlyMap<string, Task>, checked: Checked | undefined, now = Date.now()): WorkView {
  // Overlap with work weeks old is history, not a clash to plan for.
  const others = all.filter((o) => o.id !== w.id && !isStale(o, now))
  const sharesWith = others
    .map((o) => ({ label: nameOf(o), files: o.changed.filter((f) => w.changed.includes(f)).length }))
    .filter((s) => s.files > 0)
  const ids = w.tasks.length > 0 ? w.tasks : w.edited
  const refs = ids.map((id) => {
    const t = tasks.get(id)
    return { id, title: t?.title ?? 'not in any tracker', status: t?.status ?? null }
  })
  const moved = checked !== undefined && (checked.fingerprint !== undefined ? checked.fingerprint !== w.fingerprint : checked.head !== w.head || checked.dirty !== w.uncommitted.length)
  const stale = isStale(w, now)
  return {
    id: w.id,
    branch: w.branch,
    where: w.path === null ? 'branch' : w.primary ? 'checkout' : 'worktree',
    label: w.plan?.title ?? refs.find((r) => r.title !== 'not in any tracker')?.title ?? nameOf(w),
    name: nameOf(w),
    ahead: w.ahead,
    uncommitted: w.uncommitted.length,
    changed: w.changed.length,
    tasks: refs,
    plan: w.plan,
    sharesWith,
    lastCommit: w.lastCommit,
    checkedAt: checked?.at ?? null,
    movedSinceCheck: moved,
    ready: w.path !== null && w.ahead > 0 && w.uncommitted.length === 0 && !stale
      && refs.every((r) => r.status !== null && FINISHED.has(r.status)) && (checked === undefined || moved),
    stale,
  }
}

export interface Checked { at: string; head: string; dirty: number; fingerprint?: string }

/** The folder a worktree is in, or the branch a branch is. */
export const nameOf = (w: Work): string => (w.primary ? 'your checkout' : w.path === null ? (w.branch ?? w.id).replace(/^origin\//, '') : basename(w.path))

export const commitView = (c: Commit & { tasks: string[] }): CommitView => ({ sha: c.sha.slice(0, 7), subject: c.subject, date: c.date, tasks: c.tasks })

export interface CheckInputs {
  check: Check
  all: readonly Work[]
  tasks: ReadonlyMap<string, Task>
  checked: Checked | undefined
  /** The product where the work started, and as the work leaves it. */
  before: ProductBuild
  after: ProductBuild
  /** Routes that were there before whose own code changed. */
  touched: readonly Route[]
  schema: SchemaChange
  unseen: readonly Unseen[]
  verdict: CheckView['verdict']
}

type Route = Extract<Fact, { kind: 'route' }>

export function checkView(i: CheckInputs): CheckView {
  const c = i.check
  const work = workView(c.work, i.all, i.tasks, i.checked)
  const roles = i.after.view.roles
  const rows = routeRows(i.after.view)
  const enrich = (v: ChangeView): ChangeView => {
    if (v.kind !== 'route') return v
    const row = rows.get(v.title)
    const who = roles !== null && Array.isArray(v.checks) ? whoFrom(v.checks, roles) : undefined
    return { ...v, ...(who === undefined ? {} : { who }), ...(row === undefined ? {} : { data: row.data }) }
  }
  const grouped = groupChanges([...c.report.top, ...c.report.also])
  const changes = { ...grouped, route: grouped.route.map(enrich) }
  const listed = new Set(changes.route.map((r) => r.title))
  const touched = i.touched
    .filter((r) => !listed.has(`${r.method} ${r.path}`))
    .map((r) => enrich({
      type: 'changed', kind: 'route', title: `${r.method} ${r.path}`, detail: 'its own code changed',
      checks: r.middleware === 'unresolved' ? 'unresolved' : [...r.middleware], where: `${r.where.file}:${r.where.line}`,
    }))
  const screens = screensChanged(i.before, i.after, c.work.changed)
  const roleDiff = roleChanges(i.before.view.roles, roles)
  const key = (u: UnmatchedView): string => `${u.method} ${u.path} ${u.where.replace(/:\d+$/, '')}`
  const was = new Set(i.before.view.unmatched.map(key))
  const now = new Set(i.after.view.unmatched.map(key))
  const unmatched = {
    added: i.after.view.unmatched.filter((u) => !was.has(key(u))),
    fixed: i.before.view.unmatched.filter((u) => !now.has(key(u))),
  }
  const unseen = i.unseen.map((u) => ({ label: u.label, files: u.files }))
  const view: CheckView = {
    work,
    base: c.base,
    sentence: '',
    readAt: new Date().toISOString(),
    fingerprint: c.work.fingerprint,
    verdict: i.verdict,
    commits: c.commits.map(commitView),
    tasks: c.tasks.map(taskView),
    unknownTasks: c.unknownTasks,
    screens,
    roleChanges: roleDiff,
    roles: roles?.tables[0]?.roles ?? [],
    changes,
    touched,
    schema: i.schema,
    unseen,
    unmatched,
    tests: c.tests,
    outside: c.outside,
    shared: c.overlaps,
    blind: blindSpots(c.facts.head),
    followUp: '',
    ship: '',
  }
  view.sentence = sentenceOf(view)
  view.followUp = followUp(view)
  view.ship = shipIt(view)
  return view
}

/** Route rows by "METHOD /path", from every place the product view lists one. */
function routeRows(v: ProductView): Map<string, RouteRow> {
  const out = new Map<string, RouteRow>()
  for (const r of [...v.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...v.behind, ...v.layout, ...v.shared.flatMap((s) => s.routes)]) out.set(`${r.method} ${r.path}`, r)
  return out
}

/** Screens whose own page file changed, then screens that run changed code;
 *  and screens added or gone. */
export function screensChanged(before: ProductBuild, after: ProductBuild, changed: readonly string[]): CheckView['screens'] {
  const all = (b: ProductBuild) => b.view.groups.flatMap((g) => g.screens.map((s) => ({ ...s, group: g.label })))
  const had = new Map(all(before).map((s) => [s.path, s]))
  const has = new Map(all(after).map((s) => [s.path, s]))
  const touched = new Set(changed)
  const out: CheckView['screens'] = { changed: [], added: [], removed: [] }
  for (const [path, s] of has) {
    if (!had.has(path)) { out.added.push({ name: s.name, path }); continue }
    const how = s.file !== null && touched.has(s.file) ? 'page' : (after.reach[path] ?? []).some((f) => touched.has(f)) ? 'uses' : null
    if (how !== null) out.changed.push({ name: s.name, path, how, app: s.group })
  }
  for (const [path, s] of had) if (!has.has(path)) out.removed.push({ name: s.name, path })
  out.changed.sort((a, b) => (a.how === b.how ? 0 : a.how === 'page' ? -1 : 1))
  return out
}

/** What each role may do on each resource, where the two tables differ. */
export function roleChanges(before: RolesView | null, after: RolesView | null): CheckView['roleChanges'] {
  const a = before?.tables[0] ?? null
  const b = after?.tables[0] ?? null
  if (a === null && b === null) return []
  const text = (t: typeof a, resource: string, role: string): string => grantText(t?.rows.find((r) => r.resource === resource)?.cells[role] ?? [])
  const resources = [...new Set([...(a?.rows ?? []), ...(b?.rows ?? [])].map((r) => r.resource))]
  const roles = [...new Set([...(a?.roles ?? []), ...(b?.roles ?? [])])]
  const out: CheckView['roleChanges'] = []
  for (const resource of resources) {
    for (const role of roles) {
      const x = text(a, resource, role)
      const y = text(b, resource, role)
      if (x !== y) out.push({ role, resource: resource === '*' ? 'everything' : resource, before: x === '' ? 'nothing' : x, after: y === '' ? 'nothing' : y })
    }
  }
  return out
}

/** "view, create", "edit (own only)", "everything". */
export function grantText(cells: readonly { actions: string[]; scope: string | null }[]): string {
  return cells.map((c) => `${c.actions.includes('*') ? 'everything' : c.actions.join(', ')}${c.scope !== null && c.scope !== 'org' ? ` (${c.scope} only)` : ''}`).join('; ')
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The answer first — and never an all-clear over what couldn't be read. */
export function sentenceOf(v: CheckView): string {
  const r = v.changes.route
  const added = r.filter((x) => x.type === 'added')
  const open = added.filter((x) => Array.isArray(x.checks) && x.checks.length === 0).length
  const phrases: string[] = []
  if (added.length > 0) phrases.push(`adds ${count(added.length, 'route')}${open > 0 ? ` (${open} with no check found)` : ''}`)
  const removed = r.filter((x) => x.type === 'removed').length
  if (removed > 0) phrases.push(`removes ${count(removed, 'route')}`)
  const rechecked = r.filter((x) => x.type === 'changed').length
  if (rechecked > 0) phrases.push(`changes the checks on ${count(rechecked, 'route')}`)
  if (v.touched.length > 0) phrases.push(`changes the code behind ${count(v.touched.length, 'existing route')}`)
  const roles = new Set(v.roleChanges.map((c) => c.role)).size
  if (roles > 0) phrases.push(`changes what ${count(roles, 'role')} may do`)
  const t = v.schema.tables
  if (t.added.length > 0) phrases.push(`adds ${count(t.added.length, 'table')}`)
  if (t.changed.length + t.removed.length > 0) phrases.push(`changes ${count(t.changed.length + t.removed.length, 'table')}`)
  if (v.screens.added.length > 0) phrases.push(`adds ${count(v.screens.added.length, 'screen')}`)
  const pages = v.screens.changed.filter((s) => s.how === 'page').length
  if (pages > 0) phrases.push(`changes ${count(pages, 'screen')}`)
  if (v.unmatched.added.length > 0) phrases.push(`calls ${count(v.unmatched.added.length, 'route')} that ${v.unmatched.added.length === 1 ? "doesn't" : "don't"} exist`)
  const services = v.changes.service.filter((x) => x.type === 'added').length
  if (services > 0) phrases.push(`starts calling ${count(services, 'outside service')}`)
  const packages = v.changes.package.filter((x) => x.type === 'added').length
  if (packages > 0) phrases.push(`adds ${count(packages, 'package')}`)
  const cant = v.unseen.map((u) => `${u.label} (${count(u.files.length, 'file')})`)
  const cantText = cant.length === 0 ? '' : cant.length === 1 ? cant[0]! : `${cant.slice(0, -1).join(', ')} and ${cant[cant.length - 1]}`
  if (phrases.length > 0) {
    const list = phrases.length === 1 ? phrases[0]! : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
    return `It ${list}.${cantText === '' ? '' : ` It also changes ${cantText}, which I can’t read.`}`
  }
  if (cantText !== '') return `Nothing changed in the parts I can read — but it changes ${cantText}, which I can’t read. Ask Claude what those changes do before you merge.`
  const uses = v.screens.changed.length
  if (v.touched.length > 0 || uses > 0) return `No new routes, checks, data or packages. It changes the code behind ${[v.touched.length > 0 ? count(v.touched.length, 'existing route') : '', uses > 0 ? count(uses, 'screen') : ''].filter(Boolean).join(' and ')} — try ${uses === 1 ? 'it' : 'them'}, and read what its tasks say it did.`
  return 'No new routes, checks, data, packages or services. What changed inside existing code isn’t described here — read what its tasks say it did.'
}

/** What the PM can paste into Claude after reading a Check: the facts, and a
 *  question — never an instruction to change anything on its own. */
function followUp(v: CheckView): string {
  const name = v.work.branch ?? v.work.name
  const lines = [`I'm checking the work on ${name} before it merges. App Guide read it against ${v.base}:`, '', `- ${v.sentence}`]
  const open = v.changes.route.filter(isOpen)
  if (open.length > 0) lines.push(`- New or changed routes with no check found: ${open.map((r) => `${r.title} (${r.where})`).join('; ')}`)
  for (const c of v.roleChanges.slice(0, 12)) lines.push(`- ${c.role} on ${c.resource}: was ${c.before}, now ${c.after}`)
  if (v.unmatched.added.length > 0) lines.push(`- Calls to routes that don't exist: ${v.unmatched.added.map((u) => `${u.method} ${u.path} (${u.where})`).join('; ')}`)
  if (v.unseen.length > 0) lines.push(`- Changes App Guide can't read: ${v.unseen.map((u) => `${u.label}: ${u.files.slice(0, 6).join(', ')}${u.files.length > 6 ? ` and ${u.files.length - 6} more` : ''}`).join('; ')}`)
  if (v.outside.length > 0) lines.push(`- Files changed that its tasks (${v.tasks.map((t) => t.id).join(', ') || 'none named'}) don't mention: ${v.outside.slice(0, 12).join(', ')}${v.outside.length > 12 ? ` and ${v.outside.length - 12} more` : ''}`)
  if (v.shared.length > 0) lines.push(`- Files also changed by other work in flight: ${v.shared.slice(0, 8).map((o) => `${o.file} (${o.with.join(', ')})`).join('; ')}`)
  if (v.unknownTasks.length > 0) lines.push(`- Commits name tasks no tracker defines: ${v.unknownTasks.join(', ')}`)
  lines.push('', 'Before changing anything: explain why each of these is needed, and tell me what I should check by hand.')
  return lines.join('\n')
}

/** What to paste when it's ready: push, open a pull request, say what it does. */
function shipIt(v: CheckView): string {
  const name = v.work.branch ?? v.work.name
  const into = v.base.replace(/^origin\//, '')
  const tasks = v.tasks.length > 0 ? ` for ${v.tasks.map((t) => t.id).join(', ')}` : ''
  const first = v.work.uncommitted > 0 ? `Commit the work on ${name}, then push it` : v.verdict.pushed.state === 'remote' || v.verdict.pushed.state === 'pushed' ? `${name} is pushed` : `Push ${name}`
  return [
    `${first} and open a pull request into ${into}${tasks}.`,
    `In its description, say in plain words what it changes. App Guide read it as: ${v.sentence}`,
    ...(v.unseen.length > 0 ? [`Also describe the changes to ${v.unseen.map((u) => u.label).join(' and ')} — App Guide can't read those.`] : []),
    ...(v.verdict.mergeMain.state === 'conflicts' ? [`It conflicts with ${into} in ${v.verdict.mergeMain.files.join(', ')}: resolve that first.`] : []),
    'Then send me the link.',
  ].join('\n')
}

/**
 * The roles that pass these checks, read from main's role table the way the
 * Product view reads it: a check's own arguments against each role's grants,
 * wildcards included. null when no check is one the table speaks about.
 */
export function whoFrom(checks: readonly string[], roles: RolesView): { role: string; scope: string | null }[] | null {
  const table = roles.tables[0]
  if (table === undefined) return null
  for (const check of checks) {
    const m = /^\w+\('([^']+)',\s*'([^']+)'\)$/.exec(check)
    if (m === null) continue
    const [, action, resource] = m as unknown as [string, string, string]
    const rows = table.rows.filter((row) => row.resource === resource || row.resource === '*')
    if (rows.length === 0) continue
    const out: { role: string; scope: string | null }[] = []
    for (const role of table.roles) {
      const grant = rows.flatMap((row) => row.cells[role] ?? []).find((c) => c.actions.includes(action) || c.actions.includes('*'))
      if (grant !== undefined) out.push({ role, scope: grant.scope })
    }
    if (out.length > 0 || rows.some((row) => row.resource === resource)) return out
  }
  return null
}
