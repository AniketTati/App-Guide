import { it } from 'vitest'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discover } from '../../src/extract/files.js'
import { parseAll } from '../../src/extract/parse.js'
import { scanRoutes } from '../../src/extract/routes/index.js'

// Set by bench/express/run.sh, which also clones the corpus.
const WORK = process.env['APPGUIDE_BENCH_WORK']

it('static extraction over Express example apps', async () => {
  if (WORK === undefined) throw new Error('run via: pnpm bench:recall')
  const examples = join(WORK, 'express', 'examples')
  const result: Record<string, unknown> = {}
  for (const name of readdirSync(examples)) {
    const dir = join(examples, name)
    if (!statSync(dir).isDirectory()) continue
    const { files, gaps: discoveryGaps } = await discover(dir)
    const { parsed, gaps: parseGaps } = parseAll(files)
    // Declared explicitly, as a real app's package.json would.
    const facts = scanRoutes({ files: parsed, declared: new Set(['express']) })
    result[name] = {
      routes: facts.flatMap((f) => (f.kind === 'route' ? [{ r: `${f.method} ${f.path}`, scope: f.scope ?? null }] : [])),
      gaps: [...discoveryGaps, ...parseGaps, ...facts].flatMap((f) => (f.kind === 'gap' ? [`${f.reason}: ${f.subject}`] : [])),
    }
  }
  writeFileSync(join(WORK, 'static.json'), JSON.stringify(result, null, 2))
}, 120_000)
