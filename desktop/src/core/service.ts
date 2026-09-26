import { check, changedOnMain, listWork } from '../../../src/check/work.js'
import { factsAt } from '../../../src/git/repo.js'
import { readTasks, WAITING, type Task } from '../../../src/tracker/tasks.js'
import { blindSpots, checkView, commitView, groupChanges, productCounts, taskView, workView } from './views.js'
import type { CheckView, HomeView, Project, TaskView } from '../shared/api.js'

/** What the app remembers about a project. Owned by the main process, passed
 *  in on every call: the process that reads repositories keeps no state. */
export interface ProjectState {
  /** Main's commit when the PM last looked. */
  seenMain?: string
  /** When each piece of work was last marked checked, and what it was then. */
  checked: Record<string, { at: string; head: string; dirty: number }>
}

export interface HomeResult { view: HomeView; baseHead: string; work: { id: string; head: string; dirty: number }[] }

export async function home(project: Project, state: ProjectState, cacheDir: string): Promise<HomeResult> {
  const root = project.path
  const { base, baseHead, work } = await listWork(root)
  const tasks = await tasksOf(root, work.flatMap((w) => (w.path !== null && w.path !== root ? [w.path] : [])))

  // Waiting on the PM: from the checkout's tracker and from each worktree's own
  // copy, where a task can be VERIFY-PENDING before it has merged.
  const waiting = new Map<string, TaskView>()
  for (const t of tasks.all) if (t.status !== null && WAITING.has(t.status)) waiting.set(t.id, taskView(t))

  const mainFacts = await factsAt(root, baseHead, cacheDir)
  let main: HomeView['main'] = null
  if (state.seenMain !== undefined) {
    if (state.seenMain === baseHead) main = { commits: [], changes: [], sentence: 'Nothing has changed on main since you last looked.' }
    else {
      try {
        const { commits, report } = await changedOnMain(root, state.seenMain, baseHead, cacheDir)
        const grouped = groupChanges([...report.top, ...report.also])
        main = { commits: commits.map(commitView), changes: [...grouped.route, ...grouped.data, ...grouped.service, ...grouped.package, ...grouped.code], sentence: report.summary }
      } catch {
        main = null // the commit last looked at is gone (history rewritten): start again
      }
    }
  }

  const view: HomeView = {
    project,
    base,
    waiting: [...waiting.values()],
    work: work.map((w) => workView(w, work, tasks.byId, state.checked[w.id])),
    main,
    product: productCounts(mainFacts),
    blind: blindSpots(mainFacts),
    readAt: new Date().toISOString(),
  }
  return { view, baseHead, work: work.map((w) => ({ id: w.id, head: w.head, dirty: w.uncommitted.length })) }
}

export async function checkWork(project: Project, workId: string, state: ProjectState, cacheDir: string): Promise<{ view: CheckView; head: string; dirty: number }> {
  const c = await check(project.path, workId, cacheDir, 'plain')
  const { work } = await listWork(project.path)
  const tasks = await tasksOf(project.path, work.flatMap((w) => (w.path !== null && w.path !== project.path ? [w.path] : [])))
  // The Check's own tasks come from its branch's tracker; the rest are titles.
  const byId = new Map(tasks.byId)
  for (const t of c.tasks) byId.set(t.id, t)
  return { view: checkView(c, work, byId, state.checked[workId]), head: c.work.head, dirty: c.work.uncommitted.length }
}

/** Tasks from the checkout and every worktree; for the same ID, a worktree's
 *  copy wins — it is the newer one, written by the work in flight. */
async function tasksOf(root: string, worktreePaths: readonly string[]): Promise<{ all: Task[]; byId: Map<string, Task> }> {
  const byId = new Map<string, Task>()
  for (const t of await readTasks(root)) byId.set(t.id, t)
  for (const path of worktreePaths) {
    for (const t of await readTasks(path)) {
      const current = byId.get(t.id)
      if (current === undefined || current.status !== t.status || current.worklog.length !== t.worklog.length) byId.set(t.id, t)
    }
  }
  return { all: [...byId.values()], byId }
}
