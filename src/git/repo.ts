import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec(await gitBinary(), [...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
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
  for (const block of (await git(root, ['worktree', 'list', '--porcelain'])).split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]
    if (path === undefined || head === undefined || /^bare$/m.test(block)) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    out.push({ path, head, branch, primary: out.length === 0 })
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
  if (files.length > 0) await archive(root, sha, files, dest)
}

/** `git archive <sha> -- files… | tar -x -C dest`, without a shell. */
async function archive(root: string, sha: string, files: readonly string[], dest: string): Promise<void> {
  const binary = await gitBinary()
  await new Promise<void>((resolvePromise, reject) => {
    const producer = spawn(binary, ['archive', '--format=tar', sha, '--', ...files], { cwd: root })
    const consumer = spawn('/usr/bin/tar', ['-x', '-C', dest])
    let failed = false
    const fail = (err: Error): void => { if (!failed) { failed = true; reject(err) } }
    producer.stdout.pipe(consumer.stdin)
    producer.on('error', fail)
    consumer.on('error', fail)
    let stderr = ''
    producer.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    producer.on('close', (code) => { if (code !== 0) fail(new Error(`git archive failed: ${stderr.trim()}`)) })
    consumer.on('close', (code) => { if (code === 0) { if (!failed) resolvePromise() } else fail(new Error('tar could not unpack the commit')) })
  })
}
