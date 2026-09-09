import type { Fact } from '../model/facts.js'
import type { Change, Denominator } from '../model/report.js'

/**
 * Severity is arithmetic, never adjective. The tool does not say a change is
 * dangerous; it says the change is the only one of its kind here, and lets the
 * shape of the codebase supply the alarm.
 *
 * A denominator is attached only when the property is genuinely unusual. A
 * routine addition gets none, and therefore cannot reach the top block — which
 * is how the receipt stays quiet enough to be read.
 */
export function withDenominators(changes: readonly Change[], all: readonly Fact[]): Change[] {
  // Only routes whose middleware is knowable. Next handlers and server actions
  // are always 'unresolved', so counting them in the denominator of a
  // middleware claim both understates the ratio and silently disables the
  // "this is the codebase's norm" suppression below.
  const resolvable = all.filter((f) => f.kind === 'route' && f.middleware !== 'unresolved')
  const bare = resolvable.filter((f) => f.kind === 'route' && f.middleware !== 'unresolved' && f.middleware.length === 0)
  const libs = all.filter((f) => f.kind === 'library')
  const externals = all.filter((f) => f.kind === 'external')
  const writers = new Map<string, number>()
  for (const f of all) if (f.kind === 'write') writers.set(f.table, (writers.get(f.table) ?? 0) + 1)

  return changes.map((change) => {
    const d = denominatorFor(change, { routes: resolvable.length, bare: bare.length, libs: libs.length, externals, writers })
    return d === null ? change : { ...change, denominator: d }
  })
}

interface Population {
  routes: number
  bare: number
  libs: number
  externals: readonly Fact[]
  writers: ReadonlyMap<string, number>
}

function denominatorFor(change: Change, pop: Population): Denominator | null {
  if (change.type !== 'added') return null
  const f = change.fact

  if (f.kind === 'route') {
    // Only interesting when it is the exception. If half the routes are open,
    // "no middleware" is this codebase's norm and saying so is noise.
    const open = f.middleware !== 'unresolved' && f.middleware.length === 0
    if (!open || pop.routes < 2 || pop.bare / pop.routes > 0.5) return null
    return { property: 'no middleware', matching: pop.bare, total: pop.routes, noun: 'routes' }
  }

  if (f.kind === 'write') {
    // Every added write fact is by construction the first from that module —
    // which is why firstness self-extinguishes: the second time round the fact
    // already exists and is not an addition at all.
    //
    // But "1 of 1 modules write X" says nothing: a brand new table written by
    // one module is not a boundary being crossed. Only claim it when there is
    // an established set to be the exception to.
    const total = pop.writers.get(f.table) ?? 1
    if (total < 2) return null
    return { property: `first write from ${f.module}`, matching: 1, total, noun: `modules write ${f.table}` }
  }

  if (f.kind === 'library' && f.direct) {
    if (pop.libs < 2) return null
    return { property: 'new dependency', matching: 1, total: pop.libs, noun: 'dependencies' }
  }

  if (f.kind === 'external') {
    // Same reasoning: "1 of 1 external calls" is a vacuous ratio.
    if (pop.externals.length < 2) return null
    const sameHost = pop.externals.filter((e) => e.kind === 'external' && e.host === f.host).length
    return { property: 'new outbound call', matching: sameHost, total: pop.externals.length, noun: 'external calls' }
  }

  return null
}
