import { describe, expect, it } from 'vitest'
import { formatTask, insertTask, problemWith, suggestId } from '../src/tracker/draft.js'
import { parseTasks } from '../src/tracker/tasks.js'

const TRACKER = `# Fix Tracker

## S1 — First

- **Status:** DONE

## Redline review actions (2026-09-26, afternoon)

- **EE1 — Every action is a decision. — DONE.**

## Run log

- 2026-09-26: EE1 merged.

## Closing summary (2026-09-23)

- done
`

const draft = { id: 'EE2', title: 'Let finance approve renewals', why: 'Renewals wait on legal today.', evidence: ['`POST /api/v1/approvals/:instanceId/decide` in `apps/api/src/routes/approvals.ts:307`'], criteria: ['Someone with FINANCE can approve a renewal.', ''] }

describe('a task drafted for the tracker', () => {
  const tasks = parseTasks('FIX_TRACKER.md', TRACKER)

  it('suggests the next ID in the family used last', () => {
    expect(suggestId(tasks, 'FIX_TRACKER.md')).toBe('EE2')
  })

  it('is written in the tracker’s own field order, and reads back as the same task', () => {
    const text = formatTask(draft)
    expect(text.split('\n').slice(0, 3)).toEqual(['### EE2 — Let finance approve renewals', '', '- **Status:** TODO'])
    const [back] = parseTasks('FIX_TRACKER.md', text)
    expect(back).toMatchObject({ id: 'EE2', status: 'TODO', criteria: ['Someone with FINANCE can approve a renewal.'] })
    expect(back!.cites).toEqual(['apps/api/src/routes/approvals.ts'])
  })

  it('goes into a dated section before the log and summary a tracker keeps last', () => {
    const { text } = insertTask(TRACKER, formatTask(draft), '2026-09-26')
    const headings = text.split('\n').filter((l) => l.startsWith('## ') || l.startsWith('### '))
    expect(headings).toEqual(['## S1 — First', '## Redline review actions (2026-09-26, afternoon)', '## Asked for in App Guide (2026-09-26)', '### EE2 — Let finance approve renewals', '## Run log', '## Closing summary (2026-09-23)'])
    expect(parseTasks('FIX_TRACKER.md', text).map((t) => [t.id, t.status])).toEqual([['S1', 'DONE'], ['EE1', 'DONE'], ['EE2', 'TODO']])
  })

  it('adds the next one to the same day’s section', () => {
    const once = insertTask(TRACKER, formatTask(draft), '2026-09-26').text
    const twice = insertTask(once, formatTask({ ...draft, id: 'EE3', title: 'Second' }), '2026-09-26').text
    expect(twice.match(/## Asked for in App Guide/g)).toHaveLength(1)
    expect(parseTasks('FIX_TRACKER.md', twice).map((t) => t.id)).toEqual(['S1', 'EE1', 'EE2', 'EE3'])
  })

  it('says what is missing before anything is written', () => {
    expect(problemWith({ ...draft, id: 'EE1' }, tasks)).toBe('EE1 is already a task in your tracker.')
    expect(problemWith({ ...draft, criteria: [''] }, tasks)).toMatch(/done when/)
    expect(problemWith(draft, tasks)).toBeNull()
  })
})
