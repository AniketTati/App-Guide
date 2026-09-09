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
  const files = await discover(root)
  const manifest = await readManifest(root)
  const declared = new Map<string, { version: string; direct: boolean }>()

  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    declared.set(name, { version, direct: true })
  }
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    if (!declared.has(name)) declared.set(name, { version, direct: true })
  }

  const importers = new Map<string, string[]>()
  const facts: Fact[] = []

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

  for (const [name, list] of [...importers].sort()) {
    const known = declared.get(name)
    facts.push({
      kind: 'library',
      name,
      version: known?.version ?? 'unknown',
      direct: known?.direct ?? false,
      importers: list.sort(),
      where: { file: 'package.json', line: 1 },
    })
  }

  // Declared but never imported. Reported as a fact so it can be diffed like
  // anything else, rather than as a special-cased warning.
  for (const [name, meta] of declared) {
    if (importers.has(name)) continue
    facts.push({
      kind: 'library', name, version: meta.version, direct: meta.direct,
      importers: [], where: { file: 'package.json', line: 1 },
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

async function readManifest(root: string): Promise<PackageJson> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return {}
  }
}
