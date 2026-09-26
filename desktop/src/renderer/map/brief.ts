import type { CheckView, Note, ProductView } from '../../shared/api.js'
import { groupBehind } from './layout.js'

/**
 * What a batch of pinned notes becomes for Claude: each note with what the
 * map knows about the thing it's pinned to — its screen and file, what it
 * changes, and in a Check what this work did there — and what to do with
 * them. On main they are new work; on a piece of work, changes to it.
 */
export function notesBrief(notes: readonly Note[], ctx: { product: string; base: string; view: ProductView; check: CheckView | null; date: string }): string {
  const main = ctx.base.replace(/^origin\//, '')
  const lines: string[] = []
  const w = ctx.check?.work
  if (w != null) {
    lines.push(`I checked "${w.label}"${w.branch !== null ? ` (${w.branch})` : ''} in App Guide, on a map of ${ctx.product} as this work leaves it. My notes, each on the part of the product it's about:`, '')
  } else {
    lines.push(`Here is what I'd like changed in ${ctx.product}, noted on App Guide's map of the product as it is on ${main}:`, '')
  }
  notes.forEach((n, i) => {
    lines.push(`${i + 1}. ${about(n, ctx.view, ctx.check)}`)
    for (const t of n.text.split('\n')) lines.push(`   > ${t}`)
    lines.push('')
  })
  if (w != null) {
    lines.push(`Make these changes on ${w.branch ?? 'this work’s branch'}, where the work already is. Then tell me what you changed for each note, and how you checked it.`)
  } else {
    lines.push(`Add each note to FIX_TRACKER.md as its own task first — under a section headed "## Asked for in App Guide (${ctx.date})", in a new ID family, with a "Done when" you propose — and commit that on its own. Then work them one at a time, each on a new branch from ${main}. If a note is unclear, ask me before you start it.`)
  }
  return lines.join('\n')
}

/** What a note is pinned to, in words, with the facts that locate it. */
function about(n: Note, view: ProductView, check: CheckView | null): string {
  const k = n.target
  if (k.kind === 'screen') {
    const s = view.groups.flatMap((g) => g.screens).find((x) => x.path === k.key)
    const changed = check?.screens.changed.find((x) => x.path === k.key)
    const writes = [...new Set(s?.routes.flatMap((r) => r.data.filter((d) => d.kind === 'write').map((d) => d.table)) ?? [])]
    return `The ${k.label} screen (${k.key}${s?.file != null ? `, ${s.file}` : ''})${s !== undefined ? ` — it can do ${s.routes.length} thing${s.routes.length === 1 ? '' : 's'}${writes.length > 0 ? `, and changes ${writes.slice(0, 6).join(', ')}` : ''}` : ''}${changed !== undefined ? `. This work changed ${changed.how === 'page' ? 'its page' : 'code it runs'}` : ''}.`
  }
  if (k.kind === 'table') {
    const from = view.groups.flatMap((g) => g.screens).filter((s) => s.routes.some((r) => r.data.some((d) => d.table === k.key && d.kind === 'write'))).map((s) => s.name)
    const isNew = check?.schema.tables.added.some((t) => t.toLowerCase() === k.key.toLowerCase()) === true
    return `The ${k.key} data${from.length > 0 ? ` — changed from ${from.slice(0, 6).join(', ')}` : ''}${isNew ? '. This work adds it' : ''}.`
  }
  if (k.kind === 'part') {
    const part = view.shared.find((p) => p.file === k.key)
    return `${k.label} (${k.key}), a part used on ${part?.screens.join(', ') ?? 'several screens'}.`
  }
  if (k.kind === 'group' && k.key === 'layout') return 'What surrounds every signed-in screen — the layout, onboarding and the assistant.'
  if (k.kind === 'group' && k.key.startsWith('behind:')) {
    const name = k.key.slice('behind:'.length)
    const routes = groupBehind(view.behind).get(name) ?? []
    return `The "${name}" routes no screen calls (${routes.length}: ${routes.slice(0, 4).map((r) => `${r.method} ${r.path}`).join(', ')}${routes.length > 4 ? ', …' : ''}).`
  }
  if (k.kind === 'job') return k.key === 'always' ? 'What runs all the time: timers and live connections.' : `The ${k.key} queue — work done later, away from any screen.`
  if (k.kind === 'role') {
    const changes = check?.roleChanges.filter((c) => c.role === k.key) ?? []
    return `What ${k.key} may do${changes.length > 0 ? ` — this work changes it: ${changes.map((c) => `${c.resource}: ${c.before} → ${c.after}`).join('; ')}` : ''}.`
  }
  return `${k.label}.`
}
