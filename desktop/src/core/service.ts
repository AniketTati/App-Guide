import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { check, changedOnMain, listWork, tasksAt, type Work, type WorkList } from '../../../src/check/work.js'
import { changedBetween, changedHunks, factsAt, filesMerge, git, mergesCleanly, upstreamOf } from '../../../src/git/repo.js'
import { readTasks, WAITING, type Task } from '../../../src/tracker/tasks.js'
import { schemaChange, unseenChanges } from '../../../src/check/unseen.js'
import { progress, readPlan } from '../../../src/tracker/plan.js'
import { routeSpans } from '../../../src/graph/spans.js'
import type { Fact } from '../../../src/model/facts.js'
import { blindSpots, checkView, commitView, groupChanges, isStale, nameOf, productCounts, taskView, workView, type Checked } from './views.js'
import { productAt, productOfTree, type ProductBuild } from './product.js'
import { appDirOf, servedAt } from './running.js'
import type { CheckView, HomeView, MergeView, Note, ProductView, Project, TaskView } from '../shared/api.js'

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
  /** What the PM pinned to the map, on main or while checking a piece of work. */
  notes?: Note[]
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
      } catch (e) {
        // Counting starts again only if the commit last looked at is really
        // gone — main's history rewritten. A slow or failed read is an error,
        // not a reason to forget where the PM was.
        const gone = await git(root, ['cat-file', '-e', `${state.seenMain}^{commit}`]).then(() => false, () => true)
        if (!gone) throw e
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
    untouched: list.untouched,
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
    plan: item.plan === null ? null : planView(item.plan.file, await read(item.plan.file)),
    running: item.path === null ? null : await servedAt(item.path, appDirOf(routerFileOf(after.build))),
  })
  return { view, fingerprint: item.fingerprint, head: item.head }
}

/** The product as a piece of work leaves it — on disk while it has
 *  uncommitted edits, else at its commit — for the map of a Check. */
export async function workProduct(project: Project, workId: string, cacheDir: string): Promise<ProductView> {
  const root = project.path
  const list = await listWork(root, { branches: workId.startsWith('branch:') })
  const item = list.work.find((w) => w.id === workId)
  if (item === undefined) throw new Error('That work isn’t in flight any more — it may have been merged or put away.')
  const live = item.path !== null && item.uncommitted.length > 0
  return (live ? (await productOfTree(item.path!, list.base, item.fingerprint)).build : await productAt(root, item.head, list.base, cacheDir)).view
}

/**
 * Routes that were there before whose own lines changed: from the route's
 * line to the next route's in the same file, comments aside. "The API accepts
 * `rejected`" is a change to an existing route, and it must not come out as
 * nothing — so the values its code gained or lost are kept too.
 */
async function touchedRoutes(root: string, item: Work, base: readonly Fact[], head: readonly Fact[], live: boolean): Promise<Touched[]> {
  const key = (r: Route): string => `${r.method} ${r.path}`
  const existed = new Set(base.filter((f): f is Route => f.kind === 'route').map(key))
  const routes = head.filter((f): f is Route => f.kind === 'route' && existed.has(key(f)) && item.changed.includes(f.where.file))
  const byFile = new Map<string, Route[]>()
  for (const r of routes) byFile.set(r.where.file, [...(byFile.get(r.where.file) ?? []), r])
  const out: Touched[] = []
  for (const [file, rs] of byFile) {
    const hunks = await changedHunks(item.path ?? root, item.mergeBase, live ? null : item.head, file)
    if (hunks.length === 0) continue
    // Each route's own code: the call that registers it and the handler it
    // names. Where the file can't be read, the lines up to the next route.
    const text = await (live ? readFile(join(item.path!, file), 'utf8') : git(root, ['show', `${item.head}:${file}`])).catch(() => null)
    const spans = text === null ? new Map<number, [number, number][]>() : routeSpans(file, text, rs.map((r) => r.where.line))
    const starts = head.filter((f): f is Route => f.kind === 'route' && f.where.file === file).map((r) => r.where.line).sort((a, b) => a - b)
    for (const r of rs) {
      const own = spans.get(r.where.line) ?? [[r.where.line, (starts.find((l) => l > r.where.line) ?? Infinity) - 1]]
      const mine = hunks.filter((k) => own.some(([a, b]) => k.start <= b && k.end >= a))
      if (mine.length === 0) continue
      const added = literals(mine.flatMap((k) => k.added))
      const removed = literals(mine.flatMap((k) => k.removed))
      out.push({ route: r, added: [...added].filter((v) => !removed.has(v)).slice(0, 5), removed: [...removed].filter((v) => !added.has(v)).slice(0, 5) })
    }
  }
  return out
}

export interface Touched { route: Route; added: string[]; removed: string[] }

/** The short string values in some lines of code: 'rejected', "own". */
function literals(lines: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const line of lines) {
    if (/^\s*(import|export \*|\/\/|\*)/.test(line)) continue
    for (const m of line.matchAll(/(['"`])((?:(?!\1)[^\\\n$]){1,40})\1/g)) {
      const v = m[2]!
      if (v.trim() === '' || /^[./@]/.test(v)) continue
      out.add(v)
    }
  }
  return out
}

/** Is it ready to go in: criteria written, merges cleanly, pushed. */
async function verdictOf(root: string, list: WorkList, item: Work, tasks: readonly Task[]): Promise<CheckView['verdict']> {
  const live = (w: Work): boolean => w.path !== null && w.uncommitted.length > 0
  const show = (sha: string, file: string): Promise<string | null> => git(root, ['show', `${sha}:${file}`]).catch(() => null)
  // What a file says in a piece of work now: on disk while it has uncommitted
  // edits, else at its commit.
  const now = (w: Work, file: string): Promise<string | null> => (live(w) ? readFile(join(w.path!, file), 'utf8').catch(() => null) : show(w.head, file))
  const view = (r: { clean: true } | { clean: false; files: string[] } | null, asOfNow: boolean): MergeView =>
    r === null ? { state: 'unknown' } : r.clean ? { state: 'clean', asOfNow } : { state: 'conflicts', files: r.files, asOfNow }

  // Committed on both sides: git's own merge. Otherwise the files as they are
  // now, merged one by one — only those both sides changed can conflict.
  let mergeMain: MergeView
  if (!live(item)) mergeMain = item.ahead === 0 ? { state: 'uncommitted' } : view(await mergesCleanly(root, list.baseHead, item.head), false)
  else {
    const mainChanged = new Set(await changedBetween(root, item.mergeBase, list.baseHead))
    const both = item.changed.filter((f) => mainChanged.has(f))
    mergeMain = view(await filesMerge(await Promise.all(both.map(async (path) => ({ path, base: await show(item.mergeBase, path), ours: await show(list.baseHead, path), theirs: await now(item, path) })))), true)
  }
  const others = list.work.filter((o) => o.id !== item.id && !isStale(o) && o.changed.some((f) => item.changed.includes(f)))
  const mergeOthers = await Promise.all(others.map(async (o) => {
    const shared = o.changed.filter((f) => item.changed.includes(f))
    let state: MergeView
    if (!live(item) && !live(o)) state = view(await mergesCleanly(root, item.head, o.head), false)
    else {
      const base = await git(root, ['merge-base', item.head, o.head]).then((x) => x.trim(), () => null)
      state = base === null ? { state: 'unknown' } : view(await filesMerge(await Promise.all(shared.map(async (path) => ({ path, base: await show(base, path), ours: await now(item, path), theirs: await now(o, path) })))), true)
    }
    return { label: nameOf(o), files: shared.length, state }
  }))
  const pushed = await pushedOf(root, item)
  return { criteria: tasks.reduce((n, t) => n + t.criteria.length, 0), mergeMain, mergeOthers, pushed }
}

/**
 * Whether a piece of work is on GitHub: its branch as origin has it, under
 * its own name — a branch started from origin/main tracks origin/main, which
 * says nothing about whether it was pushed.
 */
async function pushedOf(root: string, item: Work): Promise<CheckView['verdict']['pushed']> {
  if (item.branch === null) return { state: 'detached', unpushed: item.ahead, upstream: null }
  if (item.path === null && item.branch.startsWith('origin/')) return { state: 'remote', unpushed: 0, upstream: item.branch }
  const own = `origin/${item.branch}`
  const count = async (upstream: string): Promise<number | null> => git(root, ['rev-list', '--count', `${upstream}..${item.head}`]).then((x) => Number(x.trim()), () => null)
  const mine = await count(own)
  if (mine !== null) return { state: mine > 0 ? 'ahead' : 'pushed', unpushed: mine, upstream: own }
  const up = await upstreamOf(root, item.branch, item.head)
  if (up !== null && up.upstream.replace(/^[^/]+\//, '') === item.branch) return { state: up.unpushed > 0 ? 'ahead' : 'pushed', unpushed: up.unpushed, upstream: up.upstream }
  return { state: 'local', unpushed: item.ahead, upstream: null }
}

/** Where the web app's router is, from any screen it declares. */
function routerFileOf(b: ProductBuild): string {
  const main = b.view.groups.find((g) => !g.note?.startsWith('A separate app')) ?? b.view.groups[0]
  return main?.screens[0]?.where.replace(/:\d+$/, '') ?? ''
}

/** The plan a piece of work is working from, read like its tracker. */
function planView(file: string, text: string | null): CheckView['plan'] {
  if (text === null) return null
  const plan = readPlan(file, text)
  const p = progress(plan)
  const finished = /^(DONE|SHIPPED|VERIFIED|CLOSED)$/
  return {
    file, title: plan.title, done: p.done, partly: p.partly, total: p.total,
    releases: p.releases.map((r) => ({ name: r.name, short: r.short, done: r.done, total: r.total, doneWhen: r.doneWhen })),
    open: plan.items.filter((i) => !finished.test(i.status ?? '')).map((i) => ({ id: i.id, title: i.title, status: i.status })),
    golive: plan.golive,
  }
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
