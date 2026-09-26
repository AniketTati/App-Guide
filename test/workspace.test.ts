import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/run.js'
import { scanLibraries } from '../src/extract/libraries.js'
import { renderTerminal } from '../src/render/terminal.js'
import { setColor } from '../src/render/ansi.js'
import type { Fact } from '../src/model/facts.js'

beforeAll(() => setColor(false))

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'appguide-ws-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text, 'utf8')
  }
  return dir
}

const gapsOf = (facts: readonly Fact[], reason: string) =>
  facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap' && f.reason === reason)

/** The shape of draft-legal: a root that declares only tooling, and apps that
 *  declare everything real. */
const monorepo = {
  'package.json': '{"name":"root","private":true,"devDependencies":{"typescript":"^5.0.0"}}',
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
  'apps/web/package.json': '{"name":"web","dependencies":{"react":"^18.0.0","axios":"^1.0.0"}}',
  'apps/web/src/main.tsx': "import React from 'react'\nimport axios from 'axios'\n",
  'apps/api/package.json': '{"name":"api","dependencies":{"fastify":"^5.0.0","@prisma/client":"^5.0.0"}}',
  'apps/api/src/app.ts': "import Fastify from 'fastify'\nimport { PrismaClient } from '@prisma/client'\n",
}

describe('a workspace', () => {
  it('credits each dependency to the member that declares it', async () => {
    // Reading only the root reported every one of these as "imported but not
    // in package.json" — 84 false alarms in the real monorepo.
    const scan = await scanLibraries(await repo(monorepo))
    expect(gapsOf(scan.facts, 'unresolved-import')).toEqual([])
    expect(scan.facts.find((f) => f.kind === 'library' && f.name === 'react'))
      .toMatchObject({ direct: true, where: { file: 'apps/web/package.json' } })
    expect(scan.workspace.map((m) => m.name).sort()).toEqual(['api', 'web'])
  })

  it('declares a framework it cannot read when only a member depends on it', async () => {
    // The real monorepo's Fastify API had ~290 routes and got no blind spot at
    // all, because only its member manifest named Fastify.
    const scan = await scanLibraries(await repo({
      ...monorepo,
      'apps/edge/package.json': '{"name":"edge","dependencies":{"hono":"^4.0.0"}}',
      'apps/edge/src/index.ts': "import { Hono } from 'hono'\n",
    }))
    const unread = gapsOf(scan.facts, 'unsupported-framework').map((g) => [g.subject, g.where.file])
    expect(unread).toContainEqual(['hono', 'apps/edge/package.json'])
    // Fastify is read now, so it is no longer a blind spot.
    expect(unread.map(([subject]) => subject)).not.toContain('fastify')
  })

  it('still reports a package that no manifest declares', async () => {
    const scan = await scanLibraries(await repo({ ...monorepo, 'apps/web/src/extra.ts': "import dayjs from 'dayjs'\n" }))
    expect(gapsOf(scan.facts, 'unresolved-import').map((g) => g.subject)).toEqual(['dayjs'])
  })

  it('reports a member manifest it cannot read, where it is, instead of treating it as empty', async () => {
    const scan = await scanLibraries(await repo({ ...monorepo, 'apps/api/package.json': '{ "dependencies": { broken' }))
    expect(gapsOf(scan.facts, 'parse-error').map((g) => g.subject)).toContain('apps/api/package.json')
  })
})

describe('code in a language it does not read', () => {
  it('says so, instead of an empty and confident list', async () => {
    const dir = await repo({
      'package.json': '{}',
      'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'app/routes.py': '@app.get("/contracts")\ndef list_contracts(): ...\n',
    })
    await run({ root: dir, mark: true })
    const report = await run({ root: dir, mark: false })
    expect(gapsOf(report.gaps, 'unsupported-language'))
      .toEqual([expect.objectContaining({ subject: 'Python', detail: expect.stringContaining('2 Python files') })])
    const out = renderTerminal(report, { columns: 80 })
    expect(out).toContain('nothing new in what I can read')
    expect(out).not.toContain('everything it touched was readable')
    const plain = renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { columns: 80, voice: 'plain' })
    expect(plain).toContain("I can't read Python yet")
  })

  it('ignores a virtual environment, whatever it is called', async () => {
    const dir = await repo({
      'package.json': '{}',
      'app.py': 'print(1)\n',
      'env/pyvenv.cfg': 'home = /usr/bin\n',
      'env/lib/python3.12/site-packages/requests/api.py': 'def get(): ...\n',
    })
    const scan = await scanLibraries(dir)
    expect(gapsOf(scan.facts, 'unsupported-language')[0]?.detail).toContain('1 Python file not read')
  })
})

describe('imports that are not packages', () => {
  it('knows a path alias and a Node built-in are not missing dependencies', async () => {
    const scan = await scanLibraries(await repo({
      ...monorepo,
      'apps/web/tsconfig.json': '{ // comments are allowed here\n "compilerOptions": { "paths": { "@/*": ["./src/*"], "@ui/*": ["./src/ui/*"], "#env": ["./src/env.ts"] } } }',
      'apps/web/src/page.tsx': "import { Button } from '@/components/Button'\nimport { Card } from '@ui/Card'\nimport env from '#env'\nimport { log } from '~/lib/log'\n",
      'apps/api/src/share.ts': "import { randomBytes } from 'crypto'\nimport path from 'path'\n",
    }))
    expect(gapsOf(scan.facts, 'unresolved-import')).toEqual([])
    expect(scan.facts.filter((f) => f.kind === 'library').map((f) => f.kind === 'library' && f.name))
      .not.toEqual(expect.arrayContaining(['@/components', '@ui/Card', 'crypto', 'path']))
  })

  it('still counts an npm package that shares a name with a Node built-in, when it is declared', async () => {
    const scan = await scanLibraries(await repo({
      'package.json': '{"dependencies":{"events":"^3.3.0"}}',
      'src/bus.ts': "import { EventEmitter } from 'events'\n",
    }))
    expect(scan.facts.find((f) => f.kind === 'library' && f.name === 'events')).toMatchObject({ direct: true })
  })
})
