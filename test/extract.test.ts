import { describe, expect, it } from 'vitest'
import type { Fact } from '../src/model/facts.js'
import { scanExternal } from '../src/extract/external.js'
import { scanData } from '../src/extract/data.js'
import { scanRoutes } from '../src/extract/routes/index.js'

import { parseAll } from '../src/extract/parse.js'

const files = (m: Record<string, string>) => parseAll(Object.entries(m).map(([path, text]) => ({ path, text }))).parsed

describe('outbound calls', () => {
  it('finds an absolute url in a literal', () => {
    const out = scanExternal(files({ 'src/a.ts': "await fetch('https://api.stripe.com/v1/refunds')" }), new Map())
    expect(out[0]).toMatchObject({ kind: 'external', host: 'api.stripe.com', via: 'url' })
  })

  it('keeps a non-default port, which used to be swallowed', () => {
    const out = scanExternal(files({ 'src/a.ts': "fetch('https://internal.example.com:8443/x')" }), new Map())
    expect(out[0]).toMatchObject({ host: 'internal.example.com:8443' })
  })

  it('infers a host from an SDK import', () => {
    const out = scanExternal([], new Map([['stripe', ['src/billing.ts']]]))
    expect(out[0]).toMatchObject({ host: 'api.stripe.com', via: 'stripe' })
  })

  it('ignores localhost, which is a dev detail not an outbound dependency', () => {
    expect(scanExternal(files({ 'src/a.ts': "fetch('http://localhost:3000/x')" }), new Map())).toHaveLength(0)
  })

  it('reports a host once, however many times it is called', () => {
    const out = scanExternal(files({ 'a.ts': "fetch('https://api.x.com/1')", 'b.ts': "fetch('https://api.x.com/2')" }), new Map())
    expect(out).toHaveLength(1)
  })
})

const prisma = new Set(['@prisma/client'])
const drizzle = new Set(['drizzle-orm'])

describe('data access', () => {

  it('attributes a prisma write to the calling module', () => {
    const out = scanData(files({ 'src/billing/usage.ts': 'await prisma.users.update({})' }), prisma)
    expect(out[0]).toMatchObject({ kind: 'write', table: 'users', module: 'src/billing' })
  })

  it('separates reads from writes', () => {
    const out = scanData(files({ 'src/a/x.ts': 'prisma.users.findMany(); prisma.users.create({})' }), prisma)
    expect(out.map((f) => f.kind).sort()).toEqual(['read', 'write'])
  })

  it('reads drizzle inserts and selects', () => {
    const out = scanData(files({
      'src/schema.ts': "export const refunds = pgTable('refunds', {}); export const users = pgTable('users', {})",
      'src/b/x.ts': 'db.insert(refunds).values(v); db.select().from(users)',
    }), drizzle)
    expect(out.find((f) => f.kind === 'write')).toMatchObject({ table: 'refunds' })
    expect(out.find((f) => f.kind === 'read')).toMatchObject({ table: 'users' })
  })

  it('does not mistake Array.from or a cache for database access', () => {
    // WRITE contains set/remove/delete and READ contains from, so without a
    // resolved table binding this fires on ordinary JavaScript.
    const out = scanData(files({
      'src/schema.ts': "export const users = pgTable('users', {})",
      'src/a.ts': 'Array.from(nodes); Buffer.from(input); cache.set(userId, data); set.delete(item)',
    }), drizzle)
    expect(out).toHaveLength(0)
  })

  it('does not mistake DOM calls for prisma writes', () => {
    const out = scanData(files({ 'src/a.ts': "el.classList.remove('active'); document.body.remove()" }), prisma)
    expect(out).toHaveLength(0)
  })

  it('sees this.prisma and ctx.prisma, the dominant real-world idioms', () => {
    const out = scanData(files({
      'src/svc/a.ts': 'class S { f() { return this.prisma.user.create({}) } }',
      'src/trpc/b.ts': 'ctx.prisma.invoice.create({})',
    }), prisma)
    expect(out.map((f) => f.kind === 'write' && f.table).sort()).toEqual(['invoice', 'user'])
  })

  it('sees a client bound from new PrismaClient()', () => {
    const out = scanData(files({ 'src/a/x.ts': 'const client = new PrismaClient(); client.account.deleteMany({})' }), prisma)
    expect(out[0]).toMatchObject({ kind: 'write', table: 'account' })
  })
})

describe('false positives that made the tool unusable', () => {
  it('does not treat req.get as a route', () => {
    // Express's own header API. Every one of these used to become a route with
    // no middleware, and therefore a top-block finding.
    const out = files({ 'src/a.ts': `
      const app = express()
      app.post('/pay', requireAuth, (req, res) => {
        const t = req.get('Authorization')
        const c = cache.get('user:123')
        const s = searchParams.get('q')
      })
    ` })
    const routes = scanRoutes({ files: out, declared: new Set(['express']) }).filter((f) => f.kind === 'route')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ path: '/pay' })
  })

  it('does not treat an svg namespace as an outbound call', () => {
    const out = scanExternal(files({ 'src/Spinner.tsx': `const s = <svg xmlns="http://www.w3.org/2000/svg" />` }), new Map())
    expect(out).toHaveLength(0)
  })

  it('does not treat a url outside a call as an outbound call', () => {
    const out = scanExternal(files({ 'src/a.ts': `const DOCS = 'https://example.com/docs'` }), new Map())
    expect(out).toHaveLength(0)
  })

  it('scopes two routers that share a path, instead of one overwriting the other', () => {
    const out = scanRoutes({
      files: files({
        'src/routes/users.ts': "const router = Router(); router.get('/:id', h)",
        'src/routes/orders.ts': "const router = Router(); router.get('/:id', authz, h)",
      }),
      declared: new Set(['express']),
    }).filter((f) => f.kind === 'route')
    expect(out).toHaveLength(2)
    expect(new Set(out.map((f) => f.kind === 'route' && f.scope)).size).toBe(2)
  })

  it('does nothing when no ORM is present', () => {
    expect(scanData(files({ 'src/a.ts': 'prisma.users.create({})' }), new Set())).toHaveLength(0)
  })

  it('records a module-table pair once, not once per call site', () => {
    const out = scanData(files({ 'src/a/x.ts': 'prisma.users.create({})', 'src/a/y.ts': 'prisma.users.create({})' }), prisma)
    expect(out.filter((f: Fact) => f.kind === 'write')).toHaveLength(1)
  })
})

