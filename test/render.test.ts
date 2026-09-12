import { describe, expect, it, beforeAll } from 'vitest'
import { renderTerminal, _internal } from '../src/render/terminal.js'
import { setColor, truncate, width } from '../src/render/ansi.js'
import { alarming, routine, allClear, unsupported } from './render.fixture.js'

beforeAll(() => setColor(false))

const render = (r: ReturnType<typeof alarming>, columns = 78) => renderTerminal(r, { columns })

describe('preview', () => {
  it('renders every state', () => {
    for (const [name, make] of [['ALARMING', alarming], ['ROUTINE', routine], ['ALL CLEAR', allClear], ['UNSUPPORTED', unsupported]] as const) {
      console.log(`\n### ${name}\n${render(make())}`)
    }
    expect(true).toBe(true)
  })
})

describe('the grid holds', () => {
  it('never exceeds the terminal width, at any width', () => {
    for (const cols of [60, 78, 80, 100, 120, 200]) {
      for (const make of [alarming, routine, allClear, unsupported]) {
        for (const line of render(make(), cols).split('\n')) {
          expect(width(line), `${cols} cols: ${JSON.stringify(line)}`).toBeLessThanOrEqual(Math.min(100, Math.max(60, cols)))
        }
      }
    }
  })

  it('stays inside the length budget so a long one is visibly different', () => {
    // MAX_LINES governs content; the frame adds two rules and a trailing
    // newline on top of it.
    const BUDGET = 26 + 3
    for (const cols of [60, 78, 100, 120]) {
      expect(render(alarming(), cols).split('\n').length, `${cols} cols`).toBeLessThanOrEqual(BUDGET)
    }
    expect(render(allClear()).split('\n').length).toBeLessThanOrEqual(6)
  })

  it('never shows a section header with nothing under it', () => {
    for (const make of [alarming, routine, allClear, unsupported]) {
      const lines = render(make()).split('\n')
      lines.forEach((line, i) => {
        if (/ALSO CHANGED|NEW TO THIS CODEBASE|NOT COVERED/.test(line)) {
          expect(lines[i + 1]?.trim(), `orphan header: ${line.trim()}`).toBeTruthy()
        }
      })
    }
  })

  it('emits only bold and dim — the rule is absolute, so assert it as one', () => {
    setColor(true)
    for (const make of [alarming, routine, allClear, unsupported]) {
      const escapes = render(make()).match(/\x1b\[[0-9;]*m/g) ?? []
      // Inverted deliberately: a blocklist of red codes would miss 256-colour
      // and truecolor. An allow-list cannot.
      expect([...new Set(escapes)].sort()).toEqual(['\x1b[1m', '\x1b[22m', '\x1b[2m'].sort())
    }
    setColor(false)
  })

  it('emits no escapes at all under NO_COLOR', () => {
    expect(render(alarming())).not.toMatch(/\x1b\[/)
  })
})

describe('what it says', () => {
  it('leads with one sentence of English', () => {
    expect(render(alarming())).toContain('Your agent added 3 routes, one with no middleware')
  })

  it('shows a denominator, never an adjective', () => {
    const out = render(alarming())
    expect(out).toContain('1 of 48 routes')
    expect(out).not.toMatch(/danger|risk|critical|warning|severe/i)
  })

  it('gives every promoted finding a file:line to check', () => {
    expect(render(alarming())).toContain('src/api/admin.ts:14')
  })

  it('states what the omission costs, not just that there is one', () => {
    expect(render(alarming())).toContain('would not appear above')
  })

  it('declares an unsupported framework rather than showing nothing', () => {
    const out = render(unsupported())
    expect(out).toContain('hono')
  })

  it('refuses to claim "nothing new to the shape" when it cannot read a framework', () => {
    // The all-clear is an exhaustive claim, and this is exactly where silence
    // would hide. It must be qualified rather than reassuring.
    expect(render(unsupported())).toContain('nothing new in what I can read')
    expect(render(unsupported())).not.toContain('nothing new to the shape')
    expect(render(allClear())).toContain('nothing new to the shape')
  })

  it('is boring and short when nothing happened', () => {
    const out = render(allClear())
    expect(out).toContain('nothing new to the shape')
    expect(out).toContain('everything it touched was readable')
  })
})

describe('display width', () => {
  // Asserted against known values rather than against the tool's own width(),
  // which would make the grid test tautological.
  it('counts columns, not code units', () => {
    expect(width('abc')).toBe(3)
    expect(width('日本語')).toBe(6)
    expect(width('🚀')).toBe(2)
    expect(width('e\u0301')).toBe(1)
  })

  it('never splits a surrogate pair', () => {
    for (let n = 1; n <= 12; n++) {
      const out = truncate('aaaa🚀bbbb', n)
      expect(out, `n=${n}`).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })

  it('holds the grid for wide characters', () => {
    const r = { ...routine(), also: [{ type: 'added' as const, fact: { kind: 'route' as const, method: 'POST', path: '/接口/用户/资料', middleware: ['認証ミドルウェア', '課金ガード'], framework: 'express', where: { file: 'src/a.ts', line: 1 } } }] }
    for (const line of renderTerminal(r, { columns: 60 }).split('\n')) {
      expect(width(line)).toBeLessThanOrEqual(60)
    }
  })

  it('breaks an over-long word in the prose rather than overflowing', () => {
    const long = '@enterprise-platform/observability-instrumentation-http-client-adapter'
    for (const line of _internal.prose(`Your agent pulled in ${long}.`, 60)) {
      expect(width(line)).toBeLessThanOrEqual(60)
    }
  })
})

describe('prose wrapping', () => {
  it('wraps the summary but nothing else', () => {
    const lines = _internal.prose('a '.repeat(60).trim(), 40)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(40)
    expect(lines.length).toBeGreaterThan(1)
  })
})
