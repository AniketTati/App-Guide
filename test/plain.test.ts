import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/run.js'
import { renderTerminal } from '../src/render/terminal.js'
import { ask } from '../src/render/ask.js'
import { setColor } from '../src/render/ansi.js'
import { installHook } from '../src/hook/install.js'
import { readConfig } from '../src/config.js'

// verify() runs the real install command. Pointed at a path that cannot exist,
// it fails in about a second with no network — a test suite that clones from
// GitHub on every run is slow, flaky, and quietly depends on the internet.
beforeAll(() => { process.env['APPGUIDE_SPEC'] = 'file:/nonexistent-appguide-offline-spec' })


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
    expect(out).toContain('Anyone on the internet can send data to this one.')
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

  it('is told how to clear the list, or it repeats forever', async () => {
    // Not being wrong gets a tool uninstalled far more slowly than not
    // shutting up.
    const { dir } = await scenario()
    expect(await plain(dir)).toContain('appguide seen')
  })

  it('never contradicts its own number', async () => {
    // "4 of 9 URLs have nothing checking them" printed directly above "every
    // other URL is checked" destroys the one thing the reader was asked to
    // trust: that the counts are checkable.
    const dir = await mkdtemp(join(tmpdir(), 'plain-c2-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}')
    const guarded = Array.from({ length: 6 }, (_, i) => `app.get('/g${i}', requireAuth, h)`).join('\n')
    await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}`)
    await run({ root: dir, mark: true })
    await writeFile(join(dir, 'src/api.ts'),
      `const app = express()\n${guarded}\napp.get('/a', h)\napp.get('/b', h)\napp.get('/c', h)\n`)
    const out = renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { columns: 78, voice: 'plain' })
    if (out.includes('every other URL is checked')) {
      expect(out).toMatch(/nothing checks it · 1 of \d+/)
    }
  })

  it('does not let three of one kind crowd out every other kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-d-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0","@prisma/client":"^5.0.0"}}')
    const guarded = Array.from({ length: 6 }, (_, i) => `app.get('/g${i}', requireAuth, h)`).join('\n')
    await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}`)
    await mkdir(join(dir, 'src/auth'), { recursive: true })
    await mkdir(join(dir, 'src/billing'), { recursive: true })
    await writeFile(join(dir, 'src/auth/db.ts'), 'prisma.users.update({})')
    await run({ root: dir, mark: true })
    await writeFile(join(dir, 'src/api.ts'),
      `const app = express()\n${guarded}\napp.get('/a', h)\napp.get('/b', h)\napp.get('/c', h)\n`)
    await writeFile(join(dir, 'src/billing/pay.ts'), "prisma.users.update({})\nawait fetch('https://api.stripe.com/x')")
    const r = await run({ root: dir, mark: false, voice: 'plain' })
    const kinds = new Set(r.top.map((c) => c.fact.kind))
    expect(kinds.size).toBeGreaterThan(1)
  })

  it('does not report its own notes as a problem with the code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-m-'))
    await writeFile(join(dir, 'package.json'), '{}')
    const out = renderTerminal(await run({ root: dir, mark: true, voice: 'plain' }), { columns: 78, voice: 'plain' })
    expect(out).not.toContain('.appguide')
    expect(out).not.toContain('package list')
  })

  it('holds the layout at a narrow terminal', async () => {
    const { dir } = await scenario()
    for (let cols = 60; cols <= 100; cols++) {
      for (const line of (await plain(dir, cols)).split('\n')) {
        expect(line.length, `${cols}: ${line}`).toBeLessThanOrEqual(cols)
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
    await mkdir(join(dir, '.appguide'), { recursive: true })
    await writeFile(join(dir, '.appguide/config.json'), '{"plain":true}')
    expect((await readConfig(dir)).plain).toBe(true)
  })

  it('works with no config at all', async () => {
    expect((await readConfig(await mkdtemp(join(tmpdir(), 'plain-n-')))).plain).toBe(false)
  })
})

describe('install honesty', () => {
  it('refuses to claim success on a hook it could not run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-i-'))
    // No package.json named appguide, so it writes the npx command — which
    // cannot resolve until the package is published.
    const r = await installHook(dir, false, true)
    expect(r.outcome).toBe('installed')
    expect(r.verified).toBe(false)
    expect(r.problem).toBeTruthy()
  })

  it('verifies successfully when the command really runs', async () => {
    // In this repo the hook points at the local build. Restore the real
    // settings afterwards: installing into the working repo and uninstalling
    // left .claude/settings.json modified after every test run.
    const settingsPath = join(process.cwd(), '.claude/settings.json')
    const original = await readFile(settingsPath, 'utf8').catch(() => null)
    try {
      const r = await installHook(process.cwd(), false, false)
      expect(r.verified).toBe(true)
    } finally {
      if (original === null) await rm(settingsPath, { force: true })
      else await writeFile(settingsPath, original, 'utf8')
    }
  })
})

describe('the answer is never clipped', () => {
  it('shows a long URL in full at every width', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plain-w-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    const guarded = Array.from({ length: 7 }, (_, i) => `app.get('/g${i}', requireAuth, h)`).join('\n')
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}')
    await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}`)
    await run({ root: dir, mark: true })
    const long = '/api/internal/admin/reset-all-usage-counters'
    await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}\napp.delete('${long}', h)\n`)

    for (const cols of [60, 62, 78, 100]) {
      const out = renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { columns: cols, voice: 'plain' })
      // Which URL is unprotected is the entire answer. An answer ending in an
      // ellipsis is not one.
      const flat = out.split('\n').map((l) => l.trim()).join('')
      expect(flat, `${cols} cols`).toContain(long)
    }
  })
})

describe('the first receipt a non-developer sees', () => {
  it('never prints the glitch-looking "1 of 1"', async () => {
    // It appeared on the very first receipt of the end-to-end install: one new
    // call to Stripe, in an app that called nothing else, read "1 of 1 outside
    // services" — true, checkable, and indistinguishable from a bug.
    const dir = await mkdtemp(join(tmpdir(), 'plain-one-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}')
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 1')
    await run({ root: dir, mark: true })
    await writeFile(join(dir, 'src/a.ts'), "export async function pay() { await fetch('https://api.stripe.com/v1/x') }")
    for (const voice of ['plain', 'technical'] as const) {
      const report = await run({ root: dir, mark: false, voice })
      const out = renderTerminal(report, { columns: 78, voice })
      expect(out, voice).toContain('api.stripe.com')
      expect(out, voice).not.toMatch(/\b1 of 1\b/)
      expect(ask(report, 1, voice) ?? '', voice).not.toMatch(/\b1 of 1\b/)
    }
    expect(renderTerminal(await run({ root: dir, mark: false, voice: 'plain' }), { columns: 78, voice: 'plain' }))
      .toContain('the only outside service')
  })
})

