/**
 * Raw ANSI, no dependency. Deliberately no red: red means broken, and this tool
 * never claims that. An absolute rule means it structurally cannot cry wolf.
 *
 * This is the only file in src/ permitted to emit an escape sequence, and it
 * emits exactly three: bold, dim, and the reset for both.
 */
const envDisables = (): boolean => {
  const v = process.env['NO_COLOR']
  // no-color.org: the variable must be *non-empty* to disable colour.
  return (v !== undefined && v !== '') || process.env['TERM'] === 'dumb'
}

let force: boolean | null = null
export const setColor = (on: boolean | null): void => { force = on }
const on = (): boolean => (force === null ? !envDisables() && process.stdout.isTTY === true : force)

export const dim = (s: string): string => (on() ? `\x1b[2m${s}\x1b[22m` : s)
export const bold = (s: string): string => (on() ? `\x1b[1m${s}\x1b[22m` : s)

const ESCAPES = /\x1b\[[0-9;]*m/g

/**
 * Columns a terminal will actually use, not UTF-16 code units. A CJK route path
 * measured by `.length` reports 48 for a line that occupies 67 columns, which
 * silently destroys the column grid that carries the hierarchy.
 */
export function width(s: string): number {
  let n = 0
  for (const ch of s.replace(ESCAPES, '')) n += charWidth(ch.codePointAt(0) ?? 0)
  return n
}

function charWidth(cp: number): number {
  if (cp === 0) return 0
  // Combining marks and variation selectors occupy no column of their own.
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK radicals through Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // Emoji blocks: pictographs, emoticons, transport, supplemental and
    // extended-A. An earlier range stopped at 0x1f64f and so measured 🚀
    // (U+1F680) as one column.
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa00 && cp <= 0x1faff)
  ) return 2
  return 1
}

/**
 * Truncate rather than wrap — a wrapped line destroys the column grid, and the
 * grid is the hierarchy. Iterates code points so a surrogate pair is never
 * split in half.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (width(s) <= max) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (n + w > max - 1) break
    out += ch
    n += w
  }
  return `${out}…`
}

export const pad = (s: string, to: number): string => s + ' '.repeat(Math.max(0, to - width(s)))
