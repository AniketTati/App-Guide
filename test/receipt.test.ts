import { beforeAll, describe, expect, it } from 'vitest'
import { renderTerminal, terminalWidth } from '../src/render/terminal.js'
import { renderMarkdown } from '../src/render/markdown.js'
import { setColor } from '../src/render/ansi.js'
import { toReport } from '../src/diff/rank.js'
import type { Change } from '../src/model/report.js'
import type { Fact } from '../src/model/facts.js'

beforeAll(() => setColor(false))

const where = (file: string) => ({ file, line: 1 })
const route = (method: string, path: string, mw: string[]): Fact =>
  ({ kind: 'route', method, path, middleware: mw, framework: 'express', where: where('routes/a.js') })

/** Five findings: more than fit at a narrow width. */
function fiveChanges() {
  const changes: Change[] = [
    { type: 'added', fact: route('DELETE', '/api/admin/purge', []), denominator: { property: 'no middleware', matching: 4, total: 11, noun: 'routes' } },
    { type: 'added', fact: { kind: 'external', host: 'api.mailgun.net', via: 'url', where: where('m.js') }, denominator: { property: 'new outbound call', matching: 1, total: 2, noun: 'external calls' } },
    { type: 'added', fact: { kind: 'write', table: 'users', module: 'billing', where: where('b.js') }, denominator: { property: 'first write from billing', matching: 1, total: 2, noun: 'modules write users' } },
    { type: 'added', fact: { kind: 'external', host: 'api.stripe.com', via: 'url', where: where('s.js') } },
    { type: 'added', fact: { kind: 'library', name: 'axios', version: '1.7.0', direct: true, importers: ['x.js'], where: where('package.json') } },
  ]
  return toReport(changes, [], { files: 11 }, [], false, 'plain')
}

describe('the receipt, after the third review', () => {
  it('always says how many findings are not shown, however tight the terminal', () => {
    for (const cols of [60, 70, 80, 100]) {
      const out = renderTerminal(fiveChanges(), { columns: cols, voice: 'plain', command: 'npx --yes github:AniketTati/App-Guide' })
      const shown = (out.match(/^ {2}#\d+ /gm) ?? []).length
      if (shown < 5) expect(out, `${cols} cols`).toContain(`+${5 - shown} more`)
    }
  })

  it('names the command that was actually installed, whole and on its own line', () => {
    const command = 'npx --yes github:AniketTati/App-Guide'
    for (const cols of [60, 80]) {
      const out = renderTerminal(fiveChanges(), { columns: cols, voice: 'plain', command })
      expect(out, `${cols} cols`).toContain(`${command} seen`)
      // A bare `appguide seen` is not on anyone's PATH.
      expect(out).not.toMatch(/(^|\s)appguide seen/m)
    }
  })

  it('honours COLUMNS when it is not writing to a terminal', () => {
    expect(terminalWidth(undefined, undefined, '62')).toBe(62)
    expect(terminalWidth(undefined, 90, '62')).toBe(90)
    expect(terminalWidth(70, 90, '62')).toBe(70)
    expect(terminalWidth(undefined, undefined, undefined)).toBe(80)
  })

  it('says "1 other", never "1 others"', () => {
    expect(renderTerminal(fiveChanges(), { columns: 100, voice: 'plain' })).not.toMatch(/\b1 others\b/)
  })

  it('describes an open DELETE by what the method means, not a guess about the handler', () => {
    expect(renderTerminal(fiveChanges(), { columns: 100, voice: 'plain' })).toContain('Anyone on the internet can send it a delete request.')
  })

  it('says how many files it read, not how many were touched', () => {
    expect(renderTerminal(fiveChanges(), { columns: 80, voice: 'plain' })).toContain('read 11 files')
  })

  it('translates the markdown for a friend, not only the labels', () => {
    const md = renderMarkdown(fiveChanges(), 'plain')
    expect(md).toContain('nothing checks it')
    expect(md).not.toMatch(/middleware|outbound call|modules write/)
  })

  it('gives a data change words, not only an arrow', () => {
    const r = toReport([{ type: 'added', fact: { kind: 'write', table: 'review', module: 'controllers', where: where('c.js') } }], [], { files: 3 }, [], false, 'plain')
    expect(renderTerminal(r, { columns: 80, voice: 'plain' })).toContain('now changes this data')
  })
})
