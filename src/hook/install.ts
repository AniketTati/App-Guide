import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const SETTINGS = ['.claude', 'settings.json']
const NPX = 'npx appguide since'
const LOCAL = 'node dist/cli.js since'

interface HookEntry { type?: string; command?: string }
interface Matcher { matcher?: string; hooks?: HookEntry[] }
interface Settings { hooks?: Record<string, Matcher[]> & { Stop?: Matcher[] } }

export type Outcome = 'installed' | 'already-installed' | 'removed' | 'not-installed'

/**
 * The smallest artifact in the plan, and the one that decides whether this is
 * essential or forgettable. A tool you must remember to run, answering a
 * question you did not know you had, gets run three times and abandoned.
 */
export async function installHook(root: string, remove = false): Promise<{ outcome: Outcome; path: string }> {
  const path = join(root, ...SETTINGS)
  const settings = await readSettings(path)
  // In our own repo, point at the local build. Otherwise the hook would shell
  // out to npm for a package that is right here, and dogfooding is the gate
  // this whole stage exists to make measurable.
  const command = (await isSelf(root)) ? LOCAL : NPX

  const stop = settings.hooks?.Stop ?? []
  const has = stop.some((m) => m.hooks?.some((h) => h.command === command))

  if (remove) {
    if (!has) return { outcome: 'not-installed', path }
    const pruned = stop
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => h.command !== command) }))
      .filter((m) => (m.hooks ?? []).length > 0)
    await writeSettings(path, withStop(settings, pruned))
    return { outcome: 'removed', path }
  }

  if (has) return { outcome: 'already-installed', path }
  await writeSettings(path, withStop(settings, [...stop, { matcher: '', hooks: [{ type: 'command', command }] }]))
  return { outcome: 'installed', path }
}

/** Preserves every other key, so installing never clobbers a user's settings. */
function withStop(settings: Settings, stop: Matcher[]): Settings {
  const hooks = { ...(settings.hooks ?? {}) }
  if (stop.length === 0) delete hooks['Stop']
  else hooks['Stop'] = stop
  if (Object.keys(hooks).length > 0) return { ...settings, hooks }
  const { hooks: _dropped, ...rest } = settings
  return rest
}

async function isSelf(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown }
    return pkg.name === 'appguide'
  } catch {
    return false
  }
}

async function readSettings(path: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Settings
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Never overwrite a settings file we could not understand.
    throw new Error(`${path} exists but is not valid JSON — fix it, or add the hook by hand:\n  ${NPX}`)
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const clean = JSON.parse(JSON.stringify(settings)) as Settings
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
