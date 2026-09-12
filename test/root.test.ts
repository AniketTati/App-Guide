import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRoot } from '../src/root.js'

/** A folder tree: a path ending in / is a folder, anything else an empty file. */
async function tree(...paths: string[]): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'appguide-root-')))
  for (const p of paths) {
    await mkdir(join(dir, p.endsWith('/') ? p : join(p, '..')), { recursive: true })
    if (!p.endsWith('/')) await writeFile(join(dir, p), '')
  }
  return dir
}

const terminal = {}
const session = (project: string) => ({ CLAUDE_PROJECT_DIR: project })

describe('which project a command is about', () => {
  it('inside Claude Code, after Claude moved into a subfolder, is still the project', async () => {
    const d = await tree('app/.appguide/', 'app/web/src/')
    expect(await findRoot(join(d, 'app/web/src'), session(join(d, 'app')))).toBe(join(d, 'app'))
  })

  it('is the project before its first look too, so the first notes land where the prompt hook reads', async () => {
    const git = await tree('app/.git/', 'app/web/')
    expect(await findRoot(join(git, 'app/web'), session(join(git, 'app')))).toBe(join(git, 'app'))
    const none = await tree('app/web/')
    expect(await findRoot(join(none, 'app/web'), session(join(none, 'app')))).toBe(join(none, 'app'))
  })

  it('is the worktree Claude is working in, not the checkout the session started from', async () => {
    const d = await tree('app/.git/', 'app/.appguide/', 'app/.claude/worktrees/fix/.git', 'app/.claude/worktrees/fix/src/')
    expect(await findRoot(join(d, 'app/.claude/worktrees/fix/src'), session(join(d, 'app'))))
      .toBe(join(d, 'app/.claude/worktrees/fix'))
  })

  it('is wherever a command was run, when that is outside the session', async () => {
    const d = await tree('app/.appguide/', 'other/.appguide/')
    expect(await findRoot(join(d, 'other'), session(join(d, 'app')))).toBe(join(d, 'other'))
  })

  it('recognises the session project through a symlinked path', async () => {
    const d = await tree('app/.appguide/', 'app/web/')
    await symlink(join(d, 'app'), join(d, 'link'))
    expect(await findRoot(join(d, 'app/web'), session(join(d, 'link')))).toBe(join(d, 'app'))
  })

  it('from a terminal, finds the notes above it, the way git finds a repository', async () => {
    const d = await tree('app/.appguide/', 'app/web/src/')
    expect(await findRoot(join(d, 'app/web/src'), terminal)).toBe(join(d, 'app'))
  })

  it('from a terminal with no notes anywhere, is the current folder — never a git-tracked folder above it', async () => {
    const d = await tree('.git/', 'projects/app/src/')
    expect(await findRoot(join(d, 'projects/app'), terminal)).toBe(join(d, 'projects/app'))
  })

  it('does not climb out of one repository to use the notes of another', async () => {
    const d = await tree('.appguide/', 'inner/.git/', 'inner/src/')
    expect(await findRoot(join(d, 'inner/src'), terminal)).toBe(join(d, 'inner/src'))
  })
})
