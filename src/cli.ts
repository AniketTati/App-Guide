import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './run.js'
import { read as readMark } from './model/snapshot.js'
import { renderTerminal } from './render/terminal.js'
import { setColor } from './render/ansi.js'
import { installHook } from './hook/install.js'
import { renderMarkdown } from './render/markdown.js'
import { ask } from './render/ask.js'
import { readConfig } from './config.js'

/** Bumped whenever the --json shape changes in a way a consumer would notice. */
export const JSON_SCHEMA_VERSION = 1

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const HELP = `appguide ${version}

  A structural diff for the code your agent just wrote.

Usage
  appguide                 report what changed, then advance nothing
  appguide since           same, explicitly
  appguide seen            you've read it — start the next report from here
  appguide ask 1           a question you can paste to your agent about finding 1
  appguide init-hook       run automatically when your agent finishes
  appguide init-hook --plain       ...in everyday language, not jargon
  appguide init-hook --uninstall

Options
  --all          every change, not just what is new to this codebase
  --mark         record this moment as "the last time you looked"
  --json         emit the raw delta
  --markdown     for a PR comment or Slack
  --plain        everyday language instead of jargon
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
        plain: { type: 'boolean', default: false },
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
      const voice = values.plain || (await readConfig(process.cwd())).plain ? 'plain' as const : 'technical' as const
      const report = await run({ root: process.cwd(), mark: values.mark, voice })
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ schema: JSON_SCHEMA_VERSION, ...report }, null, 2)}\n`)
        return 0
      }
      if (values.markdown) {
        process.stdout.write(renderMarkdown(report, voice))
        return 0
      }
      if (values['no-color']) setColor(false)
      const shown = values.all ? { ...report, also: [...report.top, ...report.also], top: [] } : report
      process.stdout.write(renderTerminal(shown, { hiddenCount: report.totalChanges, voice }))
      return 0
    }
    case 'seen': {
      await run({ root: process.cwd(), mark: true })
      const plainVoice = values.plain || (await readConfig(process.cwd())).plain
      process.stdout.write(plainVoice
        ? "Noted. The next report will only show what changes from here.\n"
        : 'mark advanced\n')
      return 0
    }
    case 'ask': {
      const which = Number(positionals[1] ?? '1')
      if (!Number.isInteger(which) || which < 1) {
        process.stderr.write('which one? e.g. appguide ask 1\n')
        return 2
      }
      const askVoice = values.plain || (await readConfig(process.cwd())).plain ? 'plain' as const : 'technical' as const
      const report = await run({ root: process.cwd(), mark: false, voice: askVoice })
      const prompt = ask(report, which, askVoice)
      if (prompt === null) {
        const n = report.top.length + report.also.length
        process.stderr.write(n === 0 ? 'nothing to ask about — nothing changed\n' : `there are only ${n} findings\n`)
        return 1
      }
      process.stdout.write(prompt)
      return 0
    }
    case 'init-hook': {
      const r = await installHook(process.cwd(), values.uninstall, values.plain)
      if (r.outcome === 'removed' || r.outcome === 'not-installed') {
        process.stdout.write(`${r.outcome === 'removed' ? 'removed' : 'nothing to remove'}\n  ${r.path}\n`)
        return 0
      }
      if (r.verified !== true) {
        // Never claim an install we could not run. This is the moment the
        // reader is paying attention, and spending it on a false "Done" is
        // how they end up with an error wall after every session instead.
        process.stderr.write(values.plain
          ? `I set it up, but I couldn't get it to run, so it won't work yet.\n\n  tried:  ${r.command}\n  got:    ${r.problem ?? 'no output'}\n\nappguide isn't published yet — for now, run it from a copy of the source.\nUndo with: appguide init-hook --uninstall\n`
          : `wrote the hook but could not run it — it will fail on every session\n\n  command: ${r.command}\n  error:   ${r.problem ?? 'no output'}\n\nundo with: appguide init-hook --uninstall\n`)
        return 1
      }
      // Take the first look now. Otherwise the reader's first session prints
      // "nothing to compare yet" and only the second is useful — which, for
      // someone deciding whether this is worth keeping, is one session too many.
      const hadMark = (await readMark(process.cwd())).ok
      if (!hadMark) await run({ root: process.cwd(), mark: true })
      process.stdout.write(values.plain
        ? `Done, and I checked that it works. I've taken a first look at your app, so\nthe next time your agent finishes you'll see what it changed. Most of the\ntime it will say nothing happened — that's the point.\n  ${r.path}\n`
        : `installed and verified — ${hadMark ? 'existing mark kept' : 'first mark taken'}; runs when your agent finishes\n  ${r.path}\n`)
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
