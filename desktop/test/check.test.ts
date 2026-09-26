import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWork, home } from '../src/core/service.js'
import type { CheckView } from '../src/shared/api.js'

const run = promisify(execFile)
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }

const PERMISSIONS = (finance: string): string => `import { Role } from './roles.js'
function p(action, resource, scope = 'org') { return { action, resource, scope } }
export const ROLE_PERMISSIONS = {
  [Role.ADMIN]: [p('*', '*')],
  [Role.FINANCE]: [${finance}],
}
`
const FILES: Record<string, string> = {
  'package.json': '{"name":"root","private":true}',
  'apps/api/package.json': '{"name":"api","dependencies":{"fastify":"^5.0.0","@prisma/client":"^5.0.0"}}',
  'apps/api/src/lib/roles.ts': "export enum Role { ADMIN = 'ADMIN', FINANCE = 'FINANCE' }\n",
  'apps/api/src/lib/permissions.ts': PERMISSIONS("p('view', 'renewal')"),
  'apps/api/src/app.ts': "import Fastify from 'fastify'\nimport { renewalRoutes } from './routes/renewals.js'\nexport async function build() { const app = Fastify(); await app.register(renewalRoutes, { prefix: '/api/v1/renewals' }); return app }\n",
  'apps/api/src/routes/renewals.ts': "export async function renewalRoutes(app: FastifyInstance) {\n  app.post('/:id/approve', { preHandler: requirePermission('approve', 'renewal') }, async () => prisma.renewal.update({}))\n}\n",
  'apps/api/prisma/schema.prisma': 'model Renewal {\n  id String @id\n}\n',
  'FIX_TRACKER.md': '# Tracker\n\n## Work\n\n- **FF1 — Let Finance approve renewals. — TODO.**\n',
}

let root: string
let cache: string
let view: CheckView
let workId: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'appguide-check-'))
  cache = await mkdtemp(join(tmpdir(), 'appguide-check-cache-'))
  for (const [p, t] of Object.entries(FILES)) { await mkdir(join(root, p, '..'), { recursive: true }); await writeFile(join(root, p), t) }
  const git = (...a: string[]) => run('git', a, { cwd: root, env })
  await git('init', '-q', '-b', 'main')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'Start')
  // The work: only the role table, the schema and some Python — nothing the
  // route reader alone would ever call a change.
  await git('checkout', '-q', '-b', 'feat/finance-approves')
  await writeFile(join(root, 'apps/api/src/lib/permissions.ts'), PERMISSIONS("p('view', 'renewal'), p('approve', 'renewal')"))
  await writeFile(join(root, 'apps/api/prisma/schema.prisma'), 'model Renewal {\n  id String @id\n  approvedBy String?\n}\n\nmodel Approval {\n  id String @id\n}\n')
  await mkdir(join(root, 'apps/api/prisma/migrations/20260926000000_add_approvals'), { recursive: true })
  await writeFile(join(root, 'apps/api/prisma/migrations/20260926000000_add_approvals/migration.sql'), 'CREATE TABLE "Approval" ();\n')
  await mkdir(join(root, 'apps/agents'), { recursive: true })
  await writeFile(join(root, 'apps/agents/approve.py'), 'def approve():\n    pass\n')
  await writeFile(join(root, 'FIX_TRACKER.md'), '# Tracker\n\n## Work\n\n- **FF1 — Let Finance approve renewals. — DONE.**\n  - Done when:\n    - Finance can approve a renewal.\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'Let Finance approve renewals (FF1)')
  // Ids come from Home, as in the app: git names a worktree by its real path.
  const h = await home({ id: 't', name: 'repo', path: root }, { checked: {} }, cache)
  workId = h.view.work.find((w) => w.where === 'checkout')!.id
  view = (await checkWork({ id: 't', name: 'repo', path: root }, workId, { checked: {} }, cache)).view
}, 120_000)

describe('a Check of work the route reader alone would call nothing', () => {
  it('says what each role may now do, from the branch’s own table', () => {
    expect(view.roleChanges).toEqual([{ role: 'FINANCE', resource: 'renewal', before: 'view', after: 'approve, view' }])
    const route = view.touched.concat(view.changes.route).find((r) => r.title === 'POST /api/v1/renewals/:id/approve')
    expect(route).toBeUndefined() // the route itself didn't change…
  })

  it('names the database change from the schema, and the migration', () => {
    expect(view.schema.tables).toEqual({ added: ['Approval'], removed: [], changed: ['Renewal'] })
    expect(view.schema.migrations).toEqual(['add approvals'])
  })

  it('lists what it can’t read, and gives no all-clear', () => {
    expect(view.unseen).toEqual([{ label: 'Python', files: ['apps/agents/approve.py'] }])
    expect(view.sentence).toBe('It changes what 1 role may do, adds 1 table, changes 1 table and adds 1 database migration. It also changes Python (1 file), which I can’t read.')
  })

  it('knows its task and its criteria, and that it merges cleanly and is not pushed', () => {
    expect(view.tasks.map((t) => [t.id, t.status, t.criteria])).toEqual([['FF1', 'DONE', ['Finance can approve a renewal.']]])
    expect(view.verdict).toMatchObject({ criteria: 1, mergeMain: { state: 'clean' }, pushed: { state: 'local' } })
  })

  it('shows on Home as ready for you, until checked', async () => {
    const h = await home({ id: 't', name: 'repo', path: root }, { checked: {} }, cache)
    expect(h.view.work.find((w) => w.id === workId)).toMatchObject({ ready: true, label: 'Let Finance approve renewals' })
  })
})
