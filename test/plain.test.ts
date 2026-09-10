import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/run.js'
import { renderTerminal } from '../src/render/terminal.js'
import { ask } from '../src/render/ask.js'
import { setColor } from '../src/render/ansi.js'
import { installHook } from '../src/hook/install.js'
import { readConfig } from '../src/config.js'

beforeAll(() => setColor(false))

/**
 * The goal, as an assertion. If any of these words reaches a reader who does
 * not write code, the plain voice has failed at the only thing it does.
 */
const JARGON = [
  'middleware', 'route', 'dependency', 'dependencies', 'transitive', 'module',
  'symbol', 'call site', 'AST', 'extractor', 'boundary', 'commit', 'repo',
  'coverage', 'unresolved', 'parse', 'schema',
]

async function scenario(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'plain-'))
  await mkdir(join(dir, 'src/billing'), { recursive: true })
  const base = Array.from({ length: 9 }, (_, i) => `app.get('/api/r${i}', requireAuth, h)`).join('\n')
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0","@prisma/client":"^5.0.0","hono":"^4.0.0"}}')
  await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${base}`)
  await writeFile(join(dir, 'src/billing/pay.ts'), 'prisma.invoices.update({})')
  await run({ root: dir, mark: true })

  await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${base}\napp.post('/api/admin/reset-usage', h)\n`)
  await writeFile(join(dir, 'src/billing/pay.ts'), "prisma.invoices.update({})\nawait fetch('https://api.stripe.com/v1/x')")
  await writeFile(join(dir, 'src/auth.ts'), 'prisma.users.update({})')
  return { dir }
}

const plain = async (dir: string, columns = 78): Promise<string> =>
  renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { columns, voice: 'plain' })

describe('a reader who does not write code', () => {
  it('sees no jargon anywhere in the receipt', async () => {
    const { dir } = await scenario()
    const out = (await plain(dir)).toLowerCase()
    for (const word of JARGON) {
      expect(out, `plain output contains "${word}"`).not.toContain(word)
    }
  })

  it('is told what happened in a sentence, before any table', async () => {
    const { dir } = await scenario()
    const first = (await plain(dir)).split('\n').find((l) => l.includes('Your agent'))
    expect(first).toBeDefined()
    expect(first).toContain('nothing checking who can use it')
  })

  it('is told why it might matter, without being told it is dangerous', async () => {
    const { dir } = await scenario()
    const out = await plain(dir)
    expect(out).toContain('Anyone on the internet can reach this one.')
    // Translating is allowed. Judging is not — a verdict cannot be checked.
    expect(out).not.toMatch(/insecure|dangerous|critical|vulnerab|you should|risk/i)
  })

  it('never claims a check does something, only that it exists', async () => {
    // `requireAuth` is a name, not evidence. Reading it and saying "needs
    // login" would be inference dressed as fact.
    const { dir } = await scenario()
    expect(await plain(dir)).not.toMatch(/needs login|requires auth|authenticated/i)
  })

  it('gets numbered findings it can refer to', async () => {
    const { dir } = await scenario()
    const out = await plain(dir)
    expect(out).toContain('#1')
    expect(out).toContain('Ask your agent')
  })

  it('says plainly when it could not read something', async () => {
    const { dir } = await scenario()
    expect(await plain(dir)).toContain("I can't read hono yet")
  })

  it('holds the layout at a narrow terminal', async () => {
    const { dir } = await scenario()
    for (const cols of [60, 78, 100]) {
      for (const line of (await plain(dir, cols)).split('\n')) {
        expect(line.length, `${cols}: ${line}`).toBeLessThanOrEqual(Math.max(60, Math.min(100, cols)))
      }
    }
  })

  it('says something reassuring, not empty, when nothing happened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-q-'))
    await writeFile(join(dir, 'package.json'), '{}')
    await run({ root: dir, mark: true, voice: 'plain' })
    const out = renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { voice: 'plain', columns: 78 })
    expect(out).toContain('nothing new')
  })
})

describe('handing a finding to the agent', () => {
  it('produces a prompt that stands on its own', async () => {
    const { dir } = await scenario()
    const prompt = ask(await run({ root: dir, mark: false }), 1)
    expect(prompt).toContain('src/api.ts:11')
    expect(prompt).toContain('POST /api/admin/reset-usage')
    expect(prompt).toContain('ask me before')
  })

  it('says so when there is no such finding', async () => {
    const { dir } = await scenario()
    expect(ask(await run({ root: dir, mark: false }), 99)).toBeNull()
  })
})

describe('choosing the voice once', () => {
  it('bakes --plain into the installed hook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-h-'))
    await installHook(dir, false, true)
    expect(await readFile(join(dir, '.claude/settings.json'), 'utf8')).toContain('--plain')
  })

  it('reads the choice from a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-c-'))
    await writeFile(join(dir, '.appguide.json'), '{"plain":true}')
    expect((await readConfig(dir)).plain).toBe(true)
  })

  it('works with no config at all', async () => {
    expect((await readConfig(await mkdtemp(join(tmpdir(), 'plain-n-')))).plain).toBe(false)
  })
})
