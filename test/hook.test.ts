import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIgnored, installHook, isAppguideCommand } from '../src/hook/install.js'
import { readConfig, writeConfig } from '../src/config.js'

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

describe('removing and switching, whatever voice it was installed in', () => {
  it('removes a plain-voice hook when uninstalled without --plain', async () => {
    const d = await dir()
    await installHook(d, false, true)
    expect((await installHook(d, true, false)).outcome).toBe('removed')
    expect(JSON.stringify(await settings(d))).not.toContain(' since')
  })

  it('replaces the hook when the voice changes, instead of adding a second', async () => {
    const d = await dir()
    await installHook(d, false, false)
    await installHook(d, false, true)
    const commands: string[] = (await settings(d)).hooks.Stop.flatMap((m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command))
    const ours = commands.filter((c) => c.includes(' since'))
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain('--plain')
  })

  it('recognises its own command however it was installed', () => {
    expect(isAppguideCommand('npx --yes github:AniketTati/App-Guide since --plain')).toBe(true)
    expect(isAppguideCommand('npx appguide since')).toBe(true)
    expect(isAppguideCommand('node dist/cli.js since')).toBe(true)
    expect(isAppguideCommand('make lint')).toBe(false)
  })
})

describe("keeping appguide's notes out of the user's commits", () => {
  it('adds .appguide/ to an existing .gitignore, once', async () => {
    const d = await dir()
    await writeFile(join(d, '.gitignore'), 'node_modules\n', 'utf8')
    expect(await ensureIgnored(d)).toBe('added')
    expect(await ensureIgnored(d)).toBe('present')
    expect((await readFile(join(d, '.gitignore'), 'utf8')).match(/^\.appguide\/$/gm)).toHaveLength(1)
  })

  it('does not create a .gitignore that was not there', async () => {
    const d = await dir()
    expect(await ensureIgnored(d)).toBe('none')
    await expect(readFile(join(d, '.gitignore'), 'utf8')).rejects.toThrow()
  })
})

describe('remembering how it was installed', () => {
  it('round-trips the voice and the command, keeping keys it does not know', async () => {
    const d = await dir()
    await mkdir(join(d, '.appguide'), { recursive: true })
    await writeFile(join(d, '.appguide/config.json'), '{"future":1}')
    await writeConfig(d, { plain: true, run: 'npx --yes github:AniketTati/App-Guide' })
    expect(await readConfig(d)).toEqual({ plain: true, run: 'npx --yes github:AniketTati/App-Guide' })
    expect(JSON.parse(await readFile(join(d, '.appguide/config.json'), 'utf8')).future).toBe(1)
  })
})

