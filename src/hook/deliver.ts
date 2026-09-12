import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Report } from '../model/report.js'

/**
 * How a receipt actually reaches people inside Claude Code.
 *
 * Claude Code sends a Stop hook's plain stdout to its debug log, where no one
 * sees it. An earlier version printed the receipt that way, and it was
 * invisible in every session — the tests passed because they ran the command
 * directly, never through Claude Code. The documented channels are:
 *
 *   - Stop hook JSON `systemMessage`: "Warning message shown to the user."
 *   - UserPromptSubmit plain stdout: injected into Claude's context as a system
 *     reminder with the user's next message. Not shown to the user.
 *
 * So the Stop hook shows the receipt to the person and leaves a copy for
 * Claude, and the prompt hook hands that copy over once — which is what makes
 * "explain #1" mean something. Stop's own `additionalContext` is deliberately
 * not used: it keeps the conversation going, which would put Claude back to
 * work after every reply.
 */

export const pendingPath = (root: string): string => join(root, '.appguide', 'pending')
const shownPath = (root: string): string => join(root, '.appguide', 'last-shown')

/**
 * Returns the hook's entire stdout: a JSON object, or '' to say nothing.
 *
 * It speaks once per distinct receipt. A Stop hook fires after every reply, and
 * the same unreviewed list shown after every one of them is wallpaper — the
 * fastest way to get a tool uninstalled. The mark is not advanced, so nothing
 * is lost while the person is away; it just is not repeated.
 */
export async function deliverFromStop(root: string, report: Report, receipt: string, command: string): Promise<string> {
  const digest = createHash('sha256').update(receipt).digest('hex')
  const last = (await readFile(shownPath(root), 'utf8').catch(() => '')).trim()
  if (last === digest) return ''
  await write(shownPath(root), digest)

  const findings = report.top.length + report.also.length
  if (findings > 0) await write(pendingPath(root), forClaude(receipt, command))
  else await rm(pendingPath(root), { force: true })

  const out: Record<string, string> = { systemMessage: receipt.trimEnd() }
  if (report.top.length > 0) out['terminalSequence'] = notification(report.top.length)
  // Claude Code parses stdout as JSON only when it starts with { and ends
  // with }. Anything else is plain text, and plain text from Stop goes nowhere.
  return JSON.stringify(out)
}

/** After "done looking": the next receipt, even an unchanged all-clear, speaks. */
export async function clearDelivery(root: string): Promise<void> {
  await rm(pendingPath(root), { force: true })
  await rm(shownPath(root), { force: true })
}

/** What Claude receives: enough to act on "#1" and "done looking" — and an
 *  explicit instruction not to act unprompted, because this arrives beside
 *  whatever the person actually asked for next. */
function forClaude(receipt: string, command: string): string {
  return [
    'appguide — a structural report of what changed in this codebase since the user last reviewed it.',
    'The numbered items (#1, #2, ...) are what the user means by "explain #1" or "fix #1".',
    `For a self-contained brief on one item, run: ${command} ask <number>`,
    `To list every change, run: ${command} since --all`,
    `When the user says they are done looking, run: ${command} seen`,
    'Do not act on this report unless the user asks about it.',
    '',
    receipt.trimEnd(),
    '',
  ].join('\n')
}

/** OSC 9: a desktop notification in terminals that support one, for when the
 *  person is away from the machine while the agent works. */
const notification = (n: number): string =>
  `\x1b]9;appguide: ${n} thing${n === 1 ? '' : 's'} worth a look\x07`

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}
