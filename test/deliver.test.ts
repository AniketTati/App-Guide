import { beforeAll, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/run.js'
import { renderTerminal } from '../src/render/terminal.js'
import { setColor } from '../src/render/ansi.js'
import { clearDelivery, deliverFromStop, pendingPath } from '../src/hook/deliver.js'

beforeAll(() => setColor(false))

const COMMAND = 'npx --yes github:AniketTati/App-Guide'

async function app() {
  const dir = await mkdtemp(join(tmpdir(), 'deliver-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}')
  const guarded = Array.from({ length: 5 }, (_, i) => `app.get('/g${i}', requireAuth, h)`).join('\n')
  await writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}`)
  await run({ root: dir, mark: true })
  const change = (extra: string) => writeFile(join(dir, 'src/api.ts'), `const app = express()\n${guarded}\n${extra}\n`)
  return { dir, change }
}

/** What the installed Stop hook does, minus the process boundary. */
async function stopHook(dir: string): Promise<string> {
  const report = await run({ root: dir, mark: false, voice: 'plain' })
  const receipt = renderTerminal(report, { voice: 'plain', columns: 80, command: COMMAND })
  return deliverFromStop(dir, report, receipt, COMMAND)
}

describe('getting the receipt to a person inside Claude Code', () => {
  it('prints only a JSON object, carrying the receipt as a systemMessage', async () => {
    const { dir, change } = await app()
    await change("app.delete('/admin/purge', h)")
    const out = await stopHook(dir)
    // Claude Code parses stdout as JSON only when it starts with { and ends with }.
    expect(out.startsWith('{') && out.endsWith('}')).toBe(true)
    const parsed = JSON.parse(out)
    expect(parsed.systemMessage).toContain('DELETE /admin/purge')
    // Never Stop's decision or additionalContext: both make Claude keep working.
    expect(parsed).not.toHaveProperty('decision')
    expect(parsed).not.toHaveProperty('hookSpecificOutput')
    // A desktop notification, for someone away from the machine.
    expect(parsed.terminalSequence).toMatch(/^\x1b\]9;appguide: /)
  })

  it('leaves a copy for Claude that says what #1 means, how to clear it, and not to act unprompted', async () => {
    const { dir, change } = await app()
    await change("app.delete('/admin/purge', h)")
    await stopHook(dir)
    const pending = await readFile(pendingPath(dir), 'utf8')
    expect(pending).toContain('#1')
    expect(pending).toContain(`${COMMAND} seen`)
    expect(pending).toContain(`${COMMAND} ask <number>`)
    expect(pending).toContain('Do not act on this report unless the user asks')
  })

  it('says it once, not after every reply, while nothing new happens', async () => {
    const { dir, change } = await app()
    await change("app.delete('/admin/purge', h)")
    expect(await stopHook(dir)).not.toBe('')
    expect(await stopHook(dir)).toBe('')
    expect(await stopHook(dir)).toBe('')
  })

  it('speaks again as soon as something new happens', async () => {
    const { dir, change } = await app()
    await change("app.delete('/admin/purge', h)")
    await stopHook(dir)
    await change("app.delete('/admin/purge', h)\napp.post('/admin/wipe', h)")
    const again = await stopHook(dir)
    expect(JSON.parse(again).systemMessage).toContain('/admin/wipe')
  })

  it('leaves nothing for Claude when there is nothing to report', async () => {
    const { dir } = await app()
    await stopHook(dir)
    await expect(access(pendingPath(dir))).rejects.toThrow()
  })

  it('starts fresh after the person says they are done looking', async () => {
    const { dir, change } = await app()
    await change("app.delete('/admin/purge', h)")
    await stopHook(dir)
    await run({ root: dir, mark: true })
    await clearDelivery(dir)
    await expect(access(pendingPath(dir))).rejects.toThrow()
    expect(JSON.parse(await stopHook(dir)).systemMessage).toContain('nothing new')
  })
})
