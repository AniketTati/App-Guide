import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Fact } from '../model/facts.js'

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

export interface Discovery {
  files: SourceFile[]
  /** Every path we could not read. Never dropped — an unreadable directory is
   *  a hole in an exhaustive claim, and this tool's value is that its negatives
   *  are complete. */
  gaps: Fact[]
}

export async function discover(root: string): Promise<Discovery> {
  const out: Discovery = { files: [], gaps: [] }
  await walk(root, root, out, new Set())
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

async function walk(root: string, dir: string, out: Discovery, seen: Set<string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    out.gaps.push(gap(root, dir, `directory could not be read: ${(err as NodeJS.ErrnoException).code ?? 'error'}`))
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()

    // readdir reports a symlink as neither. Follow it, but only once per real
    // path, or a cycle walks forever.
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(full)
        isDir = target.isDirectory()
        isFile = target.isFile()
        if (isDir) {
          if (seen.has(full)) continue
          seen.add(full)
        }
      } catch {
        out.gaps.push(gap(root, full, 'symlink target could not be read'))
        continue
      }
    }

    if (isDir) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(root, full, out, seen)
    } else if (isFile && SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
      try {
        out.files.push({ path: toPosix(relative(root, full)), text: await readFile(full, 'utf8') })
      } catch (err) {
        out.gaps.push(gap(root, full, `file could not be read: ${(err as NodeJS.ErrnoException).code ?? 'error'}`))
      }
    }
  }
}

const gap = (root: string, path: string, detail: string): Fact => ({
  kind: 'gap',
  reason: 'parse-error',
  subject: toPosix(relative(root, path)) || '.',
  detail,
  where: { file: toPosix(relative(root, path)) || '.', line: 1 },
})

/** Only Windows uses backslash as a separator; on POSIX it is a legal filename
 *  character and rewriting it would invent a directory that does not exist. */
const toPosix = (p: string): string => (sep === '\\' ? p.split('\\').join('/') : p)

/**
 * Maps an import specifier to the package that owns it.
 *   'react'              -> 'react'
 *   'lodash/get'         -> 'lodash'
 *   '@scope/pkg/sub'     -> '@scope/pkg'
 *   './local', 'node:fs' -> null
 */
export function packageOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null
  // Runtime builtins across every host, not just Node. Treating `bun:sqlite`
  // as a package invents a dependency that does not exist.
  if (/^[a-z][a-z0-9.+-]*:/i.test(specifier)) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2 || parts[1] === undefined || parts[1] === '') return null
    return `${parts[0]}/${parts[1]}`
  }
  const first = parts[0]
  return first === undefined || first === '' ? null : first
}
