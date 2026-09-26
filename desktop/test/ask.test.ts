import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDraftedTask, draftTask } from '../src/core/ask.js'

const run = promisify(execFile)
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }

const FILES: Record<string, string> = {
  'package.json': '{"name":"root","private":true}',
  'apps/api/package.json': '{"name":"api","dependencies":{"fastify":"^5.0.0","@prisma/client":"^5.0.0"}}',
  'apps/api/src/app.ts': "import Fastify from 'fastify'\nimport { approvalRoutes } from './routes/approvals.js'\nexport async function build() { const app = Fastify(); await app.register(approvalRoutes, { prefix: '/api/v1/approvals' }); return app }\n",
  'apps/api/src/routes/approvals.ts': "export async function approvalRoutes(app: FastifyInstance) {\n  app.post('/:instanceId/decide', { preHandler: requirePermission('approve', 'workflow') }, async () => prisma.approvalStep.update({}))\n}\n",
  'FIX_TRACKER.md': `# Fix Tracker

## S1 — First

- **Status:** DONE

## Redline review actions (2026-09-26)

- **EE1 — Every action is a decision. — DONE.**

## Run log

- EE1 merged.
`,
}

let root: string
let cache: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'appguide-ask-'))
  cache = await mkdtemp(join(tmpdir(), 'appguide-ask-cache-'))
  for (const [p, t] of Object.entries(FILES)) { await mkdir(join(root, p, '..'), { recursive: true }); await writeFile(join(root, p), t) }
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root, env })
  await run('git', ['add', '-A'], { cwd: root, env })
  await run('git', ['commit', '-q', '-m', 'Start'], { cwd: root, env })
}, 60_000)

const input = {
  what: 'Let Finance approve renewals',
  why: 'Renewals wait on legal today.',
  criteria: ['Someone with FINANCE can approve a renewal.'],
  picks: [{ kind: 'route' as const, key: 'POST /api/v1/approvals/:instanceId/decide' }],
}

describe('asking for a change', () => {
  it('drafts the next task with the code’s own facts, writing nothing', async () => {
    const d = await draftTask(root, input, cache)
    expect(d).toMatchObject({ id: 'EE2', suggestedId: 'EE2', file: 'FIX_TRACKER.md', branch: 'main', problem: null })
    expect(d.text).toContain('`POST /api/v1/approvals/:instanceId/decide` in `apps/api/src/routes/approvals.ts:2`')
    expect(d.brief.split('\n')[0]).toBe('Work task EE2 in FIX_TRACKER.md, following the cycle and ground rules at the top of that file. Name the task in each commit subject, like "(EE2)".')
    expect(d.brief).toContain('it changes approvalStep')
    expect((await run('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('')
  }, 60_000)

  it('refuses to write a task with nothing to check it against', async () => {
    await expect(addDraftedTask(root, { ...input, criteria: [''] }, cache)).rejects.toThrow(/done when/)
  }, 60_000)

  it('adds it before the tracker’s log, and changes nothing else', async () => {
    const r = await addDraftedTask(root, input, cache)
    expect(r).toMatchObject({ id: 'EE2', file: 'FIX_TRACKER.md' })
    const tracker = await readFile(join(root, 'FIX_TRACKER.md'), 'utf8')
    expect(tracker.indexOf('### EE2 — Let Finance approve renewals')).toBeLessThan(tracker.indexOf('## Run log'))
    expect((await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()).toBe('M FIX_TRACKER.md')
  }, 60_000)
})
