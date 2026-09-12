import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import { scanRoutes } from '../src/extract/routes/index.js'
import { urlFor } from '../src/extract/routes/next.js'
import { normalise } from '../src/extract/routes/express.js'
import { parseAll } from '../src/extract/parse.js'

const scan = (files: Record<string, string>, packages: string[]): Fact[] => {
  const { parsed, gaps } = parseAll(Object.entries(files).map(([path, text]) => ({ path, text })))
  return [...gaps, ...scanRoutes({ files: parsed, declared: new Set(packages) })]
}

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

describe("express — what real apps do (from Express's own examples)", () => {
  it('does not mistake app.get(setting) for a route', () => {
    // One-argument app.get reads a setting. `app.get('env')` became GET /env.
    const out = routes(scan({ 'src/a.js': "const app = express(); if (app.get('env') === 'test') {}; app.get('/real', h)" }, ['express']))
    expect(out.map((r) => r.kind === 'route' && r.path)).toEqual(['/real'])
  })

  it('reports routes registered with a computed method instead of staying silent', () => {
    const out = scan({ 'lib/boot.js': 'const app = express(); for (const [method, url] of pairs) app[method](url, handler)' }, ['express'])
    expect(routes(out)).toHaveLength(0)
    expect(gaps(out).map((g) => g.kind === 'gap' && g.reason)).toContain('dynamic-dispatch')
  })

  it('follows this inside a helper hung off the app', () => {
    const out = scan({ 'index.js': `
      var app = module.exports = express()
      app.resource = function (path, obj) {
        this.get('/health', obj.ok)
        this.get(path + '/:id', obj.show)
      }
    ` }, ['express'])
    expect(routes(out).map((r) => r.kind === 'route' && r.path)).toEqual(['/health'])
    expect(gaps(out).map((g) => g.kind === 'gap' && g.reason)).toContain('computed-route-path')
  })

  it('does not treat this.get in an unrelated class as a route', () => {
    expect(routes(scan({ 'src/cache.js': 'class Cache { read(k) { return this.get(k, fallback) } }' }, ['express']))).toHaveLength(0)
  })

  it('resolves a router mounted from another file with an inline require', () => {
    const out = routes(scan({
      'index.js': "const app = express(); app.use('/api/v1', require('./controllers/api_v1'))",
      'controllers/api_v1.js': "const r = express.Router(); r.get('/users', h); module.exports = r",
    }, ['express']))
    expect(out[0]).toMatchObject({ path: '/api/v1/users' })
    expect(out[0]).not.toHaveProperty('scope')
  })

  it('resolves a router mounted through a binding, including nesting', () => {
    const out = routes(scan({
      'app.ts': "import api from './api'; const app = express(); app.use('/api', api)",
      'api.ts': "import users from './users.js'; const router = Router(); router.use('/users', users); export default router",
      'users.ts': "const router = Router(); router.get('/:id', h); export default router",
    }, ['express']))
    expect(out.map((r) => r.kind === 'route' && r.path)).toContain('/api/users/:id')
  })
})

describe('express — router.route() chains, found silently missing in a real review', () => {
  it('reads each chained method as its own route, under the mounted prefix', () => {
    const out = routes(scan({
      'index.js': "const app = express(); app.use('/api/products', require('./routes/products'))",
      'routes/products.js': "const router = express.Router(); router.route('/:id').get(getProduct).put(protect, adminOnly, updateProduct); router.route('/:id/reviews').get(getReviews).post(addReview); module.exports = router",
    }, ['express']))
    expect(out.map((r) => r.kind === 'route' && `${r.method} ${r.path} ${JSON.stringify(r.middleware)}`).sort()).toEqual([
      'GET /api/products/:id []',
      'GET /api/products/:id/reviews []',
      'POST /api/products/:id/reviews []',
      'PUT /api/products/:id ["protect","adminOnly"]',
    ])
  })

  it('reads app.route() chains', () => {
    const out = routes(scan({ 'index.js': "const app = express(); app.route('/book').get(a).post(auth, b)" }, ['express']))
    expect(out.map((r) => r.kind === 'route' && `${r.method} ${r.path}`).sort()).toEqual(['GET /book', 'POST /book'])
  })

  it('reports a chain whose path is computed, instead of staying silent', () => {
    const out = scan({ 'index.js': "const app = express(); app.route(base + '/x').get(h)" }, ['express'])
    expect(routes(out)).toHaveLength(0)
    expect(gaps(out).map((g) => g.kind === 'gap' && g.reason)).toContain('computed-route-path')
  })
})

