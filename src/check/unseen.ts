import { isTestFile, UNREAD } from '../extract/files.js'

/**
 * What a piece of work changed that the structural read doesn't describe. A
 * change to the database schema, a migration, Python or deploy settings must
 * never come out as "nothing changed" — so each is named, and the Check's
 * all-clear is withheld while any is present.
 */
export interface Unseen {
  kind: 'schema' | 'migration' | 'language' | 'config'
  /** In the PM's words: "Python", "database migrations". */
  label: string
  files: string[]
}

const MIGRATION = /(^|\/)migrations?\/.+\.(sql|[cm]?[jt]s)$/i
const CONFIG = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|[^/]+\.(ya?ml|toml|tf|hcl)|\.github\/.+|\.env\.[^/]*example[^/]*|Procfile|nginx[^/]*\.conf|(vercel|netlify|railway|now|app)\.json)$/i
// Lockfiles record versions the package lists already say: not settings.
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock)$/

export function unseenChanges(changed: readonly string[]): Unseen[] {
  const groups = new Map<string, Unseen>()
  const add = (kind: Unseen['kind'], label: string, file: string): void => {
    const g = groups.get(label) ?? { kind, label, files: [] }
    g.files.push(file)
    groups.set(label, g)
  }
  for (const f of changed) {
    if (isTestFile(f) || LOCKFILE.test(f)) continue
    const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase()
    if (ext === 'prisma') add('schema', 'the database schema', f)
    else if (MIGRATION.test(f)) add('migration', 'database migrations', f)
    else if (UNREAD[ext] !== undefined) add('language', UNREAD[ext]!, f)
    else if (CONFIG.test(f)) add('config', 'deploy and build settings', f)
  }
  const order: Unseen['kind'][] = ['schema', 'migration', 'language', 'config']
  return [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.files.length - a.files.length)
}

/**
 * Prisma blocks by "model Contract" / "enum Role", whitespace and comments
 * ignored, so a reformat is not a change. A field whose type is another
 * model is a link Prisma keeps, not a column: a table that only gains a link
 * to a new one hasn't changed shape.
 */
export function prismaBlocks(text: string, models: ReadonlySet<string> = modelNames(text)): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^(model|enum|view|type|datasource|generator)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const lines = m[3]!.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => l !== '')
      .filter((l) => m[1] === 'enum' || !models.has((l.split(/\s+/)[1] ?? '').replace(/[[\]?]/g, '')))
    out.set(`${m[1]} ${m[2]}`, lines.join(' ').replace(/\s+/g, ' '))
  }
  return out
}

/** The names of the models (and views and types) a schema declares. */
export function modelNames(text: string): Set<string> {
  return new Set([...text.matchAll(/^(?:model|view|type)\s+(\w+)\s*\{/gm)].map((m) => m[1]!))
}

export interface SchemaChange {
  /** Tables (Prisma models) added, removed, or changed in shape. */
  tables: { added: string[]; removed: string[]; changed: string[] }
  /** Lists of allowed values (Prisma enums) added, removed or changed. */
  lists: { added: string[]; removed: string[]; changed: string[] }
  /** New migrations, named as their folders are, timestamps dropped. */
  migrations: string[]
  /** The schema's connection or generator settings changed. */
  settings: boolean
}

/** The schema's own words for what a piece of work changed in the database. */
export async function schemaChange(changed: readonly string[], before: (f: string) => Promise<string | null>, after: (f: string) => Promise<string | null>): Promise<SchemaChange> {
  const out: SchemaChange = { tables: { added: [], removed: [], changed: [] }, lists: { added: [], removed: [], changed: [] }, migrations: [], settings: false }
  const was = new Map<string, string>()
  const now = new Map<string, string>()
  const files = changed.filter((x) => x.endsWith('.prisma'))
  const texts = await Promise.all(files.map(async (f) => [(await before(f)) ?? '', (await after(f)) ?? ''] as const))
  // Links are known by the models on either side, so a link to a new table
  // is recognised as one.
  const models = new Set(texts.flatMap(([a, b]) => [...modelNames(a), ...modelNames(b)]))
  for (const [a, b] of texts) {
    for (const [k, v] of prismaBlocks(a, models)) was.set(k, v)
    for (const [k, v] of prismaBlocks(b, models)) now.set(k, v)
  }
  const into = (key: string): { added: string[]; removed: string[]; changed: string[] } | null =>
    key.startsWith('enum ') ? out.lists : key.startsWith('datasource ') || key.startsWith('generator ') ? null : out.tables
  const settings = (k: string): void => { if (into(k) === null) out.settings = true }
  for (const [k, v] of now) {
    const name = k.slice(k.indexOf(' ') + 1)
    if (!was.has(k)) { settings(k); into(k)?.added.push(name) }
    else if (was.get(k) !== v) { settings(k); into(k)?.changed.push(name) }
  }
  for (const k of was.keys()) if (!now.has(k)) { settings(k); into(k)?.removed.push(k.slice(k.indexOf(' ') + 1)) }
  for (const f of changed) {
    if (isTestFile(f)) continue
    const m = /(?:^|\/)migrations?\/([^/]+)\/[^/]*\.(?:sql|[cm]?[jt]s)$/i.exec(f) ?? /(?:^|\/)migrations?\/([^/]+)\.(?:sql|[cm]?[jt]s)$/i.exec(f)
    if (m === null || (await before(f)) !== null) continue
    const name = m[1]!.replace(/\.(sql|[cm]?[jt]s)$/i, '').replace(/^\d{6,}[_-]?/, '').replace(/[_-]+/g, ' ').trim()
    if (name !== '' && !out.migrations.includes(name)) out.migrations.push(name)
  }
  return out
}
