import { createRequire } from 'node:module'
import type { Fact } from './model/facts.js'
import type { Report } from './model/report.js'
import * as snapshot from './model/snapshot.js'
import { scanLibraries } from './extract/libraries.js'
import { scanRoutes } from './extract/routes/index.js'
import { scanExternal } from './extract/external.js'
import { scanData } from './extract/data.js'
import { scanExports } from './extract/exports.js'
import { parseAll } from './extract/parse.js'
import { compare } from './diff/compare.js'
import { toReport } from './diff/rank.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export interface RunOptions {
  root: string
  mark: boolean
  voice?: 'technical' | 'plain'
}

export async function run({ root, mark, voice = 'technical' }: RunOptions): Promise<Report> {
  const scan = await scanLibraries(root)
  const { parsed, gaps: parseGaps } = parseAll(scan.files)
  // Imported counts as present. In a workspace the root package.json declares
  // neither the framework nor the ORM, and gating on it alone made routes and
  // database writes vanish with no gap to say so.
  const present = new Set([...scan.declared, ...scan.importers.keys()])
  const facts = [
    ...scan.facts,
    ...parseGaps,
    ...scanRoutes({ files: parsed, declared: present }),
    ...scanExternal(parsed, scan.importers),
    ...scanData(parsed, present),
    ...scanExports(parsed),
  ]
  const gaps = facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')

  const previous = await snapshot.read(root)
  const changes = previous.ok ? compare(previous.snapshot.facts, facts) : []

  // An unreadable or version-mismatched mark is not the same as no changes.
  // Saying "nothing new to the shape" here would be the tool's worst failure:
  // a confident all-clear it has no basis for.
  const marker: Fact[] = previous.ok
    ? []
    : [{
        kind: 'gap',
        reason: previous.reason === 'missing' ? 'unresolved-import' : 'parse-error',
        subject: '.appguide/mark',
        detail: previous.reason === 'missing' ? 'first run — nothing to compare against yet' : previous.detail,
        where: { file: '.appguide/mark', line: 1 },
      }]

  const report = toReport(changes, [...gaps, ...marker], { files: scan.files.length }, facts, !previous.ok, voice)

  // First run establishes the mark and reports nothing: existing state is
  // frozen, so `since` only ever speaks about what is new. Without this the
  // first run is a wall of findings and the tool gets deleted by Friday.
  if (!previous.ok || mark) {
    await snapshot.write(root, {
      version: snapshot.SNAPSHOT_VERSION,
      extractor: version,
      takenAt: new Date().toISOString(),
      facts,
    })
  }
  return report
}

