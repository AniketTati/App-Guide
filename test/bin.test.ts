import { describe, expect, it, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, symlink, mkdir, writeFile, access, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROMPT_COMMAND } from '../src/hook/install.js'

const run = promisify(execFile)
const dist = resolve('dist/cli.js')

/** A plain terminal's environment. A suite run from inside Claude Code
 *  inherits CLAUDE_PROJECT_DIR, which would quietly change what is tested. */
function terminal(): NodeJS.ProcessEnv {
  const { CLAUDE_PROJECT_DIR: _session, ...env } = process.env
  return env
}

/**
 * npm installs `bin` entries as symlinks, so process.argv[1] is the symlink
 * while import.meta.url is the realpath. A guard that compares them naively
 * makes the published binary exit 0 with no output — and inside a Stop hook,
 * silence is indistinguishable from "nothing new to the shape".
 *
 * No unit test can catch that. This one invokes the built file through a
 * symlink, which is the exact condition.
 */
describe('the binary, invoked the way npm invokes it', () => {
  beforeAll(async () => {
    await access(dist).catch(() => { throw new Error('run `pnpm build` first') })
  })

  it('produces output when called through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appguide-bin-'))
    const link = join(dir, 'appguide')
    await symlink(dist, link)
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"name":"x"}')
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 1')

    const { stdout } = await run(process.execPath, [link, 'since', '--no-color'], { cwd: dir })
    expect(stdout.trim()).not.toBe('')
    expect(stdout).toContain('appguide')
  })

  it('reports its version through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appguide-bin-'))
    const link = join(dir, 'appguide')
    await symlink(dist, link)
    const { stdout } = await run(process.execPath, [link, '--version'])
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('takes the first look at install, so the first session is already useful', async () => {
    // Without this, the reader's first session says "nothing to compare yet"
    // and only the second shows anything — one session too many for someone
    // deciding whether this is worth keeping.
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'appguide-onboard-')))
    await mkdir(join(dir, 'dist'), { recursive: true })
    await mkdir(join(dir, 'src'), { recursive: true })
    await symlink(dist, join(dir, 'dist/cli.js'))
    await writeFile(join(dir, 'package.json'), '{"name":"appguide"}')
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 1')

    const first = await run(process.execPath, [join(dir, 'dist/cli.js'), 'init-hook'], { cwd: dir, env: terminal() })
    expect(first.stdout).toContain('first mark taken')
    await access(join(dir, '.appguide/mark'))
    // Records the command that works here, so instructions never name one that doesn't.
    expect(JSON.parse(await readFile(join(dir, '.appguide/config.json'), 'utf8')).run).toBe('node dist/cli.js')

    // The hook it wrote runs from a subfolder, which is where Claude Code runs
    // it once Claude has cd'd into one — a bare dist/cli.js would not be found.
    const stop: string = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command
    const hooked = await run('sh', ['-c', stop], { cwd: join(dir, 'src'), env: { ...terminal(), CLAUDE_PROJECT_DIR: dir } })
    expect(JSON.parse(hooked.stdout).systemMessage).toContain('appguide')

    // A second install must not overwrite a mark with unseen changes behind it.
    const before = await readFile(join(dir, '.appguide/mark'), 'utf8')
    await writeFile(join(dir, 'src/b.ts'), 'export const b = 2')
    const again = await run(process.execPath, [join(dir, 'dist/cli.js'), 'init-hook'], { cwd: dir, env: terminal() })
    expect(again.stdout).toContain('existing mark kept')
    expect(await readFile(join(dir, '.appguide/mark'), 'utf8')).toBe(before)
  }, 60000)

  it('reports on the project, not the folder Claude moved into, from hook to "done looking"', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'appguide-cd-')))
    const sub = join(dir, 'src')
    await mkdir(sub, { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}')
    const guarded = Array.from({ length: 5 }, (_, i) => `app.get('/g${i}', requireAuth, h)`).join('\n')
    await writeFile(join(sub, 'api.ts'), `const app = express()\n${guarded}\n`)
    await run(process.execPath, [dist, 'seen'], { cwd: dir, env: terminal() })
    await writeFile(join(sub, 'api.ts'), `const app = express()\n${guarded}\napp.delete('/admin/purge', h)\n`)
    const inSession = { ...terminal(), CLAUDE_PROJECT_DIR: dir }

    // Claude has run `cd src`; Claude Code runs the Stop hook there.
    const stop = await run(process.execPath, [dist, 'since', '--hook'], { cwd: sub, env: inSession })
    expect(JSON.parse(stop.stdout).systemMessage).toContain('DELETE /admin/purge')
    // ...and the prompt hook, which reads the project, finds Claude's copy.
    const prompt = await run('sh', ['-c', PROMPT_COMMAND], { cwd: sub, env: inSession })
    expect(prompt.stdout).toContain('DELETE /admin/purge')

    // "Done looking", run from the same subfolder with no session variable.
    await run(process.execPath, [dist, 'seen'], { cwd: sub, env: terminal() })
    await expect(access(join(sub, '.appguide'))).rejects.toThrow()
    const next = await run(process.execPath, [dist, 'since', '--hook'], { cwd: sub, env: inSession })
    expect(JSON.parse(next.stdout).systemMessage).toContain('nothing new')
  }, 60000)
})
