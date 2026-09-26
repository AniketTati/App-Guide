import { posix } from 'node:path'
import { ts } from 'ts-morph'
import type { ParsedFile } from '../extract/parse.js'

/**
 * Which file an import names — relative paths, a tsconfig's `paths` aliases
 * (`@/pages/X`), and workspace packages by name (`@clm/types`). Everything is
 * resolved against the files already read; nothing touches the disk.
 */
export interface Resolver {
  resolve(from: string, specifier: string): string | null
  file(path: string): ParsedFile | undefined
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

interface Alias { dir: string; pattern: string; targets: string[] }

export function resolver(files: readonly ParsedFile[], configs: ReadonlyMap<string, string>, manifests: ReadonlyMap<string, string>): Resolver {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const exists = (p: string): string | null => {
    const stem = p.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '')
    for (const c of [p, ...EXTENSIONS.map((e) => `${stem}${e}`), ...EXTENSIONS.map((e) => `${p}/index${e}`)]) if (byPath.has(c)) return c
    return null
  }

  // Aliases from every tsconfig: `"@/*": ["./src/*"]`, relative to its baseUrl.
  const aliases: Alias[] = []
  for (const [path, text] of configs) {
    const { config } = ts.parseConfigFileTextToJson(path, text)
    const options = (config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined)?.compilerOptions
    if (options?.paths === undefined) continue
    const dir = posix.dirname(path)
    const base = posix.normalize(posix.join(dir, options.baseUrl ?? '.'))
    for (const [pattern, targets] of Object.entries(options.paths)) {
      aliases.push({ dir: dir === '.' ? '' : dir, pattern, targets: targets.map((t) => posix.normalize(posix.join(base, t))) })
    }
  }
  // The config nearest the importing file wins.
  aliases.sort((a, b) => b.dir.length - a.dir.length)

  // Workspace packages by name, to the file their manifest points at.
  const packages = new Map<string, string>()
  for (const [path, text] of manifests) {
    try {
      const m = JSON.parse(text) as { name?: string; main?: string; types?: string; module?: string; exports?: unknown }
      if (typeof m.name !== 'string') continue
      const dir = posix.dirname(path)
      const exported = typeof m.exports === 'string' ? m.exports
        : (m.exports as Record<string, unknown> | undefined)?.['.'] !== undefined ? pick((m.exports as Record<string, unknown>)['.']) : undefined
      const entry = exported ?? m.types ?? m.module ?? m.main ?? 'index'
      packages.set(m.name, posix.normalize(posix.join(dir === '.' ? '' : dir, entry)))
    } catch {
      // a manifest we cannot read names no package
    }
  }

  return {
    file: (p) => byPath.get(p),
    resolve(from, specifier) {
      if (specifier.startsWith('.')) return exists(posix.normalize(posix.join(posix.dirname(from), specifier)))
      for (const a of aliases) {
        if (a.dir !== '' && !from.startsWith(`${a.dir}/`)) continue
        const star = a.pattern.endsWith('*')
        const head = star ? a.pattern.slice(0, -1) : a.pattern
        if (star ? !specifier.startsWith(head) : specifier !== head) continue
        const rest = star ? specifier.slice(head.length) : ''
        for (const t of a.targets) {
          const hit = exists(star ? t.replace(/\*$/, rest) : t)
          if (hit !== null) return hit
        }
      }
      const pkg = packages.get(specifier)
      if (pkg !== undefined) return exists(pkg)
      return null
    },
  }
}

function pick(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const e = entry as Record<string, unknown>
    for (const k of ['types', 'import', 'default', 'require']) { const v = pick(e[k]); if (v !== undefined) return v }
  }
  return undefined
}

/** Local name -> resolved file and the name it has there ('default' for a default import). */
export function importsOf(file: ParsedFile, r: Resolver): Map<string, { path: string; name: string }> {
  const out = new Map<string, { path: string; name: string }>()
  for (const stmt of file.ast.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteralLike(stmt.moduleSpecifier) || stmt.importClause === undefined) continue
    const target = r.resolve(file.path, stmt.moduleSpecifier.text)
    if (target === null) continue
    const clause = stmt.importClause
    if (clause.name !== undefined) out.set(clause.name.text, { path: target, name: 'default' })
    const named = clause.namedBindings
    if (named !== undefined && ts.isNamedImports(named)) for (const el of named.elements) out.set(el.name.text, { path: target, name: (el.propertyName ?? el.name).text })
  }
  // `const X = lazy(() => import('./pages/X'))`
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const spec = dynamicImport(node.initializer)
      const target = spec === null ? null : r.resolve(file.path, spec)
      if (target !== null) out.set(node.name.text, { path: target, name: 'default' })
    }
    ts.forEachChild(node, visit)
  }
  visit(file.ast)
  return out
}

function dynamicImport(expr: ts.Expression): string | null {
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (found !== null) return
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) found = node.arguments[0].text
    else ts.forEachChild(node, visit)
  }
  visit(expr)
  return found
}
