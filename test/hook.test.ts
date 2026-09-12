import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../src/hook/install.js'

// verify() runs the real install command. Pointed at a path that cannot exist,
// it fails in about a second with no network — a test suite that clones from
// GitHub on every run is slow, flaky, and quietly depends on the internet.
beforeAll(() => { process.env['APPGUIDE_SPEC'] = 'file:/nonexistent-appguide-offline-spec' })


const dir = () => mkdtemp(join(tmpdir(), 'appguide-hook-'))
const settings = async (d: string) => JSON.parse(await readFile(join(d, '.claude/settings.json'), 'utf8'))

describe('the stop hook', () => {
  it('installs into a repo with no settings at all', async () => {
    const d = await dir()
    expect((await installHook(d)).outcome).toBe('installed')
    expect(JSON.stringify(await settings(d))).toContain('nonexistent-appguide-offline-spec since')
  })

  it('is idempotent', async () => {
    const d = await dir()
    await installHook(d)
    expect((await installHook(d)).outcome).toBe('already-installed')
    expect((await settings(d)).hooks.Stop).toHaveLength(1)
  })

  it('preserves every other setting and every other hook', async () => {
    const d = await dir()
    await mkdir(join(d, '.claude'), { recursive: true })
    await writeFile(join(d, '.claude/settings.json'), JSON.stringify({
      model: 'opus', permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'make lint' }] }] },
    }), 'utf8')
    await installHook(d)
    const s = await settings(d)
    expect(s.model).toBe('opus')
    expect(s.permissions.allow).toEqual(['Bash(ls:*)'])
    expect(JSON.stringify(s)).toContain('make lint')
    expect(JSON.stringify(s)).toContain('nonexistent-appguide-offline-spec since')
  })

  it('removes only its own entry', async () => {
    const d = await dir()
    await mkdir(join(d, '.claude'), { recursive: true })
    await writeFile(join(d, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'make lint' }] }] },
    }), 'utf8')
    await installHook(d)
    expect((await installHook(d, true)).outcome).toBe('removed')
    const s = await settings(d)
    expect(JSON.stringify(s)).toContain('make lint')
    expect(JSON.stringify(s)).not.toContain('appguide')
  })

  it('refuses to clobber a settings file it cannot parse', async () => {
    const d = await dir()
    await mkdir(join(d, '.claude'), { recursive: true })
    await writeFile(join(d, '.claude/settings.json'), '{ broken', 'utf8')
    await expect(installHook(d)).rejects.toThrow(/not valid JSON/)
    expect(await readFile(join(d, '.claude/settings.json'), 'utf8')).toBe('{ broken')
  })
})
