/**
 * A plan document read the way a tracker is: a register of items with a
 * status, the releases that group them and what "done" means for each, and
 * the notes on putting it live. Plans keep their items in tables —
 *
 *   | Release | Gaps | Done when |
 *   | **R0 · Data you can trust** | A2, A3, B1 | Re-analysis keeps every value people set |
 *
 *   | # | Gap | Pri | Rel | … | Status |
 *   | A1 | Extraction runs in memory | P1 | R1 | … | DONE 2026-09-26 — saved inside … |
 *
 * Read, never rewritten.
 */
export interface PlanItem { id: string; title: string; status: string | null; line: number }
export interface Release { name: string; short: string; items: string[]; doneWhen: string }

export interface Plan {
  file: string
  title: string
  items: PlanItem[]
  releases: Release[]
  /** The section on putting it live — deploy notes, rollout — as written. */
  golive: string | null
}

const ID = /^[A-Z]{1,3}\d{1,3}$/

export function readPlan(file: string, text: string): Plan {
  const lines = text.split('\n')
  const title = (/^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? file).replace(/[*_`]/g, '').replace(/^\d+\s*[—–:.-]\s*/, '')
  const items: PlanItem[] = []
  const releases: Release[] = []
  for (const table of tables(lines)) {
    const head = table.header.map((h) => h.replace(/[*_`]/g, '').trim().toLowerCase())
    const col = (...names: string[]): number => head.findIndex((h) => names.includes(h))
    const status = col('status', 'state')
    const id = col('#', 'id', 'task', 'gap id')
    const release = col('release', 'milestone', 'phase')
    const members = col('gaps', 'items', 'tasks', 'ids')
    const done = head.findIndex((h) => /^done when|^exit criteria|^acceptance/.test(h))
    if (id !== -1 && status !== -1) {
      const titleCol = head.findIndex((h, i) => i !== id && i !== status && !/^(pri|priority|rel|release|owner|size)$/.test(h))
      for (const row of table.rows) {
        const key = clean(row.cells[id] ?? '')
        if (!ID.test(key)) continue
        const word = /^([A-Z][A-Z-]{2,})\b/.exec(clean(row.cells[status] ?? ''))?.[1] ?? null
        items.push({ id: key, title: clean(row.cells[titleCol] ?? ''), status: word, line: row.line })
      }
    } else if (release !== -1 && members !== -1) {
      for (const row of table.rows) {
        const name = clean(row.cells[release] ?? '')
        if (name === '') continue
        releases.push({
          name,
          short: /^([A-Z]+\d+|Later|Next|Now)\b/i.exec(name)?.[1] ?? name,
          items: clean(row.cells[members] ?? '').split(/[,\s]+/).filter((x) => ID.test(x)),
          doneWhen: done === -1 ? '' : clean(row.cells[done] ?? ''),
        })
      }
    }
  }
  return { file, title, items, releases, golive: section(lines, /^#{2,3}\s+(deploy|rollout|going live|go-live|release notes|launch)\b/i) }
}

/** How far a plan has got, over all its items and per release. */
export function progress(plan: Plan): { done: number; partly: number; total: number; releases: (Release & { done: number; total: number })[] } {
  const status = new Map(plan.items.map((i) => [i.id, i.status]))
  const isDone = (id: string): boolean => /^(DONE|SHIPPED|VERIFIED|CLOSED)$/.test(status.get(id) ?? '')
  return {
    done: plan.items.filter((i) => isDone(i.id)).length,
    partly: plan.items.filter((i) => /^(PARTIAL|PARTLY|IN-PROGRESS|STARTED)$/.test(i.status ?? '')).length,
    total: plan.items.length,
    releases: plan.releases.map((r) => ({ ...r, done: r.items.filter(isDone).length, total: r.items.length })),
  }
}

interface Table { header: string[]; rows: { cells: string[]; line: number }[] }

function tables(lines: readonly string[]): Table[] {
  const out: Table[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i]!) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue
    const t: Table = { header: cells(lines[i]!), rows: [] }
    let j = i + 2
    for (; j < lines.length && isRow(lines[j]!); j++) t.rows.push({ cells: cells(lines[j]!), line: j + 1 })
    out.push(t)
    i = j - 1
  }
  return out
}

const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)

/** A table row's cells: split at pipes that aren't escaped or inside code. */
function cells(line: string): string[] {
  const out: string[] = []
  let cell = ''
  let code = false
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '`') code = !code
    if (c === '\\' && body[i + 1] === '|') { cell += '|'; i++; continue }
    if (c === '|' && !code) { out.push(cell.trim()); cell = ''; continue }
    cell += c
  }
  out.push(cell.trim())
  return out
}

const clean = (s: string): string => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** The text of the first section whose heading matches, to the next heading
 *  of the same or a higher level. */
function section(lines: readonly string[], heading: RegExp): string | null {
  const at = lines.findIndex((l) => heading.test(l))
  if (at === -1) return null
  const level = /^(#+)/.exec(lines[at]!)![1]!.length
  let end = at + 1
  while (end < lines.length && !(/^(#+)\s/.exec(lines[end]!) !== null && /^(#+)\s/.exec(lines[end]!)![1]!.length <= level)) end++
  const body = lines.slice(at + 1, end).join('\n').trim()
  return body === '' ? null : body
}
