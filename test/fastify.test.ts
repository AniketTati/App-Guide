import { describe, expect, it } from 'vitest'
import { fastify } from '../src/extract/routes/fastify.js'
import { parseAll } from '../src/extract/parse.js'
import type { Fact } from '../src/model/facts.js'

/** Run the detector over in-memory files. */
function detect(files: Record<string, string>): Fact[] {
  const { parsed } = parseAll(Object.entries(files).map(([path, text]) => ({ path, text })))
  return fastify.detect({ files: parsed, declared: new Set(['fastify']) })
}
const routes = (facts: Fact[]) => facts.filter((f): f is Extract<Fact, { kind: 'route' }> => f.kind === 'route')
const find = (facts: Fact[], method: string, path: string) => routes(facts).find((r) => r.method === method && r.path === path)
const gaps = (facts: Fact[]) => facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')

/** The layout of a real 300-route API: an app that mounts route modules by
 *  named import with a prefix, and modules that guard each route. */
const api = {
  'src/app.ts': `
    import Fastify from 'fastify'
    import cors from '@fastify/cors'
    import rateLimit from '@fastify/rate-limit'
    import { contractRoutes } from './routes/contracts.js'
    import { threadRoutes } from './routes/threads.js'
    import { adminRoutes } from './routes/admin.js'
    import { healthRoutes } from './routes/health.js'
    export async function buildApp() {
      const app = Fastify({ logger: true })
      app.addHook('preHandler', tenantStore)
      await app.register(cors)
      await app.register(rateLimit as any, { max: 100 })
      await app.register(healthRoutes)
      await app.register(contractRoutes, { prefix: '/api/v1/contracts' })
      await app.register(threadRoutes, { prefix: '/api/v1/agent/threads' })
      await app.register(adminRoutes, { prefix: '/api/v1/admin' })
      await app.register(async (board) => {
        await board.register(bullBoard.registerPlugin(), { prefix: '/admin/queues' })
      })
      return app
    }`,
  'src/routes/contracts.ts': `
    import type { FastifyInstance } from 'fastify'
    export async function contractRoutes(app: FastifyInstance) {
      app.get('/', { preHandler: requirePermission('view', 'contract') }, async () => [])
      app.patch('/:id', { preHandler: [requireUser, requirePermission('edit', 'contract')] }, async () => ({}))
      app.delete('/:id', async () => ({}))
      app.route({ method: ['GET', 'HEAD'], url: '/:id/pdf', preHandler: requireUser, handler: async () => '' })
    }`,
  'src/routes/threads.ts': `
    export async function threadRoutes(app: FastifyInstance) {
      app.addHook('preHandler', requireUser)
      app.get('/', async () => [])
      app.post('/:id/messages', { preHandler: rateCheck }, async () => ({}))
    }`,
  'src/routes/admin.ts': `
    export async function adminRoutes(app: FastifyInstance) {
      const adminGuard = requirePermission('configure', 'user')
      const grantGuard = [requireUser, adminGuard]
      app.get('/users/:id', { preHandler: adminGuard }, async () => ({}))
      app.post('/users/invite', { preHandler: grantGuard }, async () => ({}))
      app.addHook('onRequest', async (req) => { if (!req.headers['x-admin']) throw new Error() })
    }`,
  'src/routes/health.ts': `
    export async function healthRoutes(app: FastifyInstance) {
      app.get('/health', async () => 'ok')
    }`,
  // A test registers routes too — at a prefix the app never uses.
  'src/routes/contracts.test.ts': `
    const app = Fastify()
    await app.register(contractRoutes, { prefix: '/test-only' })`,
}

describe('reading a Fastify API', () => {
  it('follows each module to the prefix it is mounted at', () => {
    const facts = detect(api)
    expect(routes(facts).map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/v1/contracts/:id',
      'GET /api/v1/admin/users/:id',
      'GET /api/v1/agent/threads',
      'GET /api/v1/contracts',
      'GET /api/v1/contracts/:id/pdf',
      'GET /health',
      'HEAD /api/v1/contracts/:id/pdf',
      'PATCH /api/v1/contracts/:id',
      'POST /api/v1/admin/users/invite',
      'POST /api/v1/agent/threads/:id/messages',
    ])
    expect(routes(facts).every((r) => r.framework === 'fastify' && r.scope === undefined)).toBe(true)
  })

  it('names the check before each route, as the code writes it', () => {
    const facts = detect(api)
    expect(find(facts, 'GET', '/api/v1/contracts')?.middleware).toEqual(["requirePermission('view', 'contract')"])
    expect(find(facts, 'PATCH', '/api/v1/contracts/:id')?.middleware).toEqual(['requireUser', "requirePermission('edit', 'contract')"])
    expect(find(facts, 'GET', '/api/v1/contracts/:id/pdf')?.middleware).toEqual(['requireUser'])
    // Nothing runs first — the app's own hooks run for every route, so they
    // cannot tell this one apart.
    expect(find(facts, 'DELETE', '/api/v1/contracts/:id')?.middleware).toEqual([])
  })

  it('applies a hook a module adds to every route inside it', () => {
    const facts = detect(api)
    expect(find(facts, 'GET', '/api/v1/agent/threads')?.middleware).toEqual(['requireUser'])
    expect(find(facts, 'POST', '/api/v1/agent/threads/:id/messages')?.middleware).toEqual(['requireUser', 'rateCheck'])
  })

  it('follows a check given a short name to what it stands for', () => {
    const facts = detect(api)
    expect(find(facts, 'GET', '/api/v1/admin/users/:id')?.middleware).toEqual(['inline onRequest', "requirePermission('configure', 'user')"])
    expect(find(facts, 'POST', '/api/v1/admin/users/invite')?.middleware).toEqual(['inline onRequest', 'requireUser', "requirePermission('configure', 'user')"])
  })

  it("says a library's own routes are not listed, and ignores plugins that add none", () => {
    const g = gaps(detect(api))
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ reason: 'dynamic-dispatch', detail: expect.stringContaining('under /admin/queues') })
  })

  it('never reads routes out of test files', () => {
    expect(routes(detect(api)).some((r) => r.path.startsWith('/test-only'))).toBe(false)
  })
})

describe('what it cannot know, it says', () => {
  it('scopes routes from a module nothing visible registers, with a gap', () => {
    const facts = detect({
      'src/orphan.ts': `export async function orphanRoutes(app: FastifyInstance) { app.get('/x', async () => 1) }`,
    })
    expect(find(facts, 'GET', '/x')).toMatchObject({ scope: 'src/orphan.ts' })
    expect(gaps(facts).map((g) => g.reason)).toEqual(['unresolved-route-prefix'])
  })

  it('reports a path or a method decided while the app runs', () => {
    const facts = detect({
      'src/app.ts': `
        import Fastify from 'fastify'
        const app = Fastify()
        app.get(base + '/x', async () => 1)
        for (const m of ['get', 'post']) app[m]('/y', async () => 1)`,
    })
    expect(routes(facts)).toEqual([])
    expect(gaps(facts).map((g) => g.reason).sort()).toEqual(['computed-route-path', 'dynamic-dispatch'])
  })

  it('treats fastify-plugin as sharing its parent, and a typed instance as the same one', () => {
    const facts = detect({
      'src/app.ts': `
        import Fastify from 'fastify'
        import fp from 'fastify-plugin'
        const app = Fastify()
        await app.register(fp(async (inner) => { inner.get('/shared', async () => 1) }), { prefix: '/ignored' })
        await app.register(async (scoped) => {
          const typed = scoped.withTypeProvider<Zod>()
          typed.post('/typed', { preHandler: requireUser }, async () => 1)
        }, { prefix: '/v2' })`,
    })
    expect(routes(facts).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /shared', 'POST /v2/typed'])
  })
})

describe('what counts as a check', () => {
  const app = (routes: string, extra: Record<string, string> = {}) => ({
    'src/app.ts': `
      import Fastify from 'fastify'
      import { routes } from './routes.js'
      const app = Fastify()
      await app.register(routes, { prefix: '/api' })`,
    'src/routes.ts': routes,
    ...extra,
  })

  it('counts a hook only if its code can refuse the request', () => {
    const facts = detect(app(`
      import { requireAuth } from './auth.js'
      import { track } from './telemetry.js'
      import jwt from '@fastify/jwt'
      export async function routes(app: FastifyInstance) {
        // Records, never refuses: not a check.
        app.addHook('preHandler', (req, _reply, done) => { if (req.url) track(done); else done() })
        app.get('/a', async () => 1)
        app.get('/b', { preHandler: requireAuth }, async () => 1)
        app.get('/c', { preHandler: logOnly }, async () => 1)
        app.get('/d', { preHandler: (req, reply, done) => done(new Error('no')) }, async () => 1)
        app.get('/e', { preHandler: jwt.verify }, async () => 1)
      }
      function logOnly(req) { console.log(req.url) }`, {
      'src/auth.ts': `export async function requireAuth(req, reply) { if (!req.user) return reply.status(401).send() }`,
      'src/telemetry.ts': `export function track(next) { store.run([], next) }`,
    }))
    expect(find(facts, 'GET', '/api/a')?.middleware).toEqual([])
    expect(find(facts, 'GET', '/api/b')?.middleware).toEqual(['requireAuth'])
    expect(find(facts, 'GET', '/api/c')?.middleware).toEqual([])
    expect(find(facts, 'GET', '/api/d')?.middleware).toEqual(['inline preHandler'])
    // A check we cannot read into still counts — dropping it would claim
    // "no check found" about code we never saw.
    expect(find(facts, 'GET', '/api/e')?.middleware).toEqual(['jwt.verify'])
  })

  it('adds a guard an onRoute hook installs, to later routes whose URL matches', () => {
    const facts = detect(app(`
      import { guardOwnScopeContractRoutes, guardOwnScopeRoutes, ownScopeGuard } from './guard.js'
      export async function routes(app: FastifyInstance) {
        app.get('/early/:id', async () => 1)
        guardOwnScopeContractRoutes(app)
        app.get('/contracts', async () => 1)
        app.get('/contracts/:id', async () => 1)
        app.get('/reviews/:contractId', async () => 1)
      }
      export async function others(app: FastifyInstance) {
        guardOwnScopeContractRoutes(app, /\\/:contractId(\\/|$)/, 'contractId')
        app.get('/queue/:contractId', async () => 1)
      }`, {
      'src/app.ts': `
        import Fastify from 'fastify'
        import { routes, others } from './routes.js'
        const app = Fastify()
        await app.register(routes, { prefix: '/api' })
        await app.register(others, { prefix: '/api' })`,
      'src/guard.ts': `
        export function ownScopeGuard(owns, detail, param = 'id') {
          return async (req, reply) => { if (!(await owns(req))) return reply.status(404).send({ detail }) }
        }
        export function guardOwnScopeRoutes(app: FastifyInstance, urlPattern: RegExp, guard) {
          app.addHook('onRoute', (route) => {
            if (!urlPattern.test(route.url)) return
            const existing = route.preHandler ? [route.preHandler] : []
            route.preHandler = [...existing, guard]
          })
        }
        export const ownScopeContractGuard = ownScopeGuard(ownsContract, 'Contract not found')
        export function guardOwnScopeContractRoutes(app: FastifyInstance, urlPattern = /\\/:id(\\/|$)/, param = 'id') {
          guardOwnScopeRoutes(app, urlPattern, param === 'id' ? ownScopeContractGuard : ownScopeGuard(ownsContract, 'Contract not found', param))
        }`,
    }))
    // onRoute fires as routes are registered: one registered before it is untouched.
    expect(find(facts, 'GET', '/api/early/:id')?.middleware).toEqual([])
    expect(find(facts, 'GET', '/api/contracts')?.middleware).toEqual([])
    expect(find(facts, 'GET', '/api/contracts/:id')?.middleware).toEqual(["ownScopeGuard(ownsContract, 'Contract not found')"])
    expect(find(facts, 'GET', '/api/reviews/:contractId')?.middleware).toEqual([])
    expect(find(facts, 'GET', '/api/queue/:contractId')?.middleware).toEqual(["ownScopeGuard(ownsContract, 'Contract not found', param)"])
  })

  it('names a 401 or 403 written inside the handler, and not a 404', () => {
    const facts = detect(app(`
      export async function routes(app: FastifyInstance) {
        app.post('/chunk', async (req, reply) => {
          if (req.headers['x-internal-secret'] !== process.env.SECRET) return reply.status(401).send()
          return { ok: true }
        })
        app.get('/thing/:id', async (req, reply) => {
          const row = await find(req.params.id)
          if (!row) return reply.status(404).send()
          return row
        })
        app.post('/hook', { preHandler: requireUser, handler: async (req, reply) => reply.code(403).send() })
      }`))
    expect(find(facts, 'POST', '/api/chunk')?.middleware).toEqual(['in-handler check'])
    expect(find(facts, 'GET', '/api/thing/:id')?.middleware).toEqual([])
    expect(find(facts, 'POST', '/api/hook')?.middleware).toEqual(['requireUser', 'in-handler check'])
  })

  it('reads a plugin registered at two prefixes at both', () => {
    const facts = detect({
      'src/app.ts': `
        import Fastify from 'fastify'
        import { v } from './v.js'
        const app = Fastify()
        await app.register(v, { prefix: '/v1' })
        await app.register(v, { prefix: '/v2' })`,
      'src/v.ts': `export async function v(app: FastifyInstance) { app.get('/x', async () => 1) }`,
    })
    expect(routes(facts).map((r) => r.path).sort()).toEqual(['/v1/x', '/v2/x'])
  })
})
