import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Config {
  /** Everyday language instead of jargon. Set once, usually at install. */
  plain: boolean
}

const DEFAULTS: Config = { plain: false }

/** Optional. The tool works with no config at all; this only records a choice
 *  already made, so it never has to be made again. */
export async function readConfig(root: string): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(join(root, '.appguide.json'), 'utf8')) as Partial<Config>
    return { ...DEFAULTS, plain: raw.plain === true }
  } catch {
    return DEFAULTS
  }
}
