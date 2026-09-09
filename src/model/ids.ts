import type { Fact } from './facts.js'
import { stableStringify } from './json.js'

/**
 * A fact's id is derived from its identity fields only — never from position,
 * never from a value that legitimately changes without the fact becoming a
 * different fact.
 *
 * A library's version is deliberately excluded: bumping a version changes a
 * fact, it does not add one. Same for a route's middleware and framework.
 */
export function factId(fact: Fact): string {
  switch (fact.kind) {
    case 'route':
      return `route:${fact.method.toUpperCase()}:${fact.path}`
    case 'library':
      return `library:${fact.name}`
    case 'external':
      return `external:${fact.host}:${fact.via}`
    case 'write':
      return `write:${fact.table}:${fact.module}`
    case 'read':
      return `read:${fact.table}:${fact.module}`
    case 'export':
      return `export:${fact.module}:${fact.symbol}`
    case 'gap':
      return `gap:${fact.reason}:${fact.subject}`
  }
}

/** Fields that may change without the fact becoming a different fact. */
export function factPayload(fact: Fact): Record<string, unknown> {
  switch (fact.kind) {
    case 'route':
      return { middleware: fact.middleware, framework: fact.framework, where: fact.where }
    case 'library':
      // `importers` is provenance in exactly the sense `where` is: renaming a
      // file that imports a package must not report the package as changed.
      return { version: fact.version, direct: fact.direct, imported: fact.importers.length > 0, where: fact.where }
    case 'external':
      return { where: fact.where }
    case 'write':
    case 'read':
      return { where: fact.where }
    case 'export':
      return { where: fact.where }
    case 'gap':
      return { detail: fact.detail, where: fact.where }
  }
}

/**
 * Two facts with the same id are "changed" rather than added/removed when their
 * payloads differ. `where` is excluded — a function moving down a file is not a
 * change worth reporting.
 */
export function payloadDigest(fact: Fact): string {
  const { where: _where, ...rest } = factPayload(fact) as { where?: unknown }
  return stableStringify(rest)
}
