import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
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
import { parseTasks, readTasks, taskIdsOf, WAITING, type Task } from '../tracker/tasks.js'
import { progress, readPlan } from '../tracker/plan.js'

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
  /** Task IDs whose tracker entries this work added or changed — how work
   *  with no commits yet says what it is for. */
  edited: string[]
  /** A plan document it added or changed — docs/39-FIELD-CAPTURE-PLAN.md —
   *  and how far its register has got, where it keeps one. */
  plan: { file: string; title: string; done: number; total: number } | null
  /** Files that differ from main: committed and uncommitted. */
  changed: string[]
  /** The newest commit's date, or null if it has none of its own. */
  lastCommit: string | null
  /** Changes whenever anything in it does — a commit, or any edit to an
   *  uncommitted file — so "checked" can't outlive what was checked. */
  fingerprint: string
  /** When its uncommitted files were last, and first, changed. */
  lastEdit: string | null
  oldestEdit: string | null
}

export interface WorkList {
  base: string
  baseHead: string
  work: Work[]
  /** Work that could not be read, and why. */
  skipped: { name: string; reason: string }[]
  /** Branches whose every changed file is already the same on main. */
  merged: number
  /** Branches left unread: no commit in four months, or past the newest forty. */
  untouched: number
  /** When main was last fetched: "main" is main as of then. */
  fetchedAt: string | null
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

/**
 * Every worktree with work not on main, the checkout included when it is on
 * another branch; with `branches`, also every branch with commits not on main
 * that no worktree has checked out — local ones, and origin's. Git only:
 * nothing is read into facts here.
 */
export async function listWork(root: string, opts: { branches?: boolean } = {}): Promise<WorkList> {
  const base = await baseRef(root)
  const baseHead = await resolve(root, base)
  const out: Work[] = []
  const skipped: WorkList['skipped'] = []
  const all = await worktrees(root)
  for (const wt of all) {
    try {
      const mb = await mergeBase(root, base, wt.head)
      const commits = await commitsBetween(root, mb, wt.head)
      // A worktree kept inside another checkout (Claude keeps them in
      // .claude/worktrees/) shows up there as untracked files. It is its own
      // work, never a change to the checkout that happens to contain it.
      const nested = all.filter((o) => o.path !== wt.path && o.path.startsWith(`${wt.path}/`)).map((o) => `${o.path.slice(wt.path.length + 1)}/`)
      const dirty = (await uncommitted(wt.path)).filter((f) => !nested.some((n) => f === n || f.startsWith(n)))
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
        ...(await fingerprint(wt.path, wt.head, dirty)),
        ...(await ownWords(root, mb, unique([...committed, ...dirty]), (f) => readFile(join(wt.path, f), 'utf8'))),
      })
    } catch (e) {
      // One worktree on a branch with no history in common with main must not
      // take every other one down with it.
      skipped.push({ name: wt.branch ?? basename(wt.path), reason: reasonOf(e) })
    }
  }
  let merged = 0
  let untouched = 0
  if (opts.branches === true) {
    const taken = new Set(all.flatMap((w) => (w.branch === null ? [] : [w.branch])))
    // Newest first, with when each last moved: a repository with hundreds of
    // branches is read for its recent ones, not all of them on every look.
    const refs = (await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)', 'refs/heads', 'refs/remotes/origin']))
      .split('\n').filter(Boolean).map((l) => { const [ref = '', sha = '', when = '0'] = l.split('\0'); return { ref, sha, when: Number(when) * 1000 } })
    const local = new Set(refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => r.ref.slice('refs/heads/'.length)))
    const baseName = base.replace(/^origin\//, '')
    let read = 0
    for (const { ref, sha, when } of refs) {
      const isLocal = ref.startsWith('refs/heads/')
      const name = isLocal ? ref.slice('refs/heads/'.length) : ref.slice('refs/remotes/origin/'.length)
      if (name === 'HEAD' || name === baseName || taken.has(name) || (!isLocal && local.has(name))) continue
      if (read >= 40 || Date.now() - when > 120 * 86_400_000) { untouched++; continue }
      read++
      const short = isLocal ? name : `origin/${name}`
      try {
        const mb = await mergeBase(root, base, sha)
        const commits = await commitsBetween(root, mb, sha)
        if (commits.length === 0) continue
        const changed = await changedBetween(root, mb, sha)
        // Squash-merged or superseded: everything it changed already reads the
        // same on main. Not work in flight.
        if (changed.length > 0 && changed.length <= 2000 && (await git(root, ['diff', '--name-only', '-z', sha, baseHead, '--', ...changed])) === '') { merged++; continue }
        out.push({
          id: `branch:${short}`, branch: short, path: null, primary: false, head: sha, mergeBase: mb,
          ahead: commits.length, uncommitted: [], tasks: unique(commits.slice().reverse().flatMap((c) => taskIdsOf(c.subject))),
          changed: changed.sort(), lastCommit: commits[0]?.date ?? null, fingerprint: sha, lastEdit: null, oldestEdit: null,
          ...(await ownWords(root, mb, changed, (f) => git(root, ['show', `${sha}:${f}`]))),
        })
      } catch (e) {
        skipped.push({ name: short, reason: reasonOf(e) })
      }
    }
  }
  return { base, baseHead, work: out, skipped, merged, untouched, fetchedAt: await fetchedAt(root) }
}

/**
 * What a piece of work says about itself in the files it changed: the tracker
 * entries it added or edited, and a plan document it wrote. Read against the
 * commit it started from, so an entry it only carries along is not its own.
 */
async function ownWords(root: string, mb: string, changed: readonly string[], read: (file: string) => Promise<string>): Promise<{ edited: string[]; plan: Work['plan'] }> {
  const edited: string[] = []
  let plan: Work['plan'] = null
  for (const file of changed.filter((f) => /\.md$/i.test(f))) {
    const now = await read(file).catch(() => null)
    if (now === null) continue
    const before = await git(root, ['show', `${mb}:${file}`]).catch(() => '')
    const was = new Map(parseTasks(file, before).map((t) => [t.id, `${t.status}\0${t.text}`]))
    for (const t of parseTasks(file, now)) if (was.get(t.id) !== `${t.status}\0${t.text}`) edited.push(t.id)
    // A numbered plan in docs/, new or changed: "docs/39-FIELD-CAPTURE-PLAN.md".
    if (plan === null && /^docs\/(?:[^/]+\/)*\d+[-_][^/]*\.md$/i.test(file) && !isTrackerFile(file) && /^#\s+\S/m.test(now)) {
      const read = readPlan(file, now)
      const p = progress(read)
      plan = { file, title: read.title, done: p.done, total: p.total }
    }
  }
  return { edited: unique(edited), plan }
}

/** A worktree's state in one value — its commit, and each uncommitted file's
 *  size and modification time — and when those files last and first changed. */
async function fingerprint(dir: string, head: string, files: readonly string[]): Promise<{ fingerprint: string; lastEdit: string | null; oldestEdit: string | null }> {
  const h = createHash('sha1').update(head)
  let newest = -Infinity
  let oldest = Infinity
  for (const f of [...files].sort()) {
    const st = await stat(join(dir, f)).catch(() => null)
    h.update(`\0${f}\0${st === null ? 'gone' : `${st.size}:${st.mtimeMs}`}`)
    if (st !== null) { newest = Math.max(newest, st.mtimeMs); oldest = Math.min(oldest, st.mtimeMs) }
  }
  return {
    fingerprint: h.digest('hex').slice(0, 16),
    lastEdit: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    oldestEdit: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
  }
}

async function fetchedAt(root: string): Promise<string | null> {
  try {
    const dir = (await git(root, ['rev-parse', '--git-common-dir'])).trim()
    return (await stat(join(isAbsolute(dir) ? dir : join(root, dir), 'FETCH_HEAD'))).mtime.toISOString()
  } catch {
    return null
  }
}

const reasonOf = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e)
  return /merge-base/.test(text) ? 'it shares no history with main' : /timed out|ETIMEDOUT|SIGTERM/.test(text) ? 'reading it took too long' : 'git could not read it'
}

/** The tasks a commit's own trackers define, read from git. */
export async function tasksAt(root: string, sha: string): Promise<Task[]> {
  const names = (await git(root, ['ls-tree', '--name-only', '-z', sha])).split('\0').filter((f) => /\.md$/i.test(f))
  const docs = (await git(root, ['ls-tree', '--name-only', '-z', sha, 'docs/']).catch(() => '')).split('\0').filter((f) => /\.md$/i.test(f))
  const order = [...names.filter((f) => /tracker/i.test(f)).sort(), ...names.filter((f) => !/tracker/i.test(f)).sort(), ...docs.sort()]
  const seen = new Set<string>()
  const out: Task[] = []
  for (const file of order) {
    let text: string
    try { text = await git(root, ['show', `${sha}:${file}`]) } catch { continue }
    for (const t of parseTasks(file, text)) if (!seen.has(t.id)) { seen.add(t.id); out.push(t) }
  }
  return out
}

/** One piece of work against main: what it did, which tasks it says it is
 *  for, and what else it touched. */
export async function check(root: string, id: string, cacheDir: string, voice: 'plain' | 'technical' = 'plain', opts: { list?: WorkList; head?: Fact[] } = {}): Promise<Check> {
  const { base, work } = opts.list ?? await listWork(root, { branches: id.startsWith('branch:') })
  const item = work.find((w) => w.id === id)
  if (item === undefined) throw new Error('That work isn’t in flight any more — it may have been merged or put away.')

  const baseFacts = await factsAt(root, item.mergeBase, cacheDir)
  // A worktree with uncommitted work is read as it is on disk; its package
  // versions are the manifests' ranges, like the commit it is compared with.
  // Everything else is read at its commit, and cached by it.
  const live = item.path !== null && item.uncommitted.length > 0
  const head = opts.head !== undefined ? { facts: opts.head, files: 0 }
    : live ? await extract(item.path!, { versions: 'declared' })
    : { facts: await factsAt(root, item.head, cacheDir), files: 0 }
  const changes = compare(baseFacts, head.facts)
  const gaps = head.facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')
  const report = toReport(changes, gaps, { files: head.files }, head.facts, false, voice)

  const commits = (await commitsBetween(root, item.mergeBase, item.head)).map((c) => ({ ...c, tasks: taskIdsOf(c.subject) }))
  // The branch's own tracker: that is where its worklog was written. Before
  // its first commit names a task, the entries it edited say what it is for.
  const known = item.path !== null ? await readTasks(item.path) : await tasksAt(root, item.head)
  const byId = new Map(known.map((t) => [t.id, t]))
  const ids = item.tasks.length > 0 ? item.tasks : item.edited
  const tasks = ids.map((t) => byId.get(t)).filter((t): t is Task => t !== undefined)
  const unknownTasks = ids.filter((t) => !byId.has(t))

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
