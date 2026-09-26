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
  '__generated__', 'generated', '__pycache__', 'site-packages',
])

/**
 * Code this tool does not parse, counted so that a repository written in it is
 * told so. Without this, a Python service reported zero routes and zero data
 * changes, said nothing about why, and its all-clear read as a clean bill of
 * health.
 */
const UNREAD: Readonly<Record<string, string>> = {
  py: 'Python', go: 'Go', rb: 'Ruby', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  php: 'PHP', cs: 'C#', swift: 'Swift', scala: 'Scala', ex: 'Elixir', exs: 'Elixir',
  dart: 'Dart', vue: 'Vue components', svelte: 'Svelte components',
}

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
  /** Every package.json outside skipped directories, repo-relative and sorted:
   *  a workspace declares its dependencies in its members, not its root. */
  manifests: string[]
  /** Every tsconfig/jsconfig, repo-relative and sorted: their "paths" say which
   *  imports are the project's own folders rather than packages. */
  configs: string[]
  /** Languages present but not parsed: how many files, and the first one. */
  unread: Map<string, { count: number; first: string }>
}

export async function discover(root: string): Promise<Discovery> {
  const out: Discovery = { files: [], gaps: [], manifests: [], configs: [], unread: new Map() }
  await walk(root, root, out, new Set())
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  out.files.sort((a, b) => byPath(a.path, b.path))
  out.manifests.sort(byPath)
  out.configs.sort(byPath)
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
  // A Python virtual environment is installed libraries, not the project's code.
  // It can be named anything, but it always has this file at its top.
  if (dir !== root && entries.some((e) => e.name === 'pyvenv.cfg')) return
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
    } else if (isFile && entry.name === 'package.json') {
      out.manifests.push(toPosix(relative(root, full)))
    } else if (isFile && /^[tj]sconfig(\..+)?\.json$/.test(entry.name)) {
      out.configs.push(toPosix(relative(root, full)))
    } else if (isFile) {
      const language = UNREAD[entry.name.slice(entry.name.lastIndexOf('.') + 1)]
      if (language !== undefined && entry.name.includes('.')) {
        const path = toPosix(relative(root, full))
        const seen = out.unread.get(language)
        if (seen === undefined) out.unread.set(language, { count: 1, first: path })
        else { seen.count++; if (path < seen.first) seen.first = path }
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
    // An npm scope always has a name. `@/components` is the project's own
    // folder behind a path alias — reading it as a package reported seven
    // "imported but not in package.json" false alarms in one real app.
    if (parts.length < 2 || parts[0] === '@' || parts[1] === undefined || parts[1] === '') return null
    return `${parts[0]}/${parts[1]}`
  }
  const first = parts[0]
  // `~/x` and `#x` are aliases and subpath imports, never package names.
  return first === undefined || first === '' || first === '~' || first.startsWith('#') ? null : first
}
