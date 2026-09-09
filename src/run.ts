import { createRequire } from 'node:module'
import type { Fact } from './model/facts.js'
import type { Report } from './model/report.js'
import * as snapshot from './model/snapshot.js'
import { scanLibraries } from './extract/libraries.js'
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
  const facts = scan.facts
  const gaps = facts.filter((f): f is Extract<Fact, { kind: 'gap' }> => f.kind === 'gap')

  const previous = await snapshot.read(root)
  const changes = previous === null ? [] : compare(previous.facts, facts)

  const report = toReport(changes, gaps, { files: scan.files.length })

  // First run establishes the mark and reports nothing: existing state is
  // frozen, so `since` only ever speaks about what is new. Without this the
  // first run is a wall of findings and the tool gets deleted by Friday.
  if (previous === null || mark) {
    await snapshot.write(root, {
      version: snapshot.SNAPSHOT_VERSION,
      extractor: version,
      takenAt: new Date().toISOString(),
      facts,
    })
  }
  return report
}

export const isFirstRun = async (root: string): Promise<boolean> => (await snapshot.read(root)) === null
