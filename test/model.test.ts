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
      // The cases that used to corrupt: a colon in a value that is not a route path.
      { kind: 'external', host: 'localhost:3000', via: 'fetch', where: { file: 'src/dev.ts', line: 3 } },
      { kind: 'export', module: 'src/a:b.ts', symbol: 'go', where: { file: 'src/a:b.ts', line: 9 } },
      { kind: 'write', table: 'users', module: 'src/billing/日本語.ts', where: { file: 'src/billing/日本語.ts', line: 4 } },
    ] satisfies Fact[],
  }

  const ok = (text: string) => {
    const r = parse(text)
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`)
    return r.snapshot
  }

  const byId = (fs: readonly Fact[]) => [...fs].sort((a, b) => (factId(a) < factId(b) ? -1 : 1))

  it('round-trips every field exactly, provenance included', () => {
    // where/file/line must survive: an earlier serialiser used JSON.stringify's
    // array replacer, which is a recursive allow-list, and silently deleted
    // every nested object.
    expect(byId(ok(serialise(snap)).facts)).toEqual(byId(snap.facts))
  })

  it('preserves a colon in a value that is not a route path', () => {
    const back = ok(serialise(snap)).facts
    expect(back.find((f) => f.kind === 'external')).toMatchObject({ host: 'localhost:3000', via: 'fetch' })
    expect(back.find((f) => f.kind === 'export')).toMatchObject({ module: 'src/a:b.ts', symbol: 'go' })
  })

  it('is byte-identical when nothing changed', () => {
    expect(serialise(snap)).toBe(serialise({ ...snap, facts: [...snap.facts].reverse() }))
  })

  it('refuses a snapshot from a different version rather than misreading it', () => {
    const r = parse(serialise(snap).replace('appguide-snapshot 2', 'appguide-snapshot 99'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wrong-version')
  })

  it('refuses a conflicted mark rather than merging both sides', () => {
    const conflicted = serialise(snap).replace('# taken', '<<<<<<< HEAD\n# taken')
    const r = parse(conflicted)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('conflict')
  })

  it('refuses a truncated mark rather than reporting a phantom deletion', () => {
    const r = parse(`${serialise(snap).slice(0, -40)}`)
    expect(r.ok).toBe(false)
  })

  it('does not report a library as changed when an importing file is renamed', () => {
    const a: Fact = { kind: 'library', name: 'zod', version: '1.0.0', direct: true, importers: ['src/api/users.ts'], where: { file: 'package.json', line: 1 } }
    const b: Fact = { ...a, importers: ['src/api/user.ts'] }
    expect(payloadDigest(a)).toBe(payloadDigest(b))
  })
})
