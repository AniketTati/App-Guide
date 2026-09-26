import { beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProduct, type Product } from '../src/graph/product.js'
import { rolesFor } from '../src/graph/roles.js'

/** A small monorepo shaped like the real one: a React web app over a Fastify
 *  API, roles in a shared types package. */
const FILES: Record<string, string> = {
  'package.json': '{"name":"root","private":true}',
  'packages/types/package.json': '{"name":"@acme/types","main":"./src/index.ts"}',
  'packages/types/src/index.ts': "export * from './enums'\n",
  'packages/types/src/enums.ts': `export enum Role { ADMIN = 'ADMIN', SALES = 'SALES', VIEWER = 'VIEWER' }
export enum Action { VIEW = 'view', EDIT = 'edit', DELETE = 'delete' }
export enum Resource { CONTRACT = 'contract' }
export enum Scope { ORG = 'org', OWN = 'own' }
`,
  'apps/api/package.json': '{"name":"api","dependencies":{"fastify":"^5.0.0","@prisma/client":"^5.0.0","@acme/types":"workspace:*"}}',
  'apps/api/src/lib/permissions.ts': `import { Action as A, Resource as R, Scope as S, Role } from '@acme/types'
function p(action, resource, scope = S.ORG) { return { action, resource, scope } }
export const ROLE_PERMISSIONS = {
  [Role.ADMIN]: [p('*', '*')],
  [Role.SALES]: [p(A.VIEW, R.CONTRACT, S.OWN), p(A.EDIT, R.CONTRACT, S.OWN)],
  [Role.VIEWER]: [p(A.VIEW, R.CONTRACT)],
}
export const KEY_SCOPES = {
  'contracts:read': [p(A.VIEW, R.CONTRACT)],
  'contracts:write': [p(A.EDIT, R.CONTRACT)],
}
export function build() { const grouped = { a: [p(A.VIEW, R.CONTRACT)], b: [p(A.EDIT, R.CONTRACT)] }; return grouped }
`,
  'apps/api/src/lib/audit.ts': 'export async function audit(e) { await prisma.auditEvent.create({ data: e }) }\n',
  'apps/api/src/app.ts': `import Fastify from 'fastify'
import { contractRoutes } from './routes/contracts.js'
export async function build() {
  const app = Fastify()
  await app.register(contractRoutes, { prefix: '/api/v1/contracts' })
  app.get('/api/v1/health', async () => 'ok')
  return app
}
`,
  'apps/api/src/routes/contracts.ts': `import { audit } from '../lib/audit.js'
export async function contractRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async () => prisma.contract.findMany())
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req) => {
    await prisma.$transaction(async (tx) => { await tx.contract.update({}); await tx.contractVersion.create({}) })
    await audit({})
  })
  app.delete('/:id', { preHandler: requirePermission('delete', 'contract') }, async () => prisma.contract.delete({}))
}
`,
  'apps/web/package.json': '{"name":"web","dependencies":{"react":"^19.0.0","react-router-dom":"^7.0.0","axios":"^1.0.0"}}',
  'apps/web/tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
  'apps/web/src/lib/api.ts': "import axios from 'axios'\nexport const api = axios.create({ baseURL: '/api/v1' })\n",
  'apps/web/src/App.tsx': `import { Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from '@/pages/LoginPage'
import { ContractsPage } from '@/pages/ContractsPage'
import { ContractPage } from '@/pages/ContractPage'
import { AuditPage } from '@/pages/AuditPage'
import { Shell } from '@/components/Shell'
function Protected({ children }) { return signedIn() ? children : <Navigate to="/login" /> }
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<Protected><Shell /></Protected>}>
        <Route index element={<Navigate to="/contracts" replace />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="contracts/:id" element={<ContractPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<LoginPage />} />
      </Route>
    </Routes>
  )
}
`,
  'apps/web/src/components/Shell.tsx': "import { api } from '@/lib/api'\nexport function Shell() { api.get('/health'); return null }\n",
  'apps/web/src/components/Avatar.tsx': "import { api } from '@/lib/api'\nexport function Avatar() { api.get('/me'); return null }\n",
  'apps/web/src/components/Sidebar.tsx': `const NAV = [
  { items: [{ to: '/contracts', label: 'Contracts' }] },
  { label: 'Admin', items: [{ to: '/audit', label: 'Audit log' }] },
]
export function Sidebar() { return null }
`,
  'apps/web/src/pages/LoginPage.tsx': "import { Avatar } from '@/components/Avatar'\nexport function LoginPage() { return null }\n",
  'apps/web/src/pages/ContractsPage.tsx': "import { api } from '@/lib/api'\nimport { Avatar } from '@/components/Avatar'\nexport function ContractsPage() { api.get('/contracts'); return null }\n",
  'apps/web/src/pages/ContractPage.tsx': `import { api } from '@/lib/api'
import { Avatar } from '@/components/Avatar'
export function ContractPage({ id, qs }) {
  api.patch(\`/contracts/\${id}\`)
  api.delete(\`/contracts/\${id}\`)
  api.get('/approvals')
  return null
}
`,
  'apps/web/src/pages/AuditPage.tsx': "import { api } from '@/lib/api'\nexport function AuditPage({ qs }) { api.get(`/contracts${qs}`); return null }\n",
}

let p: Product
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'appguide-graph-'))
  for (const [path, text] of Object.entries(FILES)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text) }
  p = await readProduct(root)
}, 60_000)

describe('screens', () => {
  it('reads the router: full paths, the page component, redirects and catch-alls left out', () => {
    expect(p.screens.map((s) => `${s.path} ${s.component}`).sort()).toEqual(['/audit AuditPage', '/contracts ContractsPage', '/contracts/:id ContractPage', '/login LoginPage'])
  })

  it('knows which need sign-in from the wrapper that sends people elsewhere', () => {
    const by = Object.fromEntries(p.screens.map((s) => [s.path, s.signIn]))
    expect(by).toEqual({ '/login': 'none', '/contracts': 'required', '/contracts/:id': 'required', '/audit': 'required' })
  })

  it('places each screen under its sidebar section; a detail screen under its parent', () => {
    const by = Object.fromEntries(p.screens.map((s) => [s.path, [s.section, s.label]]))
    expect(by['/contracts']).toEqual(['Start', 'Contracts'])
    expect(by['/contracts/:id']).toEqual(['Start', null])
    expect(by['/audit']).toEqual(['Admin', 'Audit log'])
  })
})

describe('what each screen calls', () => {
  const routesOf = (screen: string) => (p.links.get(screen) ?? []).map((l) => `${l.route.method} ${l.route.path}`).sort()

  it('follows the client’s base URL and matches the route, parameters included', () => {
    expect(routesOf('/contracts')).toEqual(['GET /api/v1/contracts'])
    expect(routesOf('/contracts/:id')).toEqual(['DELETE /api/v1/contracts/:id', 'PATCH /api/v1/contracts/:id'])
  })

  it('drops a query string glued onto a path instead of reading it as a segment', () => {
    expect(routesOf('/audit')).toEqual(['GET /api/v1/contracts'])
  })

  it('keeps a call that matches no route, as a finding', () => {
    expect(p.unmatched.map((u) => `${u.method} ${u.path} ${u.screen}`)).toEqual(['GET /api/v1/approvals /contracts/:id'])
  })

  it('credits the layout, not every screen, with what the layout calls — and a piece three screens share, to none', () => {
    expect(p.layout.map((l) => `${l.route.method} ${l.route.path}`)).toEqual(['GET /api/v1/health'])
    expect([...p.links.values()].flat().some((l) => l.call.path === '/api/v1/me')).toBe(false)
  })
})

describe('what each route does with data, and who may call it', () => {
  const route = (method: string, path: string) => p.facts.find((f) => f.kind === 'route' && f.method === method && f.path === path)!

  it('reads the handler’s data, inside a transaction and one call deep', () => {
    const uses = (p.data.get(route('PATCH', '/api/v1/contracts/:id') as never) ?? []).map((d) => `${d.kind} ${d.table}${d.via ? ` via ${d.via}` : ''}`)
    expect(uses).toEqual(['write contract', 'write contractVersion', 'write auditEvent via audit'])
  })

  it('finds the role table by its shape, roles keyed by an enum first, and never a local object', () => {
    expect(p.roles.map((t) => [t.name, t.keyedByEnum])).toEqual([['ROLE_PERMISSIONS', true], ['KEY_SCOPES', false]])
    expect(p.roles[0]!.roles.map((r) => r.role)).toEqual(['ADMIN', 'SALES', 'VIEWER'])
  })

  it('answers who may call a route from its own check, wildcards and scopes included', () => {
    const r = route('PATCH', '/api/v1/contracts/:id')
    expect(rolesFor(r.kind === 'route' && Array.isArray(r.middleware) ? r.middleware : [], p.roles[0]!)).toEqual([
      { role: 'ADMIN', scope: 'org' }, { role: 'SALES', scope: 'own' },
    ])
  })
})
