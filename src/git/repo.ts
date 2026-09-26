import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Fact } from '../model/facts.js'
import { extract } from '../run.js'

const exec = promisify(execFile)

/**
 * Git, read only. Nothing here writes to a repository: no fetch, no checkout,
 * no worktree changes. The product at a commit is read by extracting that
 * commit's source files into a scratch folder.
 */

/** An app started from the Dock has no shell PATH, so git is looked for where
 *  it is installed as well as on the PATH. */
const CANDIDATES = ['git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
let found: string | undefined

export async function gitBinary(): Promise<string> {
  if (found !== undefined) return found
  for (const candidate of [process.env['APPGUIDE_GIT'], ...CANDIDATES]) {
    if (candidate === undefined || candidate === '') continue
    try {
      await exec(candidate, ['--version'])
      found = candidate
      return candidate
    } catch {
      // not here
    }
  }
  throw new Error('git was not found — it is needed to read branches and history')
}

/**
 * Reads never take git's optional locks. Without this, `git status` refreshes
 * a worktree's index under index.lock, and Claude's own `git add` in that
 * worktree at the same moment fails with "index.lock: File exists".
 */
const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })

/** Long enough for a status of a very large tree; short enough that one hung
 *  read (a lazy fetch, a file evicted to the cloud) can't freeze every screen. */
const TIMEOUT = 120_000

export async function git(cwd: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec(await gitBinary(), [...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...env(), ...extra }, timeout: TIMEOUT })
  return stdout
}

export interface Worktree {
  path: string
  head: string
  /** null when HEAD is detached. */
  branch: string | null
  /** The repository's own checkout, as opposed to an added worktree. */
  primary: boolean
}

export async function worktrees(root: string): Promise<Worktree[]> {
  const out: Worktree[] = []
  // NUL-separated where git can (2.36 and later), so no path comes back quoted.
  const listed = await git(root, ['worktree', 'list', '--porcelain', '-z']).then((t) => t.split(/\0\0+/).map((b) => b.split('\0')),
    async () => (await git(root, ['worktree', 'list', '--porcelain'])).split(/\n\n+/).map((b) => b.split('\n')))
  // git lists the repository's own checkout first.
  for (const [index, lines] of listed.entries()) {
    const field = (name: string): string | undefined => lines.find((l) => l === name || l.startsWith(`${name} `))?.slice(name.length + 1)
    const path = field('worktree')
    const head = field('HEAD')
    if (path === undefined || head === undefined || !/^[0-9a-f]+$/.test(head) || lines.includes('bare')) continue
    // A worktree whose folder was deleted without `git worktree prune`: there
    // is nothing on disk to read, and reading it showed every route as gone.
    if (lines.some((l) => l === 'prunable' || l.startsWith('prunable ')) || !existsSync(path)) continue
    const branch = field('branch')?.replace(/^refs\/heads\//, '') ?? null
    out.push({ path, head, branch, primary: index === 0 })
  }
  return out
}

/** What "main" means here: origin's default branch as last fetched, else a
 *  local main or master. Local refs only — reading never fetches. */
export async function baseRef(root: string): Promise<string> {
  try {
    const ref = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (ref !== '') return ref
  } catch {
    // no origin/HEAD
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await exists(root, ref)) return ref
  }
  throw new Error('no main branch found')
}

export async function exists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

export const resolve = async (root: string, ref: string): Promise<string> =>
  (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()

export const mergeBase = async (root: string, a: string, b: string): Promise<string> =>
  (await git(root, ['merge-base', a, b])).trim()

export interface Commit { sha: string; subject: string; author: string; date: string }

/** Commits reachable from `head` but not from `base`, newest first, merges left out. */
export async function commitsBetween(root: string, base: string, head: string): Promise<Commit[]> {
  const out = await git(root, ['log', '--no-merges', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${base}..${head}`])
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha = '', subject = '', author = '', date = ''] = r.split('\x1f')
    return { sha, subject, author, date }
  })
}

/** Files that differ between two commits. */
export async function changedBetween(root: string, base: string, head: string): Promise<string[]> {
  return nul(await git(root, ['diff', '--name-only', '--no-renames', '-z', base, head]))
}

/** Uncommitted work in a worktree: modified, added and untracked files. */
export async function uncommitted(worktree: string): Promise<string[]> {
  // -z: each entry ends in NUL and no path is quoted. Without it, a name with
  // an accent or a quote comes back octal-escaped inside quotes.
  return nul(await git(worktree, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])).map((e) => e.slice(3))
}

/** git's NUL-separated output: names exactly as they are, never quoted. */
const nul = (text: string): string[] => text.split('\0').filter((e) => e !== '')

/** The files that describe the product: source in every language we read or
 *  count, and the manifests and configs that say how it fits together. */
const PRODUCT_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|php|cs|swift|scala|ex|exs|dart|vue|svelte)$|(^|\/)(package\.json|pnpm-workspace\.yaml|[tj]sconfig(\..+)?\.json|pyvenv\.cfg)$/

/**
 * The product's facts as of a commit, read from git into a scratch folder and
 * cached by commit: a commit never changes, so neither do its facts. Package
 * versions are the manifests' own ranges, since a commit has no node_modules.
 */
export async function factsAt(root: string, sha: string, cacheDir: string): Promise<Fact[]> {
  // Two asks for the same commit at once share one read.
  const key = `${cacheDir}\u0000${sha}`
  const running = reading.get(key)
  if (running !== undefined) return running
  const p = readFactsAt(root, sha, cacheDir).finally(() => reading.delete(key))
  reading.set(key, p)
  return p
}

const reading = new Map<string, Promise<Fact[]>>()

async function readFactsAt(root: string, sha: string, cacheDir: string): Promise<Fact[]> {
  const cached = join(cacheDir, `${sha}.json`)
  try {
    return JSON.parse(await readFile(cached, 'utf8')) as Fact[]
  } catch {
    // not cached yet
  }
  const scratch = await mkdtemp(join(tmpdir(), 'appguide-commit-'))
  try {
    await checkoutAt(root, sha, scratch)
    const { facts } = await extract(scratch, { versions: 'declared' })
    await writeAtomically(cached, JSON.stringify(facts))
    return facts
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Write through a temporary file with a name no other writer shares, so two
 *  writers of the same cache entry never rename each other's file away. */
export async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** A commit's product files, written into `dest` — never into the repository. */
export async function checkoutAt(root: string, sha: string, dest: string): Promise<void> {
  const files = nul(await git(root, ['ls-tree', '-r', '--name-only', '-z', sha])).filter((p) => PRODUCT_FILE.test(p))
  // In batches: tens of thousands of names overflow one command line.
  for (let i = 0; i < files.length; i += 2000) await archive(root, sha, files.slice(i, i + 2000), dest)
}

/** `git archive <sha> -- files… | tar -x -C dest`, without a shell. */
async function archive(root: string, sha: string, files: readonly string[], dest: string): Promise<void> {
  const binary = await gitBinary()
  await new Promise<void>((resolvePromise, reject) => {
    const producer = spawn(binary, ['archive', '--format=tar', sha, '--', ...files], { cwd: root, env: env() })
    const consumer = spawn('/usr/bin/tar', ['-x', '-C', dest])
    let failed = false
    const timer = setTimeout(() => { producer.kill(); consumer.kill(); fail(new Error('reading the commit took too long')) }, TIMEOUT)
    const fail = (err: Error): void => { clearTimeout(timer); if (!failed) { failed = true; reject(err) } }
    producer.stdout.pipe(consumer.stdin)
    producer.on('error', fail)
    consumer.on('error', fail)
    let stderr = ''
    producer.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    producer.on('close', (code) => { if (code !== 0) fail(new Error(`git archive failed: ${stderr.trim()}`)) })
    consumer.on('close', (code) => { clearTimeout(timer); if (code === 0) { if (!failed) resolvePromise() } else fail(new Error('tar could not unpack the commit')) })
  })
}

/**
 * Whether `theirs` merges into `ours` without conflicts, worked out by
 * `merge-tree`: no worktree, index or ref is touched, and the objects the
 * merge makes go to a scratch folder, reading the repository's own as an
 * alternate — its object store is left exactly as it was. null when this git
 * can't say (older than 2.38).
 */
export async function mergesCleanly(root: string, ours: string, theirs: string): Promise<{ clean: true } | { clean: false; files: string[] } | null> {
  const scratch = await mkdtemp(join(tmpdir(), 'appguide-merge-'))
  try {
    const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim()
    const objects = join(isAbsolute(common) ? common : join(root, common), 'objects')
    // Git splits this list at colons; a path holding one is written quoted.
    const alternate = /[:"\\]/.test(objects) ? `"${objects.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : objects
    const out = await git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate })
    return /^[0-9a-f]{40,64}/.test(out) ? { clean: true } : null
  } catch (e) {
    // Exit 1 with a tree id and the conflicted files is a conflict. Exit 1
    // for anything else — "not something we can merge" — is not an answer.
    const err = e as { code?: number; stdout?: string }
    if (err.code !== 1 || err.stdout === undefined) return null
    const [tree, ...files] = err.stdout.split('\0')
    if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) return null
    const names = [...new Set(files.filter((f) => f !== ''))]
    return names.length === 0 ? null : { clean: false, files: names }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Where a branch is pushed, and how many of its commits aren't there yet. */
export async function upstreamOf(root: string, branch: string, head: string): Promise<{ upstream: string; unpushed: number } | null> {
  try {
    const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).trim()
    const unpushed = Number((await git(root, ['rev-list', '--count', `${upstream}..${head}`])).trim())
    return { upstream, unpushed }
  } catch {
    return null
  }
}

/** One block of changed lines, as its new version numbers them. */
export interface Hunk {
  start: number
  end: number
  added: string[]
  removed: string[]
}

/**
 * The blocks of `file` a change touched, in its new version's line numbers,
 * against the working tree when `head` is null — uncommitted edits included.
 * A block that only touches comments or blank lines is left out: a comment
 * moved above a route is not a change to what that route does.
 */
export async function changedHunks(cwd: string, from: string, head: string | null, file: string): Promise<Hunk[]> {
  const out = await git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', from, ...(head === null ? [] : [head]), '--', file]).catch(() => '')
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const line of out.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h !== null) {
      const start = Number(h[1])
      const count = h[2] === undefined ? 1 : Number(h[2])
      current = { start, end: start + Math.max(count, 1) - 1, added: [], removed: [] }
      hunks.push(current)
    } else if (current !== null && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1))
    else if (current !== null && line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1))
  }
  return hunks.filter((k) => [...k.added, ...k.removed].some((l) => !isCommentOrBlank(l)))
}

const isCommentOrBlank = (line: string): boolean => /^\s*($|\/\/|\/\*|\*|#(?!!))/.test(line)

/** The line ranges of `changedHunks`. */
export async function changedLines(cwd: string, from: string, head: string | null, file: string): Promise<[number, number][]> {
  return (await changedHunks(cwd, from, head, file)).map((k) => [k.start, k.end])
}

/** One file as it was where two lines of work parted, and as each has it now
 *  (null where it doesn't exist). */
export interface FileSides { path: string; base: string | null; ours: string | null; theirs: string | null }

/**
 * Whether files merge without conflicts, from their contents alone — for
 * work that isn't committed yet, the files as they are now. Each is merged
 * with `git merge-file` on scratch copies; nothing in a repository is read or
 * written.
 */
export async function filesMerge(files: readonly FileSides[]): Promise<{ clean: true } | { clean: false; files: string[] }> {
  const conflicts: string[] = []
  let scratch: string | null = null
  try {
    for (const f of files) {
      if (f.ours === f.theirs || f.base === f.theirs || f.base === f.ours) continue
      // Added on both sides differently, or changed on one side and removed on the other.
      if (f.ours === null || f.theirs === null || f.base === null) { conflicts.push(f.path); continue }
      scratch ??= await mkdtemp(join(tmpdir(), 'appguide-merge-'))
      const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => join(scratch!, n))
      await writeFile(o!, f.ours)
      await writeFile(b!, f.base)
      await writeFile(t!, f.theirs)
      try {
        await exec(await gitBinary(), ['merge-file', '-p', '--quiet', o!, b!, t!], { cwd: scratch, env: env(), timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 })
      } catch (e) {
        // The exit code is the number of conflicts; a negative one is an error.
        if (((e as { code?: number }).code ?? -1) > 0) conflicts.push(f.path)
        else throw e
      }
    }
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true })
  }
  return conflicts.length === 0 ? { clean: true } : { clean: false, files: conflicts }
}
