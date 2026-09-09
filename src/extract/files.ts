import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Defaults exclude generated output. Without this, generated code drowns every
 * other signal — it is the single largest precision risk in the whole tool.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.appguide',
  '__generated__', 'generated',
])

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const DECLARATION = /\.d\.(ts|mts|cts)$/

export interface SourceFile {
  /** Repo-relative, posix separators. */
  path: string
  text: string
}

export async function discover(root: string): Promise<SourceFile[]> {
  const found: SourceFile[] = []
  await walk(root, root, found)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

async function walk(root: string, dir: string, out: SourceFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable directory is a gap, not a crash
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(root, full, out)
    } else if (entry.isFile() && SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
      try {
        out.push({ path: relative(root, full).split('\\').join('/'), text: await readFile(full, 'utf8') })
      } catch {
        // recorded as a parse-error gap by the caller
      }
    }
  }
}

/**
 * Maps an import specifier to the package that owns it.
 *   'react'              -> 'react'
 *   'lodash/get'         -> 'lodash'
 *   '@scope/pkg/sub'     -> '@scope/pkg'
 *   './local', 'node:fs' -> null
 */
export function packageOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0] ?? null
}
