import { beforeAll, describe, expect, it } from 'vitest'
import { renderTerminal, terminalWidth } from '../src/render/terminal.js'
import { renderMarkdown } from '../src/render/markdown.js'
import { setColor, width } from '../src/render/ansi.js'
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
    { type: 'added', fact: route('DELETE', '/api/admin/purge', []), denominator: { property: 'no check found', matching: 4, total: 11, noun: 'routes' } },
    { type: 'added', fact: { kind: 'external', host: 'api.mailgun.net', via: 'url', where: where('m.js') }, denominator: { property: 'new outbound call', matching: 1, total: 2, noun: 'external calls' } },
    { type: 'added', fact: { kind: 'write', table: 'users', module: 'billing', where: where('b.js') }, denominator: { property: 'first write from billing', matching: 1, total: 2, noun: 'modules write users' } },
    { type: 'added', fact: { kind: 'external', host: 'api.stripe.com', via: 'url', where: where('s.js') } },
    { type: 'added', fact: { kind: 'library', name: 'axios', version: '1.7.0', direct: true, importers: ['x.js'], where: where('package.json') } },
  ]
  return toReport(changes, [], { files: 11 }, [], false, 'plain')
}

/** Twelve new exports and nothing else: changes, none worth promoting. */
const twelveExports = (): Change[] => Array.from({ length: 12 }, (_, i) => ({
  type: 'added',
  fact: { kind: 'export', module: `src/hook/deliver-${i}.ts`, symbol: `deliverFromStop${i}`, where: where(`src/hook/deliver-${i}.ts`) },
}))

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
    expect(renderTerminal(fiveChanges(), { columns: 100, voice: 'plain' })).toContain('I found nothing that stops a delete request before it runs.')
  })

  it('says how many files it read, not how many were touched', () => {
    expect(renderTerminal(fiveChanges(), { columns: 80, voice: 'plain' })).toContain('read 11 files')
  })

  it('translates the markdown for a friend, not only the labels', () => {
    const md = renderMarkdown(fiveChanges(), 'plain')
    expect(md).toContain('no check found')
    expect(md).not.toMatch(/middleware|outbound call|modules write/)
  })

  it('gives a long export one line, not a line of spaces that hides the ones after it', () => {
    // Found by installing it on this repository: 17 new exports, 9 shown, the
    // rest pushed out of the budget by whitespace-only lines. --all, because
    // without it a report with nothing promoted is not listed at all.
    const out = renderTerminal(toReport(twelveExports(), [], { files: 49 }), { columns: 80, all: true })
    expect(out.split('\n').filter((l) => l !== '' && l.trim() === '')).toEqual([])
    expect((out.match(/deliverFromStop\d+/g) ?? []).length).toBe(12)
  })

  it('gives a data change words, not only an arrow', () => {
    const r = toReport([{ type: 'added', fact: { kind: 'write', table: 'review', module: 'controllers', where: where('c.js') } }], [], { files: 3 }, [], false, 'plain')
    expect(renderTerminal(r, { columns: 80, voice: 'plain', all: true })).toContain('now changes this data')
    // Unlisted, the sentence still says which data.
    expect(renderTerminal(r, { columns: 80, voice: 'plain' })).toContain('review')
  })
})

describe('a session that needs nothing from the reader', () => {
  const COMMAND = 'npx --yes github:AniketTati/App-Guide'
  const quiet = (voice: 'technical' | 'plain' = 'technical', gaps: Fact[] = []) =>
    toReport(twelveExports(), gaps, { files: 49 }, [], false, voice)

  it('is a glance, not a list', () => {
    // The first live receipt on this repository spent all 26 lines listing
    // exports that needed no one. Length is the severity channel.
    for (const voice of ['technical', 'plain'] as const) {
      const out = renderTerminal(quiet(voice), { columns: 80, voice, command: COMMAND })
      expect(out, voice).toContain('nothing worth a look')
      expect(out, voice).not.toMatch(/deliverFromStop\d+/)
      expect(out.split('\n').length, voice).toBeLessThanOrEqual(12)
      expect(out, voice).toContain('12 changes')
      // The way to the list and the way to clear it, each whole.
      expect(out, voice).toContain(`${COMMAND} since --all`)
      expect(out, voice).toContain(`${COMMAND} seen`)
    }
  })

  it('still lists every one of them when asked for all', () => {
    const out = renderTerminal(quiet(), { columns: 80, all: true })
    expect((out.match(/deliverFromStop\d+/g) ?? []).length).toBe(12)
  })

  it('never offers a #1 the reader cannot see', () => {
    const out = renderTerminal(quiet('plain'), { columns: 80, voice: 'plain' })
    expect(out).not.toContain('#1')
  })

  it('keeps every blind spot, qualifies its own headline, and says what the gap costs', () => {
    const hono: Fact = { kind: 'gap', reason: 'unsupported-framework', subject: 'hono', detail: 'no extractor — routes from hono are not listed', where: where('package.json') }
    for (const voice of ['technical', 'plain'] as const) {
      const out = renderTerminal(quiet(voice, [hono]), { columns: 80, voice })
      expect(out, voice).toContain('hono')
      expect(out, voice).toMatch(/nothing worth a look (in what I can read|— but there are parts I couldn't read)/)
      expect(out, voice).toMatch(/counted here/)
      expect(out, voice).not.toContain('list above')
    }
  })

  it('holds the grid at every width', () => {
    for (let cols = 60; cols <= 100; cols++) {
      for (const voice of ['technical', 'plain'] as const) {
        for (const line of renderTerminal(quiet(voice), { columns: cols, voice, command: COMMAND }).split('\n')) {
          expect(width(line), `${voice} ${cols}: ${line}`).toBeLessThanOrEqual(cols)
        }
      }
    }
  })
})

describe('everything, when asked for everything', () => {
  it('lists every change under --all, and never tells you to run --all', () => {
    const many: Change[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'added', fact: { kind: 'export', module: `src/m${i}.ts`, symbol: `symbol${i}`, where: where(`src/m${i}.ts`) },
    }))
    for (const voice of ['technical', 'plain'] as const) {
      const out = renderTerminal(toReport(many, [], { files: 30 }, [], false, voice), { columns: 80, voice, all: true })
      expect((out.match(/symbol\d+/g) ?? []).length, voice).toBe(30)
      expect(out, voice).not.toContain('since --all')
    }
  })

  it('writes a sentence that adds up to the count', () => {
    // A checked URL, a first write, and an export: the export used to go
    // unmentioned, beside a count of 3.
    const changes: Change[] = [
      { type: 'added', fact: { kind: 'route', method: 'GET', path: '/api/orders/:id', middleware: ['requireAuth'], framework: 'express', where: where('src/api.ts') } },
      { type: 'added', fact: { kind: 'write', table: 'orders', module: 'src', where: where('src/orders.ts') } },
      { type: 'added', fact: { kind: 'export', module: 'src/orders.ts', symbol: 'saveOrder', where: where('src/orders.ts') } },
    ]
    expect(toReport(changes, [], { files: 2 }, [], false, 'plain').summary).toBe(
      'Your agent added 1 new URL, let 1 part of your app change data in orders for the first time, and made 1 other change.')
    expect(toReport(changes, [], { files: 2 }).summary).toBe(
      'Your agent added 1 route, made src write to orders for the first time, and exported 1 new symbol.')
    const read: Change = { type: 'added', fact: { kind: 'read', table: 'orders', module: 'src', where: where('src/orders.ts') } }
    expect(toReport([read], [], { files: 2 }).summary).toBe('Your agent made 1 change.')
    expect(toReport([...changes, read], [], { files: 2 }).summary).toMatch(/, and made 1 other change\.$/)
  })
})
