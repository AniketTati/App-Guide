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

const MIGRATION = /(^|\/)migrations?\/.+\.sql$/i
const CONFIG = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|[^/]+\.(ya?ml|toml|tf|hcl)|\.github\/.+|\.env\.[^/]*example[^/]*|Procfile|nginx[^/]*\.conf)$/i

export function unseenChanges(changed: readonly string[]): Unseen[] {
  const groups = new Map<string, Unseen>()
  const add = (kind: Unseen['kind'], label: string, file: string): void => {
    const g = groups.get(label) ?? { kind, label, files: [] }
    g.files.push(file)
    groups.set(label, g)
  }
  for (const f of changed) {
    if (isTestFile(f)) continue
    const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase()
    if (ext === 'prisma') add('schema', 'the database schema', f)
    else if (MIGRATION.test(f)) add('migration', 'database migrations', f)
    else if (UNREAD[ext] !== undefined) add('language', UNREAD[ext]!, f)
    else if (CONFIG.test(f)) add('config', 'deploy and build settings', f)
  }
  const order: Unseen['kind'][] = ['schema', 'migration', 'language', 'config']
  return [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.files.length - a.files.length)
}

/** Prisma blocks by "model Contract" / "enum Role", whitespace and comments
 *  ignored, so a reformat is not a change. */
export function prismaBlocks(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^(model|enum|view|type)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    out.set(`${m[1]} ${m[2]}`, m[3]!.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim())
  }
  return out
}

export interface SchemaChange {
  /** Tables (Prisma models) added, removed, or changed in shape. */
  tables: { added: string[]; removed: string[]; changed: string[] }
  /** Lists of allowed values (Prisma enums) added, removed or changed. */
  lists: { added: string[]; removed: string[]; changed: string[] }
  /** New migrations, named as their folders are, timestamps dropped. */
  migrations: string[]
}

/** The schema's own words for what a piece of work changed in the database. */
export async function schemaChange(changed: readonly string[], before: (f: string) => Promise<string | null>, after: (f: string) => Promise<string | null>): Promise<SchemaChange> {
  const out: SchemaChange = { tables: { added: [], removed: [], changed: [] }, lists: { added: [], removed: [], changed: [] }, migrations: [] }
  const was = new Map<string, string>()
  const now = new Map<string, string>()
  for (const f of changed.filter((x) => x.endsWith('.prisma'))) {
    for (const [k, v] of prismaBlocks((await before(f)) ?? '')) was.set(k, v)
    for (const [k, v] of prismaBlocks((await after(f)) ?? '')) now.set(k, v)
  }
  const into = (key: string): { added: string[]; removed: string[]; changed: string[] } => (key.startsWith('enum ') ? out.lists : out.tables)
  for (const [k, v] of now) {
    const name = k.slice(k.indexOf(' ') + 1)
    if (!was.has(k)) into(k).added.push(name)
    else if (was.get(k) !== v) into(k).changed.push(name)
  }
  for (const k of was.keys()) if (!now.has(k)) into(k).removed.push(k.slice(k.indexOf(' ') + 1))
  for (const f of changed) {
    const m = /(?:^|\/)migrations\/([^/]+)\/[^/]*\.sql$/i.exec(f) ?? /(?:^|\/)migrations\/([^/]+)\.sql$/i.exec(f)
    if (m === null || (await before(f)) !== null) continue
    const name = m[1]!.replace(/^\d{6,}[_-]?/, '').replace(/[_-]+/g, ' ').trim()
    if (name !== '' && !out.migrations.includes(name)) out.migrations.push(name)
  }
  return out
}
