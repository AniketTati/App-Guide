import type { Fact } from '../../model/facts.js'
import type { RouteContext, RouteDetector } from './types.js'
import { express } from './express.js'
import { nextAppRouter } from './next.js'

export type { RouteDetector, RouteContext } from './types.js'

/** Registered detectors. Adding a framework is adding one entry here. */
export const DETECTORS: readonly RouteDetector[] = [nextAppRouter, express]

export function scanRoutes(ctx: RouteContext): Fact[] {
  const out: Fact[] = []
  for (const detector of DETECTORS) {
    // `declared` includes imported-but-undeclared packages, so a monorepo whose
    // root manifest names neither express nor next does not silently lose its
    // entire route surface.
    if (!detector.packages.some((p) => ctx.declared.has(p))) continue
    out.push(...detector.detect(ctx))
  }
  return out
}
