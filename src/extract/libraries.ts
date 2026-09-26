import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
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
/** Frameworks a detector already handles — never declare these as blind spots. */
const SUPPORTED = new Set(['express', 'next', '@prisma/client', 'drizzle-orm'])

/**
 * Capabilities a package has that we do NOT read, even though we read something
 * else about it. Suppressing the whole package because one detector exists is
 * how a Pages Router app got an unqualified all-clear over its API surface.
 */
const PARTIAL: Record<string, string> = {
  next: 'Next middleware.ts matchers are not resolved, so route middleware shows as unresolved',
}

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
  /** Everything declared in any manifest, so a detector can tell if its
   *  framework is here. */
  declared: Set<string>
  /** Workspace members: every directory below the root with its own
   *  package.json, longest first. The root itself is not listed. */
  workspace: { dir: string; name: string }[]
}

interface Declared { range: string; dev: boolean; manifest: string; dir: string }

export async function scanLibraries(root: string): Promise<LibraryScan> {
  const { files, gaps, manifests, configs, unread } = await discover(root)
  const aliases = await aliasPrefixes(root, configs)
  const manifest = await readManifest(root)
  const facts: Fact[] = [...gaps, ...manifest.__gaps]

  // Every manifest in the workspace, not only the root's. A pnpm or npm
  // workspace declares its real dependencies in its members: reading only the
  // root reported every one of them as "imported but not in package.json" —
  // 84 false alarms in one real monorepo — and never noticed its frameworks,
  // so a Fastify API with ~290 routes got no blind spot at all.
  const sources: { dir: string; manifest: string; json: PackageJson }[] = [{ dir: '', manifest: 'package.json', json: manifest }]
  for (const path of manifests) {
    if (path === 'package.json') continue
    const member = await readMember(root, path)
    if ('gap' in member) facts.push(member.gap)
    else sources.push({ dir: path.slice(0, -'/package.json'.length), manifest: path, json: member.json })
  }

  // The root first, then members in path order: a package declared in several
  // places is credited to the first, so the choice is stable between runs.
  const declared = new Map<string, Declared>()
  for (const { dir, manifest: where, json } of sources) {
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [name, range] of Object.entries(json[group] ?? {})) {
        if (!declared.has(name)) declared.set(name, { range, dev: false, manifest: where, dir })
      }
    }
    for (const [name, range] of Object.entries(json.devDependencies ?? {})) {
      if (!declared.has(name)) declared.set(name, { range, dev: true, manifest: where, dir })
    }
  }

  const importers = new Map<string, string[]>()

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
      if (aliases.some((a) => (a.endsWith('/') ? specifier.startsWith(a) : specifier === a))) continue
      const pkg = packageOf(specifier)
      if (pkg === null) continue
      // Node's own modules imported without the node: prefix. `events` and
      // `buffer` are also npm packages, so a declared one still counts.
      if (BUILTINS.has(pkg) && !declared.has(pkg)) continue
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
      version: (await installedVersion(root, known?.dir ?? '', name)) ?? known?.range ?? 'unknown',
      direct: known !== undefined,
      importers: list.sort(),
      where: { file: known?.manifest ?? 'package.json', line: 1 },
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
      version: (await installedVersion(root, meta.dir, name)) ?? meta.range,
      direct: true, importers: [], where: { file: meta.manifest, line: 1 },
    })
  }

  for (const [pkg, detail] of Object.entries(PARTIAL)) {
    const meta = declared.get(pkg)
    if (meta === undefined) continue
    facts.push({
      kind: 'gap', reason: 'unsupported-framework', subject: pkg, detail,
      where: { file: meta.manifest, line: 1 },
    })
  }

  for (const [pkg, what] of Object.entries(UNSUPPORTED)) {
    const meta = declared.get(pkg)
    if (meta === undefined) continue
    if (SUPPORTED.has(pkg)) continue
    facts.push({
      kind: 'gap', reason: 'unsupported-framework', subject: pkg,
      detail: `no extractor — ${what} from ${pkg} are not listed`,
      where: { file: meta.manifest, line: 1 },
    })
  }

  for (const [language, { count, first }] of [...unread].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    facts.push({
      kind: 'gap', reason: 'unsupported-language', subject: language,
      detail: `${count} ${language} file${count === 1 ? '' : 's'} not read — routes, data and calls in them are not listed`,
      where: { file: first, line: 1 },
    })
  }

  const workspace = sources
    .filter((m) => m.dir !== '')
    .map((m) => ({ dir: m.dir, name: typeof (m.json as { name?: unknown }).name === 'string' ? (m.json as { name: string }).name : m.dir }))
    .sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1))
  return { facts, files, importers, declared: new Set(declared.keys()), workspace }
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules)

/**
 * Import prefixes that are the project's own folders, from every tsconfig or
 * jsconfig "paths": `"@components/*"` -> `@components/`, `"#lib"` -> `#lib`.
 * An unreadable config only means fewer aliases, never a failed scan.
 */
async function aliasPrefixes(root: string, configs: readonly string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const path of configs) {
    try {
      const { config } = ts.parseConfigFileTextToJson(path, await readFile(join(root, path), 'utf8'))
      const paths = (config as { compilerOptions?: { paths?: Record<string, unknown> } } | undefined)?.compilerOptions?.paths
      for (const key of Object.keys(paths ?? {})) out.add(key.endsWith('*') ? key.slice(0, -1) : key)
    } catch {
      // not our business to report a broken tsconfig
    }
  }
  return [...out].filter((a) => a !== '' && a !== '/')
}

/** A member manifest that cannot be read is a hole in the dependency list,
 *  reported where it is — never silently treated as empty. */
async function readMember(root: string, path: string): Promise<{ json: PackageJson } | { gap: Fact }> {
  try {
    return { json: JSON.parse(await readFile(join(root, path), 'utf8')) as PackageJson }
  } catch (err) {
    return {
      gap: {
        kind: 'gap', reason: 'parse-error', subject: path,
        detail: `${path} could not be read (${(err as Error).message.split('\n')[0]}) — its dependencies cannot be checked`,
        where: { file: path, line: 1 },
      },
    }
  }
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

/** The member's own node_modules first (pnpm links each member's dependencies
 *  there), then the root's. */
async function installedVersion(root: string, dir: string, name: string): Promise<string | null> {
  const key = `${root}\u0000${dir}\u0000${name}`
  const hit = versionCache.get(key)
  if (hit !== undefined) return hit
  let found: string | null = null
  for (const base of dir === '' ? [root] : [join(root, dir), root]) {
    try {
      const text = await readFile(join(base, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')
      const v = (JSON.parse(text) as { version?: unknown }).version
      found = typeof v === 'string' ? v : null
      if (found !== null) break
    } catch {
      // not installed here; try the next place
    }
  }
  versionCache.set(key, found)
  return found
}
