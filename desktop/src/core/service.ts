import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, changedOnMain, listWork, tasksAt, type Work, type WorkList } from '../../../src/check/work.js'
import { changedLines, factsAt, git, mergesCleanly, upstreamOf } from '../../../src/git/repo.js'
import { readTasks, WAITING, type Task } from '../../../src/tracker/tasks.js'
import { schemaChange, unseenChanges } from '../../../src/check/unseen.js'
import type { Fact } from '../../../src/model/facts.js'
import { blindSpots, checkView, commitView, groupChanges, nameOf, productCounts, taskView, workView, type Checked } from './views.js'
import { productAt, productOfTree } from './product.js'
import type { CheckView, HomeView, MergeView, Project, TaskView } from '../shared/api.js'

type Route = Extract<Fact, { kind: 'route' }>

/** What the app remembers about a project. Owned by the main process, passed
 *  in on every call: the process that reads repositories keeps no state. */
export interface ProjectState {
  /** Main's commit when the PM last looked. */
  seenMain?: string
  /** When each piece of work was last marked checked, and what it was then. */
  checked: Record<string, Checked>
  /** Routes with no check the PM says are meant to be open: "METHOD /path". */
  publicOk?: string[]
}

export interface HomeResult {
  view: HomeView
  baseHead: string
  work: { id: string; head: string; dirty: number; fingerprint: string }[]
}

export async function home(project: Project, state: ProjectState, cacheDir: string): Promise<HomeResult> {
  const root = project.path
  const list = await listWork(root, { branches: true })
  const tasks = await tasksOf(root, list)

  const waiting: TaskView[] = []
  for (const t of tasks.values()) if (t.status !== null && WAITING.has(t.status)) waiting.push(taskView(t))

  const mainFacts = await factsAt(root, list.baseHead, cacheDir)
  let main: HomeView['main'] = null
  let mainReset = false
  if (state.seenMain !== undefined) {
    if (state.seenMain === list.baseHead) main = { commits: [], changes: [], sentence: 'Nothing has changed on main since you last looked.' }
    else {
      try {
        const { commits, report } = await changedOnMain(root, state.seenMain, list.baseHead, cacheDir)
        const grouped = groupChanges([...report.top, ...report.also])
        main = { commits: commits.map(commitView), changes: [...grouped.route, ...grouped.data, ...grouped.service, ...grouped.package, ...grouped.code], sentence: report.summary.replace(/^Your agent /, 'It ') }
      } catch {
        // The commit last looked at is gone — main's history was rewritten.
        // Counting starts again from today, and Home says so.
        mainReset = true
      }
    }
  }

  const view: HomeView = {
    project,
    base: list.base,
    waiting: waiting.sort(bySeverity),
    work: list.work.map((w) => workView(w, list.work, tasks, state.checked[w.id])),
    skipped: list.skipped,
    merged: list.merged,
    fetchedAt: list.fetchedAt,
    main,
    mainReset,
    product: productCounts(mainFacts, state.publicOk ?? []),
    blind: blindSpots(mainFacts),
    readAt: new Date().toISOString(),
  }
  return { view, baseHead: list.baseHead, work: list.work.map((w) => ({ id: w.id, head: w.head, dirty: w.uncommitted.length, fingerprint: w.fingerprint })) }
}

const RANK = ['critical', 'high', 'medium', 'low']
const bySeverity = (a: TaskView, b: TaskView): number => rank(a) - rank(b)
function rank(t: TaskView): number {
  const i = RANK.findIndex((r) => (t.severity ?? '').toLowerCase().startsWith(r))
  return i === -1 ? RANK.length : i
}

export async function checkWork(project: Project, workId: string, state: ProjectState, cacheDir: string): Promise<{ view: CheckView; fingerprint: string; head: string }> {
  const root = project.path
  const list = await listWork(root, { branches: workId.startsWith('branch:') })
  const item = list.work.find((w) => w.id === workId)
  if (item === undefined) throw new Error('That work isn’t in flight any more — it may have been merged or put away.')
  const live = item.path !== null && item.uncommitted.length > 0

  // The product where the work started, and as the work leaves it: who may
  // call a route comes from the branch's own role table, not main's.
  const before = await productAt(root, item.mergeBase, list.base, cacheDir)
  const after = live ? await productOfTree(item.path!, list.base, item.fingerprint) : { build: await productAt(root, item.head, list.base, cacheDir), facts: undefined }
  const c = await check(root, workId, cacheDir, 'plain', { list, ...(after.facts === undefined ? {} : { head: after.facts }) })

  const read = (file: string): Promise<string | null> => (live ? readFile(join(item.path!, file), 'utf8') : git(root, ['show', `${item.head}:${file}`])).catch(() => null)
  const [touched, schema, verdict, tasks] = await Promise.all([
    touchedRoutes(root, item, c.facts.base, c.facts.head, live),
    schemaChange(item.changed, (f) => git(root, ['show', `${item.mergeBase}:${f}`]).catch(() => null), read),
    verdictOf(root, list, item, c.tasks),
    tasksOf(root, list),
  ])
  for (const t of c.tasks) tasks.set(t.id, t)
  const view = checkView({
    check: c, all: list.work, tasks, checked: state.checked[workId],
    before, after: after.build, touched, schema, unseen: unseenChanges(item.changed).filter((u) => u.kind !== 'schema' && u.kind !== 'migration'), verdict,
  })
  return { view, fingerprint: item.fingerprint, head: item.head }
}

/**
 * Routes that were there before whose own lines changed: from the route's
 * line to the next route's in the same file. "The API accepts `rejected` now"
 * is a change to an existing route, and it must not come out as nothing.
 */
async function touchedRoutes(root: string, item: Work, base: readonly Fact[], head: readonly Fact[], live: boolean): Promise<Route[]> {
  const key = (r: Route): string => `${r.method} ${r.path}`
  const existed = new Set(base.filter((f): f is Route => f.kind === 'route').map(key))
  const routes = head.filter((f): f is Route => f.kind === 'route' && existed.has(key(f)) && item.changed.includes(f.where.file))
  const byFile = new Map<string, Route[]>()
  for (const r of routes) byFile.set(r.where.file, [...(byFile.get(r.where.file) ?? []), r])
  const out: Route[] = []
  for (const [file, rs] of byFile) {
    const lines = await changedLines(item.path ?? root, item.mergeBase, live ? null : item.head, file)
    if (lines.length === 0) continue
    // Every route in the file, to know where each one's code ends.
    const starts = head.filter((f): f is Route => f.kind === 'route' && f.where.file === file).map((r) => r.where.line).sort((a, b) => a - b)
    for (const r of rs) {
      const end = (starts.find((l) => l > r.where.line) ?? Infinity) - 1
      if (lines.some(([a, b]) => a <= end && b >= r.where.line)) out.push(r)
    }
  }
  return out
}

/** Is it ready to go in: criteria written, merges cleanly, pushed. */
async function verdictOf(root: string, list: WorkList, item: Work, tasks: readonly Task[]): Promise<CheckView['verdict']> {
  const merge = async (theirs: Work): Promise<MergeView> => {
    if (item.ahead === 0 || theirs.ahead === 0) return { state: 'uncommitted' }
    const r = await mergesCleanly(root, item.head, theirs.head)
    return r === null ? { state: 'unknown' } : r.clean ? { state: 'clean' } : { state: 'conflicts', files: r.files }
  }
  const mergeMain: MergeView = item.ahead === 0 ? { state: 'uncommitted' } : await mergesCleanly(root, list.baseHead, item.head).then(
    (r): MergeView => (r === null ? { state: 'unknown' } : r.clean ? { state: 'clean' } : { state: 'conflicts', files: r.files }))
  const others = list.work.filter((o) => o.id !== item.id && o.changed.some((f) => item.changed.includes(f)))
  const mergeOthers = await Promise.all(others.map(async (o) => ({ label: nameOf(o), files: o.changed.filter((f) => item.changed.includes(f)).length, state: await merge(o) })))
  let pushed: CheckView['verdict']['pushed']
  if (item.path === null) pushed = { state: item.branch?.startsWith('origin/') === true ? 'remote' : 'local', unpushed: 0, upstream: null }
  else if (item.branch === null) pushed = { state: 'detached', unpushed: item.ahead, upstream: null }
  else {
    const up = await upstreamOf(root, item.branch, item.head)
    pushed = up === null ? { state: 'local', unpushed: item.ahead, upstream: null } : { state: up.unpushed > 0 ? 'ahead' : 'pushed', unpushed: up.unpushed, upstream: up.upstream }
  }
  return { criteria: tasks.reduce((n, t) => n + t.criteria.length, 0), mergeMain, mergeOthers, pushed }
}

/**
 * The tasks as main has them, then each piece of work's own copy of the
 * entries it changed — and only those. A worktree that merely carries an old
 * copy of a task can't put it back to how it was.
 */
async function tasksOf(root: string, list: WorkList): Promise<Map<string, Task>> {
  const byId = new Map<string, Task>()
  for (const t of await tasksAtCached(root, list.baseHead)) byId.set(t.id, t)
  for (const w of list.work) {
    if (w.path === null || w.edited.length === 0) continue
    const mine = new Set(w.edited)
    for (const t of await readTasks(w.path)) if (mine.has(t.id)) byId.set(t.id, t)
  }
  return byId
}

const atCommit = new Map<string, Promise<Task[]>>()
function tasksAtCached(root: string, sha: string): Promise<Task[]> {
  const key = `${root}\u0000${sha}`
  let p = atCommit.get(key)
  if (p === undefined) {
    p = tasksAt(root, sha)
    atCommit.set(key, p)
    p.catch(() => atCommit.delete(key))
    while (atCommit.size > 8) atCommit.delete(atCommit.keys().next().value!)
  }
  return p
}
