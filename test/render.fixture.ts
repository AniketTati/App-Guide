import type { Fact } from '../src/model/facts.js'
import type { Change, Report } from '../src/model/report.js'
import { toReport } from '../src/diff/rank.js'

const w = (file: string, line: number) => ({ file, line })

export const alarming = (): Report => {
  const changes: Change[] = [
    { type: 'added',
      fact: { kind: 'route', method: 'POST', path: '/api/admin/reset-usage', middleware: [], framework: 'express', where: w('src/api/admin.ts', 14) },
      denominator: { property: 'no middleware', matching: 1, total: 48, noun: 'routes' } },
    { type: 'added',
      fact: { kind: 'write', table: 'users', module: 'billing/usage.ts', where: w('src/billing/usage.ts', 112) },
      denominator: { property: 'first write from billing/', matching: 1, total: 4, noun: 'writers' } },
    { type: 'added',
      fact: { kind: 'library', name: 'node-fetch', version: '2.6.7', direct: true, importers: ['src/lib/webhook.ts'], where: w('src/lib/webhook.ts', 8) },
      denominator: { property: 'first new direct dep', matching: 1, total: 34, noun: 'dependencies' } },
    { type: 'added', fact: { kind: 'route', method: 'GET', path: '/api/usage', middleware: ['requireAuth', 'billingGuard'], framework: 'express', where: w('src/api/usage.ts', 8) } },
    { type: 'added', fact: { kind: 'route', method: 'GET', path: '/api/usage/:id', middleware: ['requireAuth', 'billingGuard'], framework: 'express', where: w('src/api/usage.ts', 19) } },
    { type: 'changed', fact: { kind: 'export', module: 'src/billing/index.ts', symbol: 'computeSeats', where: w('src/billing/index.ts', 41) } },
  ]
  const gaps: Fact[] = [
    { kind: 'gap', reason: 'parse-error', subject: 'src/handlers/registry.ts', detail: 'could not be scanned', where: w('src/handlers/registry.ts', 1) },
    { kind: 'gap', reason: 'computed-route-path', subject: 'src/api/dynamic.ts', detail: 'path built at runtime', where: w('src/api/dynamic.ts', 22) },
  ]
  return { ...toReport(changes, gaps, { files: 31 }), totalChanges: 23 }
}

export const routine = (): Report => toReport(
  [{ type: 'added', fact: { kind: 'route', method: 'GET', path: '/api/usage/summary', middleware: ['requireAuth', 'billingGuard'], framework: 'express', where: w('src/api/usage.ts', 31) } }],
  [], { files: 6 },
)

export const allClear = (): Report => toReport([], [], { files: 6 })

export const unsupported = (): Report => toReport([], [
  { kind: 'gap', reason: 'unsupported-framework', subject: 'hono', detail: 'no extractor — routes from hono are not listed', where: w('package.json', 1) },
], { files: 84 })
