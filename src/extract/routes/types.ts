import type { Fact } from '../../model/facts.js'
import type { ParsedFile } from '../parse.js'

export interface RouteContext {
  files: readonly ParsedFile[]
  /** Declared packages, so a detector can tell whether its framework is here. */
  declared: ReadonlySet<string>
}

/**
 * A documented plugin shape from day one. If someone hits an empty route list
 * on their stack and cannot add forty lines to fix it, they close the tab.
 */
export interface RouteDetector {
  name: string
  /** Packages whose presence means this framework is in play. */
  packages: readonly string[]
  detect(ctx: RouteContext): Fact[]
}
