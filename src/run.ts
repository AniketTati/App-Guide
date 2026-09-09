import { createRequire } from 'node:module'
import type { Fact } from './model/facts.js'
import type { Report } from './model/report.js'
import * as snapshot from './model/snapshot.js'
import { scanLibraries } from './extract/libraries.js'
import { scanRoutes } from './extract/routes/index.js'
import { compare } from './diff/compare.js'
import { toReport } from './diff/rank.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export interface RunOptions {
  root: string
  mark: boolean
}

export async function run({ root, mark }: RunOptions): Promise<Report> {
  const scan = await scanLibraries(root)
  const facts = [...scan.facts, ...scanRoutes({ files: scan.files, declared: scan.declared })]
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

  const report = {
    ...toReport(changes, [...gaps, ...marker], { files: scan.files.length }, facts),
    firstRun: !previous.ok,
  }

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

