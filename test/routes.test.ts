import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import { scanRoutes } from '../src/extract/routes/index.js'
import { urlFor } from '../src/extract/routes/next.js'
import { normalise } from '../src/extract/routes/express.js'

const scan = (files: Record<string, string>, packages: string[]): Fact[] =>
  scanRoutes({
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    declared: new Set(packages),
  })

const routes = (fs: Fact[]) => fs.filter((f) => f.kind === 'route')
const gaps = (fs: Fact[]) => fs.filter((f) => f.kind === 'gap')

describe('express', () => {
  it('finds routes with their middleware chain, in order', () => {
    const out = routes(scan({ 'src/api.ts': `
      app.get('/api/usage', requireAuth, billingGuard, handler)
      app.post('/api/refund', handler)
    ` }, ['express']))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ method: 'GET', path: '/api/usage', middleware: ['requireAuth', 'billingGuard'] })
    expect(out[1]).toMatchObject({ method: 'POST', path: '/api/refund', middleware: [] })
  })

  it('resolves a mounted prefix', () => {
    const out = routes(scan({ 'src/api.ts': `
      const router = express.Router()
      router.get('/users', handler)
      app.use('/api/v2', router)
    ` }, ['express']))
    expect(out[0]).toMatchObject({ path: '/api/v2/users' })
  })

  it('marks an unresolvable chain rather than calling it empty', () => {
    // A blank middleware cell reads as "no middleware", which is a lie when we
    // simply could not follow the chain. This is the difference between the
    // tool's most valuable finding and its most damaging false negative.
    const out = routes(scan({ 'src/api.ts': `app.get('/x', ...buildChain(), handler)` }, ['express']))
    expect(out[0]).toMatchObject({ middleware: 'unresolved' })
  })

  it('reports a computed path as a gap instead of guessing', () => {
    const out = scan({ 'src/api.ts': "app.get(`/api/${version}/x`, handler)" }, ['express'])
    expect(routes(out)).toHaveLength(0)
    expect(gaps(out)[0]).toMatchObject({ reason: 'computed-route-path' })
  })

  it('finds nothing when express is not a dependency', () => {
    expect(scan({ 'src/api.ts': "app.get('/x', handler)" }, [])).toHaveLength(0)
  })

  it('normalises duplicate and trailing slashes', () => {
    expect(normalise('//api//users/')).toBe('/api/users')
    expect(normalise('/')).toBe('/')
  })
})

describe('next app router', () => {
  it('derives the url from the file path', () => {
    expect(urlFor('app/api/users/[id]/route.ts')).toBe('/api/users/[id]')
    expect(urlFor('src/app/(marketing)/pricing/route.ts')).toBe('/pricing')
    expect(urlFor('src/lib/route.ts')).toBeNull()
  })

  it('finds exported HTTP handlers', () => {
    const out = routes(scan({ 'app/api/users/route.ts': `
      export async function GET() {}
      export const POST = handler
      export function notAMethod() {}
    ` }, ['next']))
    expect(out.map((r) => r.kind === 'route' && r.method).sort()).toEqual(['GET', 'POST'])
    expect(out[0]).toMatchObject({ middleware: 'unresolved' })
  })

  it('finds server actions, which have no url to grep for', () => {
    const out = routes(scan({ 'app/actions.ts': `
      'use server'
      export async function deleteAccount(id: string) {}
      export async function exportData() {}
    ` }, ['next']))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ method: 'ACTION', framework: 'next-server-action', path: 'app/actions.ts#deleteAccount' })
  })

  it('finds a function-level use server directive', () => {
    const out = routes(scan({ 'app/x.ts': `
      export async function act() { 'use server'; }
      export async function notAnAction() {}
    ` }, ['next']))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: 'app/x.ts#act' })
  })
})

describe('supported frameworks are not also declared blind spots', () => {
  it('does not claim express is unreadable', async () => {
    const { scanLibraries } = await import('../src/extract/libraries.js')
    const facts = (await scanLibraries(process.cwd())).facts
    expect(facts.filter((f) => f.kind === 'gap' && f.reason === 'unsupported-framework' && (f.subject === 'express' || f.subject === 'next'))).toHaveLength(0)
  })
})
