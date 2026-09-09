import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import { discover, packageOf, type SourceFile } from './files.js'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/**
 * Frameworks we have no extractor for. Declaring these is what stops coverage
 * reading 94% while missing 100% of the routes — silence is the failure mode
 * this tool exists to prevent.
 */
const UNSUPPORTED: Record<string, string> = {
  '@trpc/server': 'routes',
  hono: 'routes',
  fastify: 'routes',
  '@nestjs/core': 'routes',
  '@hapi/hapi': 'routes',
  koa: 'routes',
  'drizzle-orm': 'data writes',
  '@prisma/client': 'data writes',
  typeorm: 'data writes',
  sequelize: 'data writes',
  mongoose: 'data writes',
  knex: 'data writes',
}

export interface LibraryScan {
  facts: Fact[]
  files: SourceFile[]
  /** package -> files importing it, for reuse by later extractors */
  importers: Map<string, string[]>
}

export async function scanLibraries(root: string): Promise<LibraryScan> {
  const { files, gaps } = await discover(root)
  const manifest = await readManifest(root)
  const declared = new Map<string, { range: string; dev: boolean }>()

  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      if (!declared.has(name)) declared.set(name, { range, dev: false })
    }
  }
  for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
    if (!declared.has(name)) declared.set(name, { range, dev: true })
  }

  const importers = new Map<string, string[]>()
  const facts: Fact[] = [...gaps, ...manifest.__gaps]

  for (const file of files) {
    let specifiers: readonly string[]
    try {
      // preProcessFile is TypeScript's own dependency scanner — correct about
      // comments and strings without paying for a full parse or a type checker.
      specifiers = ts.preProcessFile(file.text, true, true).importedFiles.map((f) => f.fileName)
    } catch {
      facts.push({
        kind: 'gap', reason: 'parse-error', subject: file.path,
        detail: 'could not be scanned for imports',
        where: { file: file.path, line: 1 },
      })
      continue
    }
    for (const specifier of specifiers) {
      const pkg = packageOf(specifier)
      if (pkg === null) continue
      const list = importers.get(pkg)
      if (list) { if (!list.includes(file.path)) list.push(file.path) }
      else importers.set(pkg, [file.path])
    }
  }

  for (const [name, list] of [...importers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const known = declared.get(name)
    facts.push({
      kind: 'library',
      name,
      // The installed version, not the declared range: a lockfile-only bump
      // inside `^2.6.7` is exactly the supply-chain event worth catching, and
      // a range would report it as no change at all.
      version: (await installedVersion(root, name)) ?? known?.range ?? 'unknown',
      direct: known !== undefined,
      importers: list.sort(),
      where: { file: 'package.json', line: 1 },
    })
    if (known === undefined) {
      // Imported but declared nowhere. Far more interesting than "transitive",
      // which is what an earlier version called it.
      facts.push({
        kind: 'gap', reason: 'unresolved-import', subject: name,
        detail: 'imported but not in package.json',
        where: { file: list[0] ?? 'package.json', line: 1 },
      })
    }
  }

  // Declared but never imported. Reported as a fact so it can be diffed like
  // anything else, rather than as a special-cased warning.
  for (const [name, meta] of declared) {
    if (importers.has(name)) continue
    facts.push({
      kind: 'library', name,
      version: (await installedVersion(root, name)) ?? meta.range,
      direct: true, importers: [], where: { file: 'package.json', line: 1 },
    })
  }

  for (const [pkg, what] of Object.entries(UNSUPPORTED)) {
    if (!declared.has(pkg)) continue
    facts.push({
      kind: 'gap', reason: 'unsupported-framework', subject: pkg,
      detail: `no extractor — ${what} from ${pkg} are not listed`,
      where: { file: 'package.json', line: 1 },
    })
  }

  return { facts, files, importers }
}

/**
 * An unreadable manifest must never fail into the same shape as an empty one.
 * Silently returning {} erases the entire unsupported-framework declaration and
 * substitutes a confident all-clear — the exact silence this tool exists to
 * prevent, caused by a trailing comma.
 */
async function readManifest(root: string): Promise<PackageJson & { __gaps: Fact[] }> {
  const path = join(root, 'package.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      __gaps: [{
        kind: 'gap', reason: 'parse-error', subject: 'package.json',
        detail: missing ? 'no package.json here — dependencies cannot be checked' : 'package.json could not be read',
        where: { file: 'package.json', line: 1 },
      }],
    }
  }
  try {
    return { ...(JSON.parse(text) as PackageJson), __gaps: [] }
  } catch (err) {
    return {
      __gaps: [{
        kind: 'gap', reason: 'parse-error', subject: 'package.json',
        detail: `package.json is not valid JSON (${(err as Error).message.split('\n')[0]}) — dependencies cannot be checked`,
        where: { file: 'package.json', line: 1 },
      }],
    }
  }
}

const versionCache = new Map<string, string | null>()

async function installedVersion(root: string, name: string): Promise<string | null> {
  const key = `${root}\u0000${name}`
  const hit = versionCache.get(key)
  if (hit !== undefined) return hit
  let found: string | null = null
  try {
    const text = await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')
    const v = (JSON.parse(text) as { version?: unknown }).version
    found = typeof v === 'string' ? v : null
  } catch {
    found = null
  }
  versionCache.set(key, found)
  return found
}
