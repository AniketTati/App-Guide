import { describe, expect, it } from 'vitest'
import { parseTasks, taskIdsOf, WAITING } from '../src/tracker/tasks.js'

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

describe('what a task names', () => {
  it('keeps the file names a task mentions without a path, and its text', () => {
    const [task] = parseTasks('FIX_TRACKER.md', `- **EE1 — Every action in the review drawer is a decision. — DONE.**
    - \`FocusedReviewDrawer.tsx\` now records a decision; \`review-queue.ts\` keeps the order.
    - Tested in review-decision.integration.test.ts.
`)
    expect(task!.mentions).toEqual(['FocusedReviewDrawer.tsx', 'review-decision.integration.test.ts', 'review-queue.ts'])
    expect(task!.text.split('\n')[0]).toBe('- `FocusedReviewDrawer.tsx` now records a decision; `review-queue.ts` keeps the order.')
  })
})

describe('the shapes a long-running tracker grows into', () => {
  // Every shape below dropped a task before: 56 of one real tracker's 126
  // list entries, two of them waiting on the PM.
  const LATER = `# Tracker

## P1 — The export button does nothing

- **Status:** BLOCKED (waiting on the vendor)
- **Severity:** High (every customer)

## Third round

- **Q2 — Import keeps the old column order. — DONE** (VERIFY-PENDING → DONE after the live check below).
- **Q30 — \`export.csv\` drops the last row (Low). — VERIFY-PENDING.** Found in the Q3 review.
  - Check it on a file with a trailing newline.
- **Q35 — Two settings pages load slowly (Low-Medium; High once measured). — DONE.** Found while planning Q31.
- **Q54 — The weekly digest counts drafts (Medium). — BLOCKED (needs a decision).** Found while reading the digest.

## Closing summary

### What's left

- **VERIFY-PENDING:**
  - **Q30:** on a real export, the last row is there.
- **BLOCKED on your decision:** Q54. Leaving drafts out changes last month's numbers.
- **BLOCKED on the vendor:** P1.

### What to review first

- **Q35:** the settings pages.
`
  const tasks = parseTasks('TRACKER.md', LATER)
  const byId = new Map(tasks.map((t) => [t.id, t]))

  it('reads an entry whose bold is followed by more of it', () => {
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['P1', 'BLOCKED'], ['Q2', 'DONE'], ['Q30', 'VERIFY-PENDING'], ['Q35', 'DONE'], ['Q54', 'BLOCKED'],
    ])
    expect(byId.get('Q30')?.text).toMatch(/^Found in the Q3 review\.\n- Check it on a file/)
    expect(byId.get('Q2')?.text).toBe('(VERIFY-PENDING → DONE after the live check below).')
  })

  it('keeps the severity out of the title, and the reason after a status', () => {
    expect(byId.get('Q30')).toMatchObject({ title: '`export.csv` drops the last row', severity: 'Low' })
    expect(byId.get('Q35')?.severity).toBe('Low-Medium; High once measured')
    expect(byId.get('Q54')).toMatchObject({ severity: 'Medium', statusNote: 'needs a decision' })
    expect(byId.get('P1')).toMatchObject({ severity: 'High (every customer)', statusNote: 'waiting on the vendor' })
  })

  it("takes the latest word on a task from the tracker's own What's left", () => {
    expect(byId.get('Q30')?.latest).toBe('on a real export, the last row is there.')
    expect(byId.get('Q54')?.latest).toBe("Leaving drafts out changes last month's numbers.")
    // "What to review first" is not what's left.
    expect(byId.get('Q35')?.latest).toBeNull()
  })

  it("waits on the PM for exactly what the tracker's summary says is theirs", () => {
    const waiting = tasks.filter((t) => t.status !== null && WAITING.has(t.status)).map((t) => t.id).sort()
    expect(waiting).toEqual(['P1', 'Q30', 'Q54'])
  })
})

describe('titles that look like something else', () => {
  it('keeps a lower-case aside in the title, and bold inside a title', () => {
    const t = parseTasks('T.md', [
      '- **Q1 — Slow under load (high traffic). — TODO.**',
      '- **Q2 — Make **bold** labels readable. — DONE.** Found in review.',
      '- **Q3 — Fix export (Low, latent). — DONE.**',
    ].join('\n'))
    expect(t.map((x) => [x.id, x.title, x.status, x.severity])).toEqual([
      ['Q1', 'Slow under load (high traffic)', 'TODO', null],
      ['Q2', 'Make **bold** labels readable', 'DONE', null],
      ['Q3', 'Fix export', 'DONE', 'Low, latent'],
    ])
    expect(t[1]!.text).toBe('Found in review.')
  })
})
