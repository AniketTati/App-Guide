/**
 * The contract every renderer consumes.
 *
 * Extraction and diffing must never know how anything is displayed. Terminal,
 * markdown and JSON are three renderers over this one type, and a visual
 * surface later is a fourth — not a rewrite. If rendering logic ever leaks
 * upstream of here, that boundary is gone and it does not come back.
 */
import type { Fact } from './facts.js'

export type ChangeType = 'added' | 'removed' | 'changed'

export interface Change {
  type: ChangeType
  fact: Fact
  /** Present on 'changed' — the fact as it was. */
  previous?: Fact
  /**
   * Why this ranked where it did, in the user's words: "1 of 48 routes".
   * A change without one of these can never reach the top block.
   */
  denominator?: Denominator
}

export interface Denominator {
  /** e.g. "no middleware" */
  property: string
  matching: number
  total: number
  /** e.g. "routes" */
  noun: string
}

export interface Report {
  /** One sentence of English. The only prose in the output. */
  summary: string
  /** At most 3. Every entry has a denominator. */
  top: readonly Change[]
  /** Everything else that changed. */
  also: readonly Change[]
  /** Scoped to what this session touched — never a global percentage. */
  gaps: readonly Fact[]
  /** For "appguide since --all (23)". */
  totalChanges: number
  session: { files: number; from?: string; to?: string }
}
