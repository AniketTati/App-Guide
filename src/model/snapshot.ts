import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Fact } from './facts.js'
import { factId } from './ids.js'
import { stableStringify } from './json.js'

export const SNAPSHOT_VERSION = 2

export interface Snapshot {
  version: number
  extractor: string
  takenAt: string
  facts: readonly Fact[]
}

export type ReadResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: 'missing' | 'unreadable' | 'wrong-version'; detail: string }

export const snapshotPath = (root: string): string => join(root, '.appguide', 'mark')

/**
 * Sorted, one record per line: `<id>\t<kind>\t<json>`.
 *
 * The JSON carries **every** field, identity included. An earlier version
 * reconstructed identity by splitting the id on ':', which corrupted any value
 * containing one — `localhost:3000` came back as host `localhost`, via
 * `3000:fetch`. The id is a lookup key and nothing more.
 */
export function serialise(snap: Snapshot): string {
  const lines = snap.facts
    .map((fact) => `${factId(fact)}\t${fact.kind}\t${stableStringify(fact)}`)
    .sort()
  return [
    `# appguide-snapshot ${snap.version}`,
    `# extractor ${snap.extractor}`,
    `# taken ${snap.takenAt}`,
    ...lines,
    '',
  ].join('\n')
}

export function parse(text: string): ReadResult {
  let version = 0
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
    // A git conflict marker has no tab. Silently skipping it would merge both
    // sides of the conflict into one snapshot, which is worse than failing.
    if (line.startsWith('<<<<<<<') || line.startsWith('=======') || line.startsWith('>>>>>>>')) {
      return { ok: false, reason: 'unreadable', detail: 'contains unresolved merge conflict markers' }
    }
    const tab2 = line.indexOf('\t', line.indexOf('\t') + 1)
    if (tab2 === -1) return { ok: false, reason: 'unreadable', detail: 'malformed record' }
    try {
      facts.push(JSON.parse(line.slice(tab2 + 1)) as Fact)
    } catch {
      return { ok: false, reason: 'unreadable', detail: 'malformed record' }
    }
  }

  if (version !== SNAPSHOT_VERSION) {
    return { ok: false, reason: 'wrong-version', detail: `snapshot is v${version}, this build reads v${SNAPSHOT_VERSION}` }
  }
  return { ok: true, snapshot: { version, extractor, takenAt, facts } }
}

export async function read(root: string): Promise<ReadResult> {
  let text: string
  try {
    text = await readFile(snapshotPath(root), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, reason: 'missing', detail: 'no previous mark' }
      : { ok: false, reason: 'unreadable', detail: (err as Error).message }
  }
  return parse(text)
}

/** Temp-file then rename: a half-written mark must never be readable. */
export async function write(root: string, snap: Snapshot): Promise<void> {
  const path = snapshotPath(root)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, serialise(snap), 'utf8')
  await rename(tmp, path)
}
