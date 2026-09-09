import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import { factId, payloadDigest } from '../src/model/ids.js'
import { parse, serialise, SNAPSHOT_VERSION } from '../src/model/snapshot.js'

const route = (over: Partial<Extract<Fact, { kind: 'route' }>> = {}): Fact => ({
  kind: 'route',
  method: 'POST',
  path: '/api/invoices/:id/refund',
  middleware: ['requireAuth'],
  framework: 'express',
  where: { file: 'src/api/invoices.ts', line: 14 },
  ...over,
})

describe('fact identity', () => {
  it('ignores position, so a reformat is not a change', () => {
    expect(factId(route())).toBe(factId(route({ where: { file: 'src/api/invoices.ts', line: 220 } })))
  })

  it('ignores the file a route moved to', () => {
    expect(factId(route())).toBe(factId(route({ where: { file: 'src/routes/refund.ts', line: 3 } })))
  })

  it('normalises method case', () => {
    expect(factId(route({ method: 'post' }))).toBe(factId(route({ method: 'POST' })))
  })

  it('separates distinct facts', () => {
    expect(factId(route())).not.toBe(factId(route({ path: '/api/invoices/:id/void' })))
    expect(factId(route())).not.toBe(factId(route({ method: 'GET' })))
  })

  it('treats a library version bump as changed, not added', () => {
    const a: Fact = { kind: 'library', name: 'node-fetch', version: '2.6.7', direct: true, importers: ['src/a.ts'], where: { file: 'package.json', line: 1 } }
    const b: Fact = { ...a, version: '3.0.0' }
    expect(factId(a)).toBe(factId(b))
    expect(payloadDigest(a)).not.toBe(payloadDigest(b))
  })

  it('does not report a moved-but-identical fact as changed', () => {
    expect(payloadDigest(route())).toBe(payloadDigest(route({ where: { file: 'elsewhere.ts', line: 99 } })))
  })

  it('reports losing middleware as changed', () => {
    expect(payloadDigest(route())).not.toBe(payloadDigest(route({ middleware: [] })))
    expect(payloadDigest(route({ middleware: [] }))).not.toBe(payloadDigest(route({ middleware: 'unresolved' })))
  })

  it('is stable across importer ordering', () => {
    const a: Fact = { kind: 'library', name: 'ts-morph', version: '24.0.0', direct: true, importers: ['b.ts', 'a.ts'], where: { file: 'package.json', line: 1 } }
    const b: Fact = { ...a, importers: ['a.ts', 'b.ts'] }
    expect(payloadDigest(a)).toBe(payloadDigest(b))
  })
})

describe('snapshot', () => {
  const snap = {
    version: SNAPSHOT_VERSION,
    extractor: '0.0.0',
    takenAt: '2026-09-09T00:00:00Z',
    facts: [
      route(),
      { kind: 'library', name: '@scope/pkg', version: '1.0.0', direct: true, importers: ['src/a.ts'], where: { file: 'package.json', line: 1 } },
      { kind: 'gap', reason: 'unsupported-framework', subject: 'hono', detail: 'no extractor', where: { file: 'package.json', line: 1 } },
    ] satisfies Fact[],
  }

  it('round-trips losslessly by identity and payload', () => {
    const back = parse(serialise(snap))
    expect(back.facts.map(factId).sort()).toEqual(snap.facts.map(factId).sort())
    for (const fact of back.facts) {
      const original = snap.facts.find((f) => factId(f) === factId(fact))!
      expect(payloadDigest(fact)).toBe(payloadDigest(original))
    }
  })

  it('is byte-identical when nothing changed', () => {
    expect(serialise(snap)).toBe(serialise({ ...snap, facts: [...snap.facts].reverse() }))
  })

  it('survives colons in names', () => {
    const back = parse(serialise(snap))
    const lib = back.facts.find((f) => f.kind === 'library')
    expect(lib).toMatchObject({ name: '@scope/pkg' })
  })
})
