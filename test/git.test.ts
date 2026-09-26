import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRef, uncommitted, worktrees } from '../src/git/repo.js'
import { listWork } from '../src/check/work.js'

const run = promisify(execFile)
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, env })

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appguide git ')))
  await git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'Start')
  return root
}

describe('the git layer, in awkward places', () => {
  it('works in a folder whose path has spaces, with no origin at all', async () => {
    const root = await repo()
    expect(root).toContain(' ')
    expect(await baseRef(root)).toBe('main')
  })

  it('lists a detached worktree, and one whose branch has slashes and whose path has spaces', async () => {
    const root = await repo()
    await git(root, 'worktree', 'add', '-q', '--detach', join(root, 'wt detached'))
    await git(root, 'worktree', 'add', '-q', '-b', 'feat/deep/name', join(root, 'wt named'))
    await writeFile(join(root, 'wt named', 'b.ts'), 'export const b = 2\n')
    const list = await worktrees(root)
    expect(list.map((w) => [w.branch, w.primary])).toEqual([['main', true], [null, false], ['feat/deep/name', false]])
    const { work } = await listWork(root)
    expect(work.map((w) => w.branch)).toEqual(['feat/deep/name'])
    expect(work[0]!.uncommitted).toEqual(['b.ts'])
  })

  it('reads a file name git has to quote', async () => {
    const root = await repo()
    await writeFile(join(root, 'naïve "name".ts'), 'export const c = 3\n')
    expect(await uncommitted(root)).toEqual(['naïve "name".ts'])
  })

  it('never lists a worktree kept inside another as that one’s change', async () => {
    const root = await repo()
    await mkdir(join(root, '.claude/worktrees'), { recursive: true })
    await git(root, 'worktree', 'add', '-q', '-b', 'inner', join(root, '.claude/worktrees/inner'))
    await writeFile(join(root, '.claude/worktrees/inner/c.ts'), 'x\n')
    const { work } = await listWork(root)
    expect(work.map((w) => w.branch)).toEqual(['inner'])
  })
})

describe('asking git questions without writing', () => {
  it('says whether two branches merge, leaving the object store as it was', async () => {
    const { mkdtemp: mk, writeFile: wf, readdir: rd } = await import('node:fs/promises')
    const { join: j } = await import('node:path')
    const { tmpdir: td } = await import('node:os')
    const { execFileSync } = await import('node:child_process')
    const { mergesCleanly } = await import('../src/git/repo.js')
    const dir = await mk(j(td(), 'appguide-merge-test-'))
    const g = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T')
    await wf(j(dir, 'a.txt'), 'one\ntwo\nthree\n'); g('add', '.'); g('commit', '-qm', 'base')
    g('checkout', '-qb', 'left'); await wf(j(dir, 'a.txt'), 'ONE\ntwo\nthree\n'); g('commit', '-qam', 'left')
    g('checkout', '-q', 'main'); g('checkout', '-qb', 'right'); await wf(j(dir, 'a.txt'), 'uno\ntwo\nthree\n'); g('commit', '-qam', 'right')
    g('checkout', '-q', 'main'); g('checkout', '-qb', 'apart'); await wf(j(dir, 'b.txt'), 'new\n'); g('add', '.'); g('commit', '-qm', 'apart')
    const count = async (): Promise<number> => (await rd(j(dir, '.git/objects'), { recursive: true })).length
    const before = await count()
    expect(await mergesCleanly(dir, 'left', 'right')).toEqual({ clean: false, files: ['a.txt'] })
    expect(await mergesCleanly(dir, 'left', 'apart')).toEqual({ clean: true })
    expect(await count()).toBe(before)
  })
})
