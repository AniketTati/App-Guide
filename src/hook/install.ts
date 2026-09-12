import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const SETTINGS = ['.claude', 'settings.json']
/**
 * Where the hook fetches appguide from. Until the package is on npm this is the
 * public GitHub repo, which npx can run directly. When it is published, this is
 * the one line that changes. APPGUIDE_SPEC overrides it.
 *
 * `--yes` because a hook is non-interactive: an npx install prompt there hangs
 * the end of every session.
 */
export const DEFAULT_SPEC = 'github:AniketTati/App-Guide'
const npxBase = (): string => `npx --yes ${process.env['APPGUIDE_SPEC'] ?? DEFAULT_SPEC}`
const LOCAL_BASE = 'node dist/cli.js'

interface HookEntry { type?: string; command?: string }
interface Matcher { matcher?: string; hooks?: HookEntry[] }
interface Settings { hooks?: Record<string, Matcher[]> & { Stop?: Matcher[] } }

export type Outcome = 'installed' | 'already-installed' | 'removed' | 'not-installed'

export interface InstallResult {
  outcome: Outcome
  path: string
  command: string
  /** The invocation without a subcommand — what to tell someone to run. */
  base: string
  /** Whether the command we just wrote actually runs. Saying "Done" over a
   *  hook that emits an npm 404 after every session is worse than saying
   *  nothing — it spends the one moment the reader was paying attention. */
  verified?: boolean
  problem?: string
}

/**
 * The smallest artifact in the plan, and the one that decides whether this is
 * essential or forgettable. A tool you must remember to run, answering a
 * question you did not know you had, gets run three times and abandoned.
 */
export async function installHook(root: string, remove = false, plain = false): Promise<InstallResult> {
  const path = join(root, ...SETTINGS)
  const settings = await readSettings(path)
  // In our own repo, point at the local build. Otherwise the hook would shell
  // out to npm for a package that is right here, and dogfooding is the gate
  // this whole stage exists to make measurable.
  // The voice is chosen once, at install, so nobody has to remember a flag.
  const base = await runBase(root)
  const command = `${base} since${plain ? ' --plain' : ''}`

  const stop = settings.hooks?.Stop ?? []
  // Match any appguide hook, not this exact string. Matching exactly meant a
  // hook installed with --plain could not be removed without --plain — it said
  // "nothing to remove" and kept running — and changing voice added a second.
  const ours = (h: HookEntry): boolean => isAppguideCommand(h.command ?? '')
  const existing = stop.flatMap((m) => m.hooks ?? []).filter(ours)
  const without = stop
    .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !ours(h)) }))
    .filter((m) => (m.hooks ?? []).length > 0)

  if (remove) {
    if (existing.length === 0) return { outcome: 'not-installed', path, command, base }
    await writeSettings(path, withStop(settings, without))
    return { outcome: 'removed', path, command, base }
  }

  const check = await verify(root, base)
  if (existing.length === 1 && existing[0]?.command === command) {
    return { outcome: 'already-installed', path, command, base, ...check }
  }
  await writeSettings(path, withStop(settings, [...without, { matcher: '', hooks: [{ type: 'command', command }] }]))
  return { outcome: 'installed', path, command, base, ...check }
}

/** Run the exact invocation the hook will use, once, before claiming anything.
 *  Built from the base rather than by slicing the finished command, which
 *  only worked because --version happens to short-circuit. */
async function verify(root: string, base: string): Promise<{ verified: boolean; problem?: string }> {
  const [bin, ...args] = base.split(' ')
  if (bin === undefined) return { verified: false, problem: 'empty command' }
  try {
    // First fetch from GitHub is slow (a clone and a build); later runs use the cache.
    const { stdout } = await exec(bin, [...args, '--version'], { cwd: root, timeout: 180_000 })
    return /\d+\.\d+\.\d+/.test(stdout) ? { verified: true } : { verified: false, problem: 'it ran but did not report a version' }
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr ?? (err as Error).message
    return { verified: false, problem: detail.split('\n').find((l) => l.trim() !== '') ?? 'it did not run' }
  }
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

/** The invocation someone should be told to run — the same one the hook uses. */
export async function runBase(root: string): Promise<string> {
  return (await isSelf(root)) ? LOCAL_BASE : npxBase()
}

/** Any appguide invocation, however it was installed or voiced. */
export function isAppguideCommand(command: string): boolean {
  return / since(\s|$)/.test(command) && /(\bappguide\b|App-Guide|dist\/cli\.js)/.test(command)
}

/** Keeps appguide's notes out of the user's commits — but only edits a
 *  .gitignore that already exists, and never creates one uninvited. */
export async function ensureIgnored(root: string): Promise<'added' | 'present' | 'none'> {
  const path = join(root, '.gitignore')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return 'none'
  }
  if (/^\/?\.appguide\/?\s*$/m.test(text)) return 'present'
  const body = text.replace(/\s*$/, '')
  await writeFile(path, `${body === '' ? '' : `${body}\n\n`}# appguide's notes on your app (safe to delete)\n.appguide/\n`, 'utf8')
  return 'added'
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
    throw new Error(`${path} exists but is not valid JSON — fix it, or add the hook by hand:\n  ${npxBase()} since`)
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const clean = JSON.parse(JSON.stringify(settings)) as Settings
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
