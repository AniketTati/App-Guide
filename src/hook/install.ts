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
/** The same, for the hook itself: Claude Code runs hooks in whatever folder
 *  Claude last moved into, where a relative dist/cli.js does not exist. */
const LOCAL_HOOK_BASE = 'node "${CLAUDE_PROJECT_DIR:-.}/dist/cli.js"'

/**
 * Hands a pending report to Claude with the person's next message, then deletes
 * it so it is handed over once. Plain shell and no network: a UserPromptSubmit
 * hook blocks every prompt until it finishes, so it must never start npx.
 */
export const PROMPT_COMMAND =
  "sh -c 'f=\"${CLAUDE_PROJECT_DIR:-.}/.appguide/pending\"; if [ -f \"$f\" ]; then cat \"$f\"; rm -f \"$f\"; fi'"

interface HookEntry { type?: string; command?: string; timeout?: number }
interface Matcher { matcher?: string; hooks?: HookEntry[] }
interface Settings { hooks?: Record<string, Matcher[]> }

export type Outcome = 'installed' | 'already-installed' | 'removed' | 'not-installed'

export interface InstallResult {
  outcome: Outcome
  path: string
  /** The Stop hook command. */
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
 * essential or forgettable. Two hooks: Stop shows the receipt to the person,
 * UserPromptSubmit hands Claude its copy.
 */
export async function installHook(root: string, remove = false, plain = false): Promise<InstallResult> {
  const path = join(root, ...SETTINGS)
  const settings = await readSettings(path)
  // The voice is chosen once, at install, so nobody has to remember a flag.
  const base = await runBase(root)
  const command = `${base === LOCAL_BASE ? LOCAL_HOOK_BASE : base} since --hook${plain ? ' --plain' : ''}`

  // Match any appguide hook, not this exact string. Matching exactly meant a
  // hook installed with --plain could not be removed without --plain — it said
  // "nothing to remove" and kept running — and changing voice added a second.
  const stop = settings.hooks?.['Stop'] ?? []
  const prompt = settings.hooks?.['UserPromptSubmit'] ?? []
  const stopOurs = (h: HookEntry): boolean => isAppguideCommand(h.command ?? '')
  const promptOurs = (h: HookEntry): boolean => isAppguidePrompt(h.command ?? '')
  const existingStop = stop.flatMap((m) => m.hooks ?? []).filter(stopOurs)
  const existingPrompt = prompt.flatMap((m) => m.hooks ?? []).filter(promptOurs)
  const stopWithout = strip(stop, stopOurs)
  const promptWithout = strip(prompt, promptOurs)

  if (remove) {
    if (existingStop.length === 0 && existingPrompt.length === 0) return { outcome: 'not-installed', path, command, base }
    await writeSettings(path, withHooks(settings, { Stop: stopWithout, UserPromptSubmit: promptWithout }))
    return { outcome: 'removed', path, command, base }
  }

  const check = await verify(root, base)
  const current =
    existingStop.length === 1 && existingStop[0]?.command === command &&
    existingPrompt.length === 1 && existingPrompt[0]?.command === PROMPT_COMMAND
  if (current) return { outcome: 'already-installed', path, command, base, ...check }

  await writeSettings(path, withHooks(settings, {
    // Long timeout: the very first fetch from GitHub clones and builds.
    Stop: [...stopWithout, { matcher: '', hooks: [{ type: 'command', command, timeout: 120 }] }],
    // Short timeout: it is a cat, and it blocks the person's prompt while it runs.
    UserPromptSubmit: [...promptWithout, { hooks: [{ type: 'command', command: PROMPT_COMMAND, timeout: 10 }] }],
  }))
  return { outcome: 'installed', path, command, base, ...check }
}

/** The invocation someone should be told to run — the same one the hook uses. */
export async function runBase(root: string): Promise<string> {
  return (await isSelf(root)) ? LOCAL_BASE : npxBase()
}

/** Any appguide Stop invocation, however it was installed or voiced. */
export function isAppguideCommand(command: string): boolean {
  return / since(\s|$)/.test(command) && /(\bappguide\b|App-Guide|dist\/cli\.js)/.test(command)
}

/** The prompt hook that hands the pending report to Claude. */
export const isAppguidePrompt = (command: string): boolean => command.includes('.appguide/pending')

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

const strip = (matchers: readonly Matcher[], ours: (h: HookEntry) => boolean): Matcher[] =>
  matchers
    .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !ours(h)) }))
    .filter((m) => (m.hooks ?? []).length > 0)

/** Preserves every other key and every other event, so installing never
 *  clobbers a user's settings. */
function withHooks(settings: Settings, updates: Record<string, Matcher[]>): Settings {
  const hooks: Record<string, Matcher[]> = { ...(settings.hooks ?? {}) }
  for (const [event, matchers] of Object.entries(updates)) {
    if (matchers.length === 0) delete hooks[event]
    else hooks[event] = matchers
  }
  if (Object.keys(hooks).length > 0) return { ...settings, hooks }
  const { hooks: _dropped, ...rest } = settings
  return rest
}

/** Run the exact invocation the hook will use, once, before claiming anything. */
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

async function readSettings(path: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Settings
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Never overwrite a settings file we could not understand.
    throw new Error(`${path} exists but is not valid JSON — fix it, or add the hook by hand:\n  ${npxBase()} since --hook`)
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
