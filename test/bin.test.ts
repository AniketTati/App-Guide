import { describe, expect, it, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, symlink, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const dist = resolve('dist/cli.js')

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
})
