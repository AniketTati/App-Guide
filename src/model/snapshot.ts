import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fact } from './facts.js'
import { factId, factPayload } from './ids.js'

export const SNAPSHOT_VERSION = 1

export interface Snapshot {
  version: number
  extractor: string
  takenAt: string
  facts: readonly Fact[]
}

export function snapshotPath(root: string): string {
  return join(root, '.appguide', 'mark')
}

/**
 * Serialised as sorted, one record per line — the go.sum shape, chosen so a
 * human can read a diff of it and so git can merge it without producing
 * syntactically invalid output.
 *
 *   <id>\t<kind>\t<json payload>
 */
export function serialise(snap: Snapshot): string {
  const lines = snap.facts
    .map((fact) => `${factId(fact)}\t${fact.kind}\t${stableJson(factPayload(fact))}`)
    .sort()
  return [
    `# appguide-snapshot ${snap.version}`,
    `# extractor ${snap.extractor}`,
    `# taken ${snap.takenAt}`,
    ...lines,
    '',
  ].join('\n')
}

export function parse(text: string): Snapshot {
  let version = SNAPSHOT_VERSION
  let extractor = 'unknown'
  let takenAt = ''
  const facts: Fact[] = []

  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith('#')) {
      const [, key, value] = line.split(/\s+/, 3)
      if (key === 'appguide-snapshot' && value !== undefined) version = Number(value)
      else if (key === 'extractor' && value !== undefined) extractor = value
      else if (key === 'taken' && value !== undefined) takenAt = value
      continue
    }
    const tab = line.indexOf('\t')
    const tab2 = line.indexOf('\t', tab + 1)
    if (tab === -1 || tab2 === -1) continue
    const kind = line.slice(tab + 1, tab2)
    const payload = JSON.parse(line.slice(tab2 + 1)) as Record<string, unknown>
    facts.push(rehydrate(line.slice(0, tab), kind, payload))
  }

  return { version, extractor, takenAt, facts }
}

function rehydrate(id: string, kind: string, payload: Record<string, unknown>): Fact {
  const parts = id.split(':')
  const base = { ...payload } as Record<string, unknown>
  switch (kind) {
    case 'route':
      return { kind, method: parts[1]!, path: parts.slice(2).join(':'), ...base } as Fact
    case 'library':
      return { kind, name: parts.slice(1).join(':'), ...base } as Fact
    case 'external':
      return { kind, host: parts[1]!, via: parts.slice(2).join(':'), ...base } as Fact
    case 'write':
    case 'read':
      return { kind, table: parts[1]!, module: parts.slice(2).join(':'), ...base } as Fact
    case 'export':
      return { kind, module: parts[1]!, symbol: parts.slice(2).join(':'), ...base } as Fact
    case 'gap':
      return { kind, reason: parts[1]!, subject: parts.slice(2).join(':'), ...base } as Fact
    default:
      throw new Error(`unknown fact kind in snapshot: ${kind}`)
  }
}

/** Key order is fixed so an unchanged codebase serialises byte-identically. */
function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

export async function read(root: string): Promise<Snapshot | null> {
  try {
    return parse(await readFile(snapshotPath(root), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function write(root: string, snap: Snapshot): Promise<void> {
  const path = snapshotPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serialise(snap), 'utf8')
}
