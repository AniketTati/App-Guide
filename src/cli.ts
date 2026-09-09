import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { run } from './run.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const HELP = `appguide ${version}

  A structural diff for the code your agent just wrote.

Usage
  appguide                 report what changed, then advance nothing
  appguide since           same, explicitly
  appguide init-hook       run automatically when your agent finishes

Options
  --all          every change, not just what is new to this codebase
  --mark         record this moment as "the last time you looked"
  --json         emit the raw delta
  --no-color     plain text
  --help, -h     this
  --version, -v  version
`

export async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        mark: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\nTry: appguide --help\n`)
    return 2
  }

  const { values, positionals } = parsed
  if (values.version) {
    process.stdout.write(`${version}\n`)
    return 0
  }
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }

  const command = positionals[0] ?? 'since'
  switch (command) {
    case 'since': {
      const report = await run({ root: process.cwd(), mark: values.mark })
      if (values.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        return 0
      }
      process.stdout.write('terminal renderer not built yet — use --json\n')
      return 0
    }
    case 'init-hook':
      process.stdout.write('not built yet\n')
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n\nTry: appguide --help\n`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  },
)
