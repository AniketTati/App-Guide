import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/run.js'
import { renderTerminal } from '../src/render/terminal.js'
import { setColor } from '../src/render/ansi.js'

beforeAll(() => setColor(false))

/** Every silent-failure bug this suite exists to catch lived in a file that
 *  touches the filesystem, and none of them had a test. */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'appguide-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
  return dir
}

const receipt = async (dir: string, mark = false): Promise<string> =>
  renderTerminal(await run({ root: dir, mark }), { columns: 78 })

describe('a repo on disk', () => {
  it('never claims all-clear on a first run', async () => {
    const out = await receipt(await repo({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1' }))
    expect(out).toContain('first run')
    expect(out).not.toContain('nothing new to the shape')
  })

  it('declares an unsupported framework it can see in the manifest', async () => {
    const dir = await repo({ 'package.json': '{"dependencies":{"hono":"^4.0.0"}}', 'src/a.ts': "import {Hono} from 'hono'" })
    await receipt(dir, true)
    expect(await receipt(dir)).toContain('hono')
  })

  it('reports a broken package.json instead of substituting an all-clear', async () => {
    // A trailing comma used to erase the entire unsupported-framework
    // declaration and print a confident "everything it touched was readable".
    const dir = await repo({ 'package.json': '{"dependencies":{"hono":"^4.0.0",}}', 'src/a.ts': "import {Hono} from 'hono'" })
    await receipt(dir, true)
    const out = await receipt(dir)
    expect(out).toContain('package.json')
    expect(out).not.toContain('everything it touched was readable')
  })

  it('reports a missing package.json rather than an empty dependency list', async () => {
    const dir = await repo({ 'src/a.ts': 'export const a = 1' })
    await receipt(dir, true)
    expect(await receipt(dir)).toContain('no package.json')
  })

  it('says so when a directory cannot be read', async () => {
    const dir = await repo({ 'package.json': '{}', 'src/locked/a.ts': 'export const a = 1' })
    await receipt(dir, true)
    await chmod(join(dir, 'src/locked'), 0o000)
    try {
      const out = await receipt(dir)
      expect(out).toContain('could not be read')
    } finally {
      await chmod(join(dir, 'src/locked'), 0o755)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sees a genuinely added dependency', async () => {
    const dir = await repo({ 'package.json': '{"dependencies":{}}', 'src/a.ts': 'export const a = 1' })
    await receipt(dir, true)
    await writeFile(join(dir, 'src/a.ts'), "import z from 'zod'\nexport const a = 1", 'utf8')
    const out = await receipt(dir)
    expect(out).toContain('zod')
  })

  it('does not report a library as changed when an importing file is renamed', async () => {
    const dir = await repo({ 'package.json': '{"dependencies":{"zod":"^3.0.0"}}', 'src/users.ts': "import z from 'zod'" })
    await receipt(dir, true)
    await rm(join(dir, 'src/users.ts'))
    await writeFile(join(dir, 'src/user.ts'), "import z from 'zod'", 'utf8')
    expect(await receipt(dir)).toContain('nothing new')
  })

  it('survives an empty repo without claiming anything', async () => {
    const out = await receipt(await repo({}))
    expect(out).toContain('first run')
  })

  it('refuses to compare against a corrupted mark', async () => {
    const dir = await repo({ 'package.json': '{}', 'src/a.ts': 'export const a = 1' })
    await receipt(dir, true)
    await writeFile(join(dir, '.appguide/mark'), 'garbage without tabs\n', 'utf8')
    const out = await receipt(dir)
    expect(out).not.toContain('nothing new to the shape')
  })
})

describe('the headline', () => {
  it('promotes an unauthenticated route the agent added, with a checkable number', async () => {
    const base = {
      'package.json': '{"dependencies":{"express":"^4.0.0"}}',
      'src/api.ts': `
        app.get('/api/a', requireAuth, h)
        app.get('/api/b', requireAuth, h)
        app.get('/api/c', requireAuth, h)
      `,
    }
    const dir = await repo(base)
    await receipt(dir, true)
    await writeFile(join(dir, 'src/api.ts'), `${base['src/api.ts']}\n app.post('/api/admin/reset', h)\n`, 'utf8')

    const out = await receipt(dir)
    expect(out).toContain('NEW TO THIS CODEBASE')
    expect(out).toContain('POST /api/admin/reset')
    expect(out).toContain('1 of 4 routes')
    expect(out).toContain('src/api.ts')
    // Arithmetic, never adjective.
    expect(out).not.toMatch(/danger|insecure|critical|warning|vulnerab/i)
  })

  it('stays quiet for a route added with the same middleware as its neighbours', async () => {
    const base = {
      'package.json': '{"dependencies":{"express":"^4.0.0"}}',
      'src/api.ts': "app.get('/api/a', requireAuth, h)\napp.get('/api/b', requireAuth, h)\n",
    }
    const dir = await repo(base)
    await receipt(dir, true)
    await writeFile(join(dir, 'src/api.ts'), `${base['src/api.ts']}app.get('/api/c', requireAuth, h)\n`, 'utf8')
    const out = await receipt(dir)
    expect(out).not.toContain('NEW TO THIS CODEBASE')
    expect(out).toContain('/api/c')
  })
})
