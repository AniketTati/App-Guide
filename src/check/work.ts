import type { Fact } from '../model/facts.js'
import type { Report } from '../model/report.js'
import { compare } from '../diff/compare.js'
import { toReport } from '../diff/rank.js'
import { extract } from '../run.js'
import { isTestFile } from '../extract/files.js'
import {
  baseRef, changedBetween, commitsBetween, factsAt, git, mergeBase, resolve, uncommitted, worktrees,
  type Commit,
} from '../git/repo.js'
import { readTasks, taskIdsOf, WAITING, type Task } from '../tracker/tasks.js'

/** A branch or worktree with work that is not on main yet. */
export interface Work {
  /** Stable: the worktree's path, or the branch name for a branch with none. */
  id: string
  branch: string | null
  /** Where the work is on disk, when it is checked out somewhere. */
  path: string | null
  /** The repository's own checkout. */
  primary: boolean
  head: string
  mergeBase: string
  /** Commits not on main. */
  ahead: number
  uncommitted: string[]
  /** Task IDs the commits name, in order of first mention. */
  tasks: string[]
  /** Files that differ from main: committed and uncommitted. */
  changed: string[]
  /** The newest commit's date, or null if it has none of its own. */
  lastCommit: string | null
}

export interface Check {
  work: Work
  base: string
  commits: (Commit & { tasks: string[] })[]
  /** The tasks its commits name, as its own copy of the tracker describes them. */
  tasks: Task[]
  /** IDs its commits name that no tracker defines. */
  unknownTasks: string[]
  /** The structural difference from main, uncommitted work included. */
  report: Report
  facts: { base: Fact[]; head: Fact[] }
  tests: string[]
  /** Changed files that none of its tasks name — only when its tasks name files. */
  outside: string[]
  /** Changed files also changed by other work in flight. */
  overlaps: { file: string; with: string[] }[]
}

/** Every worktree with work not on main, the checkout included when it is on
 *  another branch. Git only — nothing is read into facts here. */
export async function listWork(root: string): Promise<{ base: string; baseHead: string; work: Work[] }> {
  const base = await baseRef(root)
  const baseHead = await resolve(root, base)
  const out: Work[] = []
  const all = await worktrees(root)
  for (const wt of all) {
    const mb = await mergeBase(root, base, wt.head)
    const commits = await commitsBetween(root, mb, wt.head)
    // A worktree kept inside another checkout (Claude keeps them in
    // .claude/worktrees/) shows up there as untracked files. It is its own
    // work, never a change to the checkout that happens to contain it.
    const nested = all.filter((o) => o.path !== wt.path && o.path.startsWith(`${wt.path}/`)).map((o) => `${o.path.slice(wt.path.length + 1)}/`)
    const dirty = (await uncommitted(wt.path).catch(() => [] as string[])).filter((f) => !nested.some((n) => f === n || f.startsWith(n)))
    if (commits.length === 0 && dirty.length === 0) continue
    const committed = commits.length === 0 ? [] : await changedBetween(root, mb, wt.head)
    out.push({
      id: wt.path,
      branch: wt.branch,
      path: wt.path,
      primary: wt.primary,
      head: wt.head,
      mergeBase: mb,
      ahead: commits.length,
      uncommitted: dirty,
      tasks: unique(commits.slice().reverse().flatMap((c) => taskIdsOf(c.subject))),
      changed: unique([...committed, ...dirty]).sort(),
      lastCommit: commits[0]?.date ?? null,
    })
  }
  return { base, baseHead, work: out }
}

/** One piece of work against main: what it did, which tasks it says it is
 *  for, and what else it touched. */
export async function check(root: string, id: string, cacheDir: string, voice: 'plain' | 'technical' = 'plain'): Promise<Check> {
  const { base, work } = await listWork(root)
  const item = work.find((w) => w.id === id)
  if (item === undefined) throw new Error(`no work in flight called ${id}`)

  const baseFacts = await factsAt(root, item.mergeBase, cacheDir)
  // A worktree is read as it is on disk, uncommitted work included; its
  // package versions are the manifests' ranges, like the commit it is
  // compared with.
  const head = item.path !== null
    ? await extract(item.path, { versions: 'declared' })
    : { facts: await factsAt(root, item.head, cacheDir), files: 0 }
  const changes = compare(baseFacts, head.facts)
  const gaps = head.facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')
  const report = toReport(changes, gaps, { files: head.files }, head.facts, false, voice)

  const commits = (await commitsBetween(root, item.mergeBase, item.head)).map((c) => ({ ...c, tasks: taskIdsOf(c.subject) }))
  // The branch's own tracker: that is where its worklog was written.
  const known = await readTasks(item.path ?? root)
  const byId = new Map(known.map((t) => [t.id, t]))
  const tasks = item.tasks.map((t) => byId.get(t)).filter((t): t is Task => t !== undefined)
  const unknownTasks = item.tasks.filter((t) => !byId.has(t))

  // A task names a file by its path, or by its file name alone — trackers
  // often write `review-queue.ts` without the folder.
  const cited = new Set(tasks.flatMap((t) => t.cites))
  const named = new Set(tasks.flatMap((t) => t.mentions))
  const product = item.changed.filter((f) => !isTestFile(f))
  const outside = cited.size === 0 && named.size === 0 ? [] : product.filter((f) => !cited.has(f) && !named.has(f.slice(f.lastIndexOf('/') + 1)) && !isTrackerFile(f))

  const others = work.filter((w) => w.id !== item.id)
  const overlaps = item.changed
    .map((file) => ({ file, with: others.filter((o) => o.changed.includes(file)).map((o) => o.branch ?? o.id) }))
    .filter((o) => o.with.length > 0)

  return {
    work: item, base, commits, tasks, unknownTasks, report,
    facts: { base: baseFacts, head: head.facts },
    tests: item.changed.filter(isTestFile), outside, overlaps,
  }
}

/** Tasks whose status says the PM acts next, from the checkout's trackers. */
export async function waitingOnYou(root: string): Promise<Task[]> {
  return (await readTasks(root)).filter((t) => t.status !== null && WAITING.has(t.status))
}

/** What changed on main between two commits: its commits, grouped by task,
 *  and the structural difference. */
export async function changedOnMain(root: string, from: string, to: string, cacheDir: string, voice: 'plain' | 'technical' = 'plain'): Promise<{ commits: (Commit & { tasks: string[] })[]; report: Report }> {
  const [before, after] = await Promise.all([factsAt(root, from, cacheDir), factsAt(root, to, cacheDir)])
  const changes = compare(before, after)
  const gaps = after.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')
  const commits = (await commitsBetween(root, from, to)).map((c) => ({ ...c, tasks: taskIdsOf(c.subject) }))
  return { commits, report: toReport(changes, gaps, { files: 0 }, after, false, voice) }
}

const isTrackerFile = (path: string): boolean => /(^|\/)[^/]*tracker[^/]*\.md$/i.test(path)
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)]

export { git }
