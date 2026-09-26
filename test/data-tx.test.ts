import { describe, expect, it } from 'vitest'
import { scanData } from '../src/extract/data.js'
import { parseAll } from '../src/extract/parse.js'
import type { Fact } from '../src/model/facts.js'

const scan = (files: Record<string, string>): Fact[] =>
  scanData(parseAll(Object.entries(files).map(([path, text]) => ({ path, text }))).parsed, new Set(['@prisma/client']))
const pairs = (facts: Fact[]) => facts.filter((f) => f.kind === 'write' || f.kind === 'read').map((f) => f.kind === 'write' || f.kind === 'read' ? `${f.kind} ${f.table}` : '').sort()

describe('database access the reader used to miss', () => {
  it('reads writes made through a transaction client', () => {
    const facts = scan({
      'src/approvals/decide.ts': `
        export async function decide(id: string) {
          await prisma.$transaction(async (tx) => {
            await tx.approvalStep.update({ where: { id }, data: {} })
            await tx.auditEvent.create({ data: {} })
          })
          const tx = somethingElse()
        }`,
    })
    expect(pairs(facts)).toEqual(['write approvalStep', 'write auditEvent'])
  })

  it('reads writes made by a function handed a transaction client', () => {
    const facts = scan({
      'src/contracts/versions.ts': `
        import type { Prisma } from '@prisma/client'
        export async function addVersion(db2: Prisma.TransactionClient, id: string) {
          return db2.contractVersion.create({ data: { id } })
        }
        export function unrelated(tx: Map<string, string>) { tx.delete('a') }`,
    })
    expect(pairs(facts)).toEqual(['write contractVersion'])
  })

  it('does not treat a transaction parameter as a client outside its callback', () => {
    const facts = scan({
      'src/x.ts': `
        await prisma.$transaction(async (tx) => { await tx.user.update({}) })
        tx.cache.delete('k')`,
    })
    expect(pairs(facts)).toEqual(['write user'])
  })

  it('declares hand-written SQL instead of passing over it', () => {
    const facts = scan({
      'src/search/rank.ts': `
        const rows = await prisma.$queryRaw\`SELECT * FROM "Contract" WHERE id = \${id}\`
        await prisma.$executeRawUnsafe('UPDATE "Clause" SET x = 1')`,
    })
    const gaps = facts.filter((f) => f.kind === 'gap')
    expect(gaps.map((g) => g.kind === 'gap' && [g.reason, g.subject])).toEqual([
      ['raw-sql', 'src/search/rank.ts:2'],
      ['raw-sql', 'src/search/rank.ts:3'],
    ])
  })
})

describe('what the product does is read from the product, not its tests', () => {
  it('leaves test files out of routes, data and outside services', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { run } = await import('../src/run.js')
    const dir = await mkdtemp(join(tmpdir(), 'appguide-tests-'))
    const put = async (p: string, t: string) => { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), t) }
    await put('package.json', '{"dependencies":{"express":"^4.0.0","@prisma/client":"^5.0.0"},"devDependencies":{"vitest":"^2.0.0"}}')
    await put('src/api.ts', "const app = express()\napp.get('/contracts', requireAuth, list)\nawait prisma.contract.findMany()\n")
    await put('src/api.test.ts', "import { it } from 'vitest'\nconst app = express()\napp.get('/only-in-a-test', h)\nawait prisma.user.create({})\nawait fetch('https://fixtures.example.com/x')\n")
    await put('test/helpers.ts', "await prisma.auditEvent.deleteMany({})\n")
    await run({ root: dir, mark: true })
    const { read } = await import('../src/model/snapshot.js')
    const mark = await read(dir)
    if (!mark.ok) throw new Error('no mark')
    const facts = mark.snapshot.facts
    expect(facts.filter((f) => f.kind === 'route').map((f) => f.kind === 'route' && f.path)).toEqual(['/contracts'])
    expect(facts.filter((f) => f.kind === 'write' || f.kind === 'read').map((f) => (f.kind === 'write' || f.kind === 'read') && `${f.kind} ${f.table}`)).toEqual(['read contract'])
    expect(facts.some((f) => f.kind === 'external')).toBe(false)
    // …but a test framework is still a dependency.
    expect(facts.some((f) => f.kind === 'library' && f.name === 'vitest')).toBe(true)
  })
})
