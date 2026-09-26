import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDraftedTask, draftTask } from '../src/core/ask.js'
import { askInput } from '../src/core/input.js'

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
  it('drafts a task in a family of its own, in the tracker’s newest shape, writing nothing', async () => {
    const d = await draftTask(root, { ...input, severity: 'Medium' }, cache)
    expect(d).toMatchObject({ id: 'FF1', suggestedId: 'FF1', file: 'FIX_TRACKER.md', branch: 'main', problem: null, cantAdd: null })
    // The preview is exactly what would be added: the section heading too.
    expect(d.text.split('\n').slice(0, 3)).toEqual([expect.stringMatching(/^## Asked for in App Guide \(\d{4}-\d\d-\d\d\)$/), '', '- **FF1 — Let Finance approve renewals (Medium). — TODO.**'])
    expect(d.text).toContain('`POST /api/v1/approvals/:instanceId/decide` in `apps/api/src/routes/approvals.ts:2`')
    expect(d.brief.split('\n')[0]).toBe('Do this on a new branch from main, in a new worktree.')
    expect(d.brief.split('\n')[1]).toMatch(/^First make sure task FF1 below is in FIX_TRACKER\.md/)
    expect(d.brief).toContain('it changes approvalStep')
    expect((await run('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('')
  }, 60_000)

  it('refuses to write a task with nothing to check it against', async () => {
    await expect(addDraftedTask(root, { ...input, criteria: [''] }, cache)).rejects.toThrow(/done when/)
  }, 60_000)

  it('writes only the preview the PM saw', async () => {
    await expect(addDraftedTask(root, { ...input, hash: 'not-the-preview' }, cache)).rejects.toThrow(/changed since you saw the preview/)
    expect((await run('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('')
  }, 60_000)

  it('won’t add it on someone’s branch — only Claude should, from the brief', async () => {
    await run('git', ['checkout', '-q', '-b', 'fix/other'], { cwd: root, env })
    try {
      const d = await draftTask(root, input, cache)
      expect(d.cantAdd).toMatch(/^Your checkout is on fix\/other, not main/)
      await expect(addDraftedTask(root, { ...input, hash: d.hash }, cache)).rejects.toThrow(/not main/)
    } finally {
      await run('git', ['checkout', '-q', 'main'], { cwd: root, env })
    }
  }, 60_000)

  it('adds it before the tracker’s log, and changes nothing else — through the same checks the app’s calls go through', async () => {
    // As the page sends it: JSON, through the main process's input check.
    const d = await draftTask(root, askInput(JSON.stringify({ ...input, severity: 'High' })), cache)
    expect(d.text).toContain('(High). — TODO.**')
    const r = await addDraftedTask(root, askInput(JSON.stringify({ ...input, severity: 'High', hash: d.hash })), cache)
    expect(r).toMatchObject({ id: 'FF1', file: 'FIX_TRACKER.md' })
    const tracker = await readFile(join(root, 'FIX_TRACKER.md'), 'utf8')
    expect(tracker).toContain(d.text)
    expect(tracker.indexOf('- **FF1 — Let Finance approve renewals (High). — TODO.**')).toBeLessThan(tracker.indexOf('## Run log'))
    expect((await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()).toBe('M FIX_TRACKER.md')
  }, 60_000)
})
