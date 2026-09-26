import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, changedOnMain, listWork, waitingOnYou } from '../src/check/work.js'
import { resolve } from '../src/git/repo.js'

const run = promisify(execFile)
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, env })
const put = async (dir: string, path: string, text: string) => { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text) }

const APP = `import Fastify from 'fastify'
import { contractRoutes } from './routes/contracts.js'
export async function buildApp() {
  const app = Fastify()
  await app.register(contractRoutes, { prefix: '/api/v1/contracts' })
  return app
}
`
const ROUTES = `import { requirePermission } from '../lib/permissions.js'
export async function contractRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async () => [])
}
`
const PERMISSIONS = `export function requirePermission(action: string, resource: string) {
  return async (req, reply) => { if (!req.user) return reply.status(403).send() }
}
`
const tracker = (status: string, worklog = '') => `# Fix Tracker

## T1 — Let people delete a contract

- **Status:** ${status}
- **Evidence:** \`src/routes/contracts.ts\`
- **Acceptance criteria:**
  - A contract can be deleted by someone allowed to.
${worklog}`

let root: string
let feature: string
let cache: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'appguide-check-')))
  cache = await mkdtemp(join(tmpdir(), 'appguide-cache-'))
  await git(root, 'init', '-q', '-b', 'main')
  await put(root, 'package.json', '{"name":"api","dependencies":{"fastify":"^5.0.0"}}')
  await put(root, 'src/app.ts', APP)
  await put(root, 'src/routes/contracts.ts', ROUTES)
  await put(root, 'src/lib/permissions.ts', PERMISSIONS)
  await put(root, 'src/lib/other.ts', 'export const other = 1\n')
  await put(root, 'FIX_TRACKER.md', tracker('TODO'))
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'Start')

  // Claude's worktree: a route under T1, the tracker updated on the branch.
  feature = join(root, '.claude/worktrees/delete')
  await git(root, 'worktree', 'add', '-q', '-b', 'feat/delete', feature)
  await put(feature, 'src/routes/contracts.ts', ROUTES.replace("async () => [])\n", "async () => [])\n  app.delete('/:id', async () => ({}))\n"))
  await put(feature, 'FIX_TRACKER.md', tracker('VERIFY-PENDING', '- **Worklog:**\n  - **Verified:** a test deletes one.\n  - **Left out / follow-ups:** undo.\n'))
  await git(feature, 'add', '-A')
  await git(feature, 'commit', '-q', '-m', 'Let people delete a contract (T1)')
  // …and uncommitted work: a test, and a file T1 does not name.
  await put(feature, 'src/routes/contracts.test.ts', "it('deletes', () => {})\n")
  await put(feature, 'src/lib/other.ts', 'export const other = 2\n')

  // A second worktree touching the same routes file.
  const other = join(root, '.claude/worktrees/other')
  await git(root, 'worktree', 'add', '-q', '-b', 'feat/other', other)
  await put(other, 'src/routes/contracts.ts', ROUTES + '// tweak\n')
}, 60_000)

describe('work in flight', () => {
  it('lists each worktree with work not on main, and leaves out one with none', async () => {
    const { base, work } = await listWork(root)
    expect(base).toBe('main')
    expect(work.map((w) => w.branch)).toEqual(['feat/delete', 'feat/other'])
    const del = work.find((w) => w.branch === 'feat/delete')!
    expect(del).toMatchObject({ ahead: 1, tasks: ['T1'], primary: false })
    expect(del.changed).toEqual(['FIX_TRACKER.md', 'src/lib/other.ts', 'src/routes/contracts.test.ts', 'src/routes/contracts.ts'])
  })
})

describe('a Check', () => {
  it('says what the work did, against main, uncommitted work included', async () => {
    const c = await check(root, feature, cache)
    const added = [...c.report.top, ...c.report.also].map((ch) => ch.fact.kind === 'route' ? `${ch.type} ${ch.fact.method} ${ch.fact.path}` : null).filter(Boolean)
    expect(added).toEqual(['added DELETE /api/v1/contracts/:id'])
    const route = [...c.report.top, ...c.report.also].find((ch) => ch.fact.kind === 'route')!.fact
    expect(route.kind === 'route' && route.middleware).toEqual([])
  })

  it("shows its tasks as the branch's own tracker describes them", async () => {
    const c = await check(root, feature, cache)
    expect(c.tasks.map((t) => [t.id, t.status])).toEqual([['T1', 'VERIFY-PENDING']])
    expect(c.tasks[0]!.worklog.map((w) => w.label)).toEqual(['Verified', 'Left out / follow-ups'])
    expect(c.unknownTasks).toEqual([])
  })

  it('points out tests, what its tasks do not name, and what other work also touches', async () => {
    const c = await check(root, feature, cache)
    expect(c.tests).toEqual(['src/routes/contracts.test.ts'])
    expect(c.outside).toEqual(['src/lib/other.ts'])
    expect(c.overlaps).toEqual([{ file: 'src/routes/contracts.ts', with: ['feat/other'] }])
  })
})

describe('the rest of Home', () => {
  it("finds what is waiting on the PM in the checkout's tracker", async () => {
    expect(await waitingOnYou(root)).toEqual([])
    const tasks = await waitingOnYou(feature)
    expect(tasks.map((t) => t.id)).toEqual(['T1'])
  })

  it('says what changed on main between two commits, grouped by task', async () => {
    const from = await resolve(root, 'main')
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge feat/delete', 'feat/delete')
    const to = await resolve(root, 'main')
    const { commits, report } = await changedOnMain(root, from, to, cache)
    expect(commits.map((c) => c.tasks)).toEqual([['T1']])
    expect([...report.top, ...report.also].some((ch) => ch.fact.kind === 'route' && ch.fact.method === 'DELETE')).toBe(true)
  })
})
