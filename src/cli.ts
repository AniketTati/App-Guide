import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './run.js'
import { renderTerminal } from './render/terminal.js'
import { setColor } from './render/ansi.js'
import { installHook } from './hook/install.js'
import { renderMarkdown } from './render/markdown.js'

/** Bumped whenever the --json shape changes in a way a consumer would notice. */
export const JSON_SCHEMA_VERSION = 1

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const HELP = `appguide ${version}

  A structural diff for the code your agent just wrote.

Usage
  appguide                 report what changed, then advance nothing
  appguide since           same, explicitly
  appguide init-hook       run automatically when your agent finishes
  appguide init-hook --uninstall

Options
  --all          every change, not just what is new to this codebase
  --mark         record this moment as "the last time you looked"
  --json         emit the raw delta
  --markdown     for a PR comment or Slack
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
        uninstall: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
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
        process.stdout.write(`${JSON.stringify({ schema: JSON_SCHEMA_VERSION, ...report }, null, 2)}\n`)
        return 0
      }
      if (values.markdown) {
        process.stdout.write(renderMarkdown(report))
        return 0
      }
      if (values['no-color']) setColor(false)
      const shown = values.all ? { ...report, also: [...report.top, ...report.also], top: [] } : report
      process.stdout.write(renderTerminal(shown, { hiddenCount: report.totalChanges }))
      return 0
    }
    case 'init-hook': {
      const { outcome, path } = await installHook(process.cwd(), values.uninstall)
      const said: Record<string, string> = {
        installed: `installed — appguide will run when your agent finishes\n  ${path}`,
        'already-installed': `already installed\n  ${path}`,
        removed: `removed\n  ${path}`,
        'not-installed': `nothing to remove — no appguide hook in\n  ${path}`,
      }
      process.stdout.write(`${said[outcome] ?? outcome}\n`)
      return 0
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\nTry: appguide --help\n`)
      return 2
  }
}

/**
 * Guarded so importing this module does not run the CLI against cwd.
 *
 * Compares realpaths: npm installs `bin` entries as symlinks, so argv[1] is the
 * symlink while import.meta.url is the real file. Comparing them any other way
 * makes the published binary exit 0 with no output — which inside a Stop hook
 * is indistinguishable from "nothing new to the shape".
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  void main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
