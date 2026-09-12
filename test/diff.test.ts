import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import type { Change } from '../src/model/report.js'
import { compare } from '../src/diff/compare.js'
import { rank, split, subject, summarise, TOP_BLOCK_LIMIT } from '../src/diff/rank.js'

const lib = (name: string, version = '1.0.0'): Fact =>
  ({ kind: 'library', name, version, direct: true, importers: ['src/a.ts'], where: { file: 'package.json', line: 1 } })
const route = (path: string, middleware: Fact extends never ? never : string[] = ['auth']): Fact =>
  ({ kind: 'route', method: 'POST', path, middleware, framework: 'express', where: { file: 'src/api.ts', line: 1 } })
const exp = (symbol: string): Fact =>
  ({ kind: 'export', module: 'src/a.ts', symbol, where: { file: 'src/a.ts', line: 1 } })

describe('compare', () => {
  it('reports nothing when nothing changed', () => {
    expect(compare([lib('a'), route('/x')], [route('/x'), lib('a')])).toEqual([])
  })

  it('separates added, removed and changed', () => {
    const changes = compare([lib('a'), lib('gone')], [lib('a', '2.0.0'), lib('new')])
    expect(changes.filter((c) => c.type === 'added').map((c) => subject(c.fact))).toEqual(['new'])
    expect(changes.filter((c) => c.type === 'removed').map((c) => subject(c.fact))).toEqual(['gone'])
    expect(changes.filter((c) => c.type === 'changed').map((c) => subject(c.fact))).toEqual(['a'])
  })

  it('does not report a fact that only moved', () => {
    const before = [route('/x')]
    const after: Fact[] = [{ ...route('/x'), where: { file: 'src/moved.ts', line: 400 } }]
    expect(compare(before, after)).toEqual([])
  })

  it('reports losing middleware as a change, not a new route', () => {
    const changes = compare([route('/x')], [route('/x', [])])
    expect(changes).toHaveLength(1)
    expect(changes[0]!.type).toBe('changed')
  })
})

describe('rank', () => {
  it('puts boundary facts before interior ones', () => {
    const ranked = rank(compare([], [exp('helper'), lib('zod'), route('/x')]))
    expect(ranked.map((c) => c.fact.kind)).toEqual(['route', 'library', 'export'])
  })

  it('puts rarer properties first', () => {
    const common: Change = { type: 'added', fact: route('/a'), denominator: { property: 'x', matching: 20, total: 48, noun: 'routes' } }
    const rare: Change = { type: 'added', fact: route('/b'), denominator: { property: 'x', matching: 1, total: 48, noun: 'routes' } }
    expect(rank([common, rare])[0]).toBe(rare)
  })
})

describe('the top-block invariant', () => {
  it('refuses to promote a change with no denominator', () => {
    const { top, also } = split(rank(compare([], [route('/x'), lib('zod')])))
    expect(top).toEqual([])
    expect(also).toHaveLength(2)
  })

  it('promotes only added facts that carry a denominator', () => {
    const withNumber: Change = { type: 'added', fact: route('/a'), denominator: { property: 'no middleware', matching: 1, total: 48, noun: 'routes' } }
    const without: Change = { type: 'added', fact: route('/b') }
    const { top, also } = split(rank([withNumber, without]))
    expect(top).toEqual([withNumber])
    expect(also).toEqual([without])
  })

  it('never exceeds the cap, however many qualify', () => {
    const many: Change[] = Array.from({ length: 9 }, (_, i) => ({
      type: 'added' as const,
      fact: route(`/r${i}`),
      denominator: { property: 'no middleware', matching: 1, total: 48, noun: 'routes' },
    }))
    const { top, also } = split(rank(many))
    expect(top).toHaveLength(TOP_BLOCK_LIMIT)
    expect(also).toHaveLength(9 - TOP_BLOCK_LIMIT)
  })
})

describe('summary', () => {
  it('says so plainly when nothing happened', () => {
    expect(summarise([])).toBe('nothing new to the shape')
  })
  it('names a single dependency', () => {
    expect(summarise(compare([], [lib('zod')]))).toBe('Your agent pulled in zod.')
  })
  it('counts several rather than listing them', () => {
    expect(summarise(compare([], [lib('a'), lib('b'), lib('c')]))).toBe('Your agent pulled in 3 dependencies.')
  })
  it('calls out routes with no middleware', () => {
    const changes = compare([], [route('/a', []), route('/b')])
    expect(summarise(changes)).toBe('Your agent added 2 routes, one with no middleware.')
  })
  it('joins clauses in English', () => {
    const changes = compare([], [route('/a', []), lib('zod')])
    expect(summarise(changes)).toBe('Your agent added 1 route, one with no middleware, and pulled in zod.')
  })
})

describe('determinism', () => {
  it('ranks identically regardless of input order', () => {
    const facts: Fact[] = [exp('a'), lib('zod'), route('/x'), exp('b'), lib('ts-morph')]
    const forward = rank(compare([], facts)).map((c) => subject(c.fact))
    const backward = rank(compare([], [...facts].reverse())).map((c) => subject(c.fact))
    expect(forward).toEqual(backward)
  })

  it('sinks changes with no denominator below those that have one', () => {
    const without: Change = { type: 'added', fact: route('/a') }
    const with_: Change = { type: 'added', fact: route('/b'), denominator: { property: 'x', matching: 40, total: 48, noun: 'routes' } }
    expect(rank([without, with_])[0]).toBe(with_)
  })
})

describe('ranking within routes', () => {
  it('puts a route that accepts writes above one that only serves reads', () => {
    const base = { middleware: [] as string[], framework: 'express', where: { file: 'a.ts', line: 1 } }
    const get: Change = { type: 'added', fact: { kind: 'route', method: 'GET', path: '/a', ...base }, denominator: { property: 'no middleware', matching: 2, total: 4, noun: 'routes' } }
    const del: Change = { type: 'added', fact: { kind: 'route', method: 'DELETE', path: '/z', ...base }, denominator: { property: 'no middleware', matching: 2, total: 4, noun: 'routes' } }
    expect(rank([get, del])[0]).toBe(del)
  })
})

