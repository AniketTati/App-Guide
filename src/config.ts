import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface Config {
  /** Everyday language instead of jargon. Chosen once, at install. */
  plain: boolean
  /** The exact invocation appguide was installed with. Every instruction the
   *  tool prints names this — a bare `appguide` is on nobody's PATH. */
  run?: string
}

const DEFAULTS: Config = { plain: false }

/** Inside .appguide/, beside the mark, so ignoring that one folder keeps all of
 *  appguide's per-machine state out of the user's commits. */
export const configPath = (root: string): string => join(root, '.appguide', 'config.json')

/** Optional. The tool works with no config; this only records choices already
 *  made, so they never have to be made again. */
export async function readConfig(root: string): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(configPath(root), 'utf8')) as Record<string, unknown>
    return { plain: raw['plain'] === true, ...(typeof raw['run'] === 'string' ? { run: raw['run'] } : {}) }
  } catch {
    return DEFAULTS
  }
}

/** Merges into what is there, keeping keys this version does not know about. */
export async function writeConfig(root: string, update: Partial<Config>): Promise<void> {
  const path = configPath(root)
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    // first write
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
