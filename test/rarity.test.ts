import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import { withDenominators } from '../src/diff/rarity.js'
import { compare } from '../src/diff/compare.js'

const route = (path: string, mw: string[] | 'unresolved' = ['auth']): Fact =>
  ({ kind: 'route', method: 'GET', path, middleware: mw, framework: 'express', where: { file: 'a.ts', line: 1 } })
const write = (table: string, module: string): Fact =>
  ({ kind: 'write', table, module, where: { file: 'a.ts', line: 1 } })

describe('denominators', () => {
  it('flags an unauthenticated route when it is the exception', () => {
    const after = [route('/a'), route('/b'), route('/c'), route('/new', [])]
    const [d] = withDenominators(compare(after.slice(0, 3), after), after)
    expect(d?.denominator).toEqual({ property: 'no middleware', matching: 1, total: 4, noun: 'routes' })
  })

  it("says nothing when open routes are this codebase's norm", () => {
    // If half the routes are open, "no middleware" is not news, and saying so
    // every time is how a tool trains people to ignore it.
    const after = [route('/a', []), route('/b', []), route('/new', [])]
    const [d] = withDenominators(compare(after.slice(0, 2), after), after)
    expect(d?.denominator).toBeUndefined()
  })

  it('gives a routine authenticated route no denominator, so it cannot be promoted', () => {
    const after = [route('/a'), route('/b'), route('/new')]
    const [d] = withDenominators(compare(after.slice(0, 2), after), after)
    expect(d?.denominator).toBeUndefined()
  })

  it('flags a first-ever write from a module', () => {
    const after = [write('users', 'auth'), write('users', 'billing')]
    const [d] = withDenominators(compare([after[0]!], after), after)
    expect(d?.denominator).toMatchObject({ property: 'first write from billing', matching: 1, total: 2 })
  })

  it('extinguishes firstness by itself the second time round', () => {
    // No suppression list, no rules file: the fact already exists, so it is not
    // an addition and cannot be promoted again.
    const after = [write('users', 'auth'), write('users', 'billing')]
    expect(withDenominators(compare(after, after), after)).toHaveLength(0)
  })

  it('never attaches a denominator to a removal', () => {
    const before = [route('/a'), route('/b'), route('/gone', [])]
    const [d] = withDenominators(compare(before, before.slice(0, 2)), before.slice(0, 2))
    expect(d?.type).toBe('removed')
    expect(d?.denominator).toBeUndefined()
  })
})

describe('open writes are never excused by an open codebase', () => {
  const r = (method: string, path: string, mw: string[]): Fact =>
    ({ kind: 'route', method, path, middleware: mw, framework: 'express', where: { file: 'a.ts', line: 1 } })

  it('reports a new open DELETE even when most routes are open', () => {
    // Login and signup are open in every app. That made a new open admin
    // DELETE look like the norm, and it was buried below a Slack webhook.
    const before = [r('POST', '/register', []), r('POST', '/login', []), r('GET', '/products', []), r('GET', '/products/:id', []), r('PUT', '/products/:id', ['protect'])]
    const after = [...before, r('DELETE', '/admin/purge', [])]
    const [d] = withDenominators(compare(before, after), after)
    expect(d?.denominator).toMatchObject({ property: 'no middleware', matching: 5, total: 6 })
  })

  it('still stays quiet about a new open read in the same codebase', () => {
    const before = [r('POST', '/register', []), r('POST', '/login', []), r('GET', '/products', []), r('PUT', '/products/:id', ['protect'])]
    const after = [...before, r('GET', '/about', [])]
    const [d] = withDenominators(compare(before, after), after)
    expect(d?.denominator).toBeUndefined()
  })
})

