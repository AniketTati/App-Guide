import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addTask, digest, formatTask, insertTask, nextFamily, problemWith, shapeOf, suggestId } from '../src/tracker/draft.js'
import { parseTasks } from '../src/tracker/tasks.js'

const TRACKER = `# Fix Tracker

## S1 — First

- **Status:** DONE

## Redline review actions (2026-09-26, afternoon)

- **EE1 — Every action is a decision. — DONE.**
  - Reported: the stack never shrank.

## Run log

- 2026-09-26: EE1 merged.

## Closing summary (2026-09-23)

- done
`

const draft = { id: 'FF1', title: 'Let finance approve renewals', why: 'Renewals wait on legal today.', evidence: ['`POST /api/v1/approvals/:instanceId/decide` in `apps/api/src/routes/approvals.ts:307`'], criteria: ['Someone with FINANCE can approve a renewal.', ''], severity: 'Medium' }
const tasks = parseTasks('FIX_TRACKER.md', TRACKER)
const used = new Set(tasks.map((t) => t.id))

describe('a task drafted for the tracker', () => {
  it('starts a family of its own after the newest one, so a new ask is not filed under old work', () => {
    expect(suggestId(tasks, 'FIX_TRACKER.md', TRACKER, '2026-09-26', used)).toBe('FF1')
    // A branch already using FF moves it on.
    expect(suggestId(tasks, 'FIX_TRACKER.md', TRACKER, '2026-09-26', new Set([...used, 'FF3']))).toBe('GG1')
    expect([nextFamily('EE'), nextFamily('X'), nextFamily('Z'), nextFamily('TC')]).toEqual(['FF', 'Y', 'AA', 'TD'])
  })

  it('keeps today’s section in one family', () => {
    const once = insertTask(TRACKER, formatTask(draft, 'list'), '2026-09-26').text
    const again = parseTasks('FIX_TRACKER.md', once)
    expect(suggestId(again, 'FIX_TRACKER.md', once, '2026-09-26', new Set(again.map((t) => t.id)))).toBe('FF2')
  })

  it('is written the way the tracker’s newest entries are, and reads back as the same task', () => {
    expect(shapeOf(tasks, 'FIX_TRACKER.md', TRACKER)).toBe('list')
    const text = formatTask(draft, 'list')
    expect(text.split('\n')[0]).toBe('- **FF1 — Let finance approve renewals (Medium). — TODO.**')
    const [back] = parseTasks('FIX_TRACKER.md', text)
    expect(back).toMatchObject({ id: 'FF1', status: 'TODO', severity: 'Medium', title: 'Let finance approve renewals', criteria: ['Someone with FINANCE can approve a renewal.'] })
    expect(back!.cites).toEqual(['apps/api/src/routes/approvals.ts'])
  })

  it('uses the field template in a tracker written that way', () => {
    const fields = '# T\n\n## S1 — First\n\n- **Status:** TODO\n'
    expect(shapeOf(parseTasks('T.md', fields), 'T.md', fields)).toBe('heading')
    const [back] = parseTasks('T.md', formatTask({ ...draft, id: 'S2' }, 'heading'))
    expect(back).toMatchObject({ id: 'S2', status: 'TODO', severity: 'Medium', criteria: ['Someone with FINANCE can approve a renewal.'] })
  })

  it('goes into a dated section before the log and summary a tracker keeps last — and the preview is exactly what is added', () => {
    const { text, block } = insertTask(TRACKER, formatTask(draft, 'list'), '2026-09-26')
    const headings = text.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual(['## S1 — First', '## Redline review actions (2026-09-26, afternoon)', '## Asked for in App Guide (2026-09-26)', '## Run log', '## Closing summary (2026-09-23)'])
    expect(parseTasks('FIX_TRACKER.md', text).map((t) => [t.id, t.status])).toEqual([['S1', 'DONE'], ['EE1', 'DONE'], ['FF1', 'TODO']])
    expect(block.split('\n')[0]).toBe('## Asked for in App Guide (2026-09-26)')
    expect(text).toContain(block)
  })

  it('adds the next one to the same day’s section', () => {
    const once = insertTask(TRACKER, formatTask(draft, 'list'), '2026-09-26').text
    const twice = insertTask(once, formatTask({ ...draft, id: 'FF2', title: 'Second' }, 'list'), '2026-09-26')
    expect(twice.text.match(/## Asked for in App Guide/g)).toHaveLength(1)
    expect(twice.block.startsWith('- **FF2')).toBe(true)
    expect(parseTasks('FIX_TRACKER.md', twice.text).map((t) => t.id)).toEqual(['S1', 'EE1', 'FF1', 'FF2'])
  })

  it('says what is missing before anything is written', () => {
    expect(problemWith({ ...draft, id: 'EE1' }, used)).toBe('EE1 is already a task — in your tracker or on a branch.')
    expect(problemWith({ ...draft, criteria: [''] }, used)).toMatch(/done when/)
    expect(problemWith(draft, used)).toBeNull()
  })

  it('writes only over the file the PM saw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appguide-draft-'))
    await writeFile(join(dir, 'FIX_TRACKER.md'), TRACKER)
    await expect(addTask(dir, 'FIX_TRACKER.md', formatTask(draft, 'list'), '2026-09-26', digest('something else'))).rejects.toThrow(/changed since you saw/)
    expect(await readFile(join(dir, 'FIX_TRACKER.md'), 'utf8')).toBe(TRACKER)
    await addTask(dir, 'FIX_TRACKER.md', formatTask(draft, 'list'), '2026-09-26', digest(TRACKER))
    expect(await readFile(join(dir, 'FIX_TRACKER.md'), 'utf8')).toContain('- **FF1 — Let finance approve renewals (Medium). — TODO.**')
  })
})
