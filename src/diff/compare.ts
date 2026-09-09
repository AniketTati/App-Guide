import type { Fact } from '../model/facts.js'
import { factId, payloadDigest } from '../model/ids.js'
import type { Change } from '../model/report.js'

/**
 * Two fact sets in, changes out. A pure set operation on ids — which is the
 * entire payoff of storing facts rather than a model: there is no anchor to
 * keep alive across a refactor, only an id to match.
 */
export function compare(before: readonly Fact[], after: readonly Fact[]): Change[] {
  const prior = new Map(before.map((f) => [factId(f), f]))
  const current = new Map(after.map((f) => [factId(f), f]))
  const changes: Change[] = []

  for (const [id, fact] of current) {
    const was = prior.get(id)
    if (was === undefined) {
      changes.push({ type: 'added', fact })
    } else if (payloadDigest(was) !== payloadDigest(fact)) {
      changes.push({ type: 'changed', fact, previous: was })
    }
  }
  for (const [id, fact] of prior) {
    if (!current.has(id)) changes.push({ type: 'removed', fact })
  }
  return changes
}
