import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Which project a command is about.
 *
 * Claude Code runs hooks in whatever folder Claude last moved into, and the
 * commands Claude runs start there too. Reading the current folder meant that
 * after an agent ran `cd web && npm install`, the next receipt was a first look
 * at web/ instead of a diff of the app — and Claude's copy was left where the
 * prompt hook never looks.
 *
 * Inside a Claude Code session (CLAUDE_PROJECT_DIR), it is the nearest folder
 * with appguide's notes or a repository of its own, never above the session's
 * project: the project itself, unless Claude is working in a worktree inside
 * it. Anywhere else, the nearest folder above with appguide's notes, the way
 * git finds a repository — without climbing out of a repository to get there,
 * so a git-tracked home folder is never scanned. With nothing found, the
 * current folder, as before.
 */
export async function findRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const start = await real(cwd)
  const session = env['CLAUDE_PROJECT_DIR']
  const project = session !== undefined && session !== '' ? await real(session) : undefined
  const ceiling = project !== undefined && inside(start, project) ? project : undefined
  for (let dir = start; ; dir = dirname(dir)) {
    if (await exists(join(dir, '.appguide'))) return dir
    const repo = await exists(join(dir, '.git'))
    if (ceiling !== undefined) {
      if (repo || dir === ceiling) return dir
    } else if (repo || dirname(dir) === dir) {
      return start
    }
  }
}

const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path))
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path)
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}
