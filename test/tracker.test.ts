import { describe, expect, it } from 'vitest'
import { parseTasks, taskIdsOf } from '../src/tracker/tasks.js'

const TRACKER = `# Fix Tracker

## Status values

| Status | Meaning |
|---|---|
| \`TODO\` | Not started |

## S2 — Agent tools ignore the \`own\` permission scope

- **Status:** VERIFY-PENDING
- **Severity:** Critical
- **Evidence:** \`apps/api/src/lib/permissions.ts:57-61\` gives SALES_REP own scope; see \`apps/api/src/routes/internal-ai.ts:700\`.
- **Acceptance criteria:**
  - The caller's scope is resolved server-side.
  - An integration test proves a SALES_REP cannot reach another user's contract.
- **Worklog:**
  - **Plan (confirmed defect):** every read route scopes by org only.
  - **Verified:** 7 fail before, 11 pass after.
  - **Why VERIFY-PENDING:** the Python path was not run end to end.

## C1 — API keys created in the UI have no scopes

- **Status:** DONE
- **Evidence:** \`apps/web/src/pages/settings/ApiKeys.tsx\`

---

## Later work

- **DD1 — Liability caps were reasoned about, not measured. — DONE.**
    - DD1 judged any limit "in months" from the cap.
- **DD5 — DD1 and DD2's own side effects. — DONE.**
- **EE1 — Every action in the review drawer is a decision. — IN-PROGRESS.**
`

describe("reading the PM's tracker", () => {
  const tasks = parseTasks('FIX_TRACKER.md', TRACKER)

  it('finds tasks in both of its shapes, with their status', () => {
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['S2', 'VERIFY-PENDING'], ['C1', 'DONE'], ['DD1', 'DONE'], ['DD5', 'DONE'], ['EE1', 'IN-PROGRESS'],
    ])
    expect(tasks.find((t) => t.id === 'DD1')?.title).toBe('Liability caps were reasoned about, not measured')
    expect(tasks.find((t) => t.id === 'S2')).toMatchObject({ file: 'FIX_TRACKER.md', line: 9 })
  })

  it('keeps the acceptance criteria and the worklog as written', () => {
    const s2 = tasks.find((t) => t.id === 'S2')!
    expect(s2.criteria).toHaveLength(2)
    expect(s2.worklog.map((w) => w.label)).toEqual(['Plan (confirmed defect)', 'Verified', 'Why VERIFY-PENDING'])
    expect(s2.fields['Severity']).toBe('Critical')
  })

  it('knows which files a task names, so a change outside them can be pointed out', () => {
    expect(tasks.find((t) => t.id === 'S2')?.cites).toEqual(['apps/api/src/lib/permissions.ts', 'apps/api/src/routes/internal-ai.ts'])
  })

  it('does not read a table or a plain section as a task', () => {
    expect(tasks.some((t) => /Status values|Later work/.test(t.title))).toBe(false)
  })
})

describe('task IDs in commit subjects', () => {
  it('reads the group a subject ends with, ranges expanded', () => {
    expect(taskIdsOf('Fix what a second pass over DD1-DD4 found (DD5-DD7)')).toEqual(['DD5', 'DD6', 'DD7'])
    expect(taskIdsOf('Say the true total (CC11-CC12)')).toEqual(['CC11', 'CC12'])
    expect(taskIdsOf('Keep a rejection as one (EE1)')).toEqual(['EE1'])
    expect(taskIdsOf('Two at once (Y1, Y3)')).toEqual(['Y1', 'Y3'])
  })

  it('ignores a subject that ends with anything else in brackets', () => {
    expect(taskIdsOf('Fix the flow the demo broke (and the portal)')).toEqual([])
    expect(taskIdsOf('Merge pull request #52 from AniketTati/fix/audit')).toEqual([])
    expect(taskIdsOf('Plan six recurring defect classes')).toEqual([])
  })
})
