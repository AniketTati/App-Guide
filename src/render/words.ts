import type { Change, Report } from '../model/report.js'
import type { Fact } from '../model/facts.js'

export type Voice = 'technical' | 'plain'

/**
 * The plain voice translates. It never judges.
 *
 * "Nothing checks who is calling this URL" is the same fact in the reader's
 * words. "This is insecure" is a verdict we cannot back, and the moment we
 * print one, every number below it stops being checkable.
 *
 * It also never infers. A middleware named `requireAuth` does not license the
 * claim "needs login" — that is reading a name and calling it a fact.
 */
export interface Words {
  kind(fact: Fact): string
  detail(change: Change): string
  why(change: Change): string
  gap(fact: Fact): string
  headline(report: Report): string
  footer(hidden: number, numbered: boolean, cols: number): string
  labels: { top: string; also: string; gaps: string }
}

export const technical: Words = {
  kind: (f) => f.kind,
  detail: (c) => {
    const f = c.fact
    if (f.kind === 'route') return f.middleware === 'unresolved' ? 'chain unresolved' : (f.middleware.join(', ') || 'no middleware')
    if (f.kind === 'library') return `${f.version}${f.direct ? '' : ' (undeclared)'}`
    if (f.kind === 'external') return f.via
    return ''
  },
  why: () => '',
  gap: (g) => (g.kind === 'gap' ? `${g.subject}: ${g.detail}` : ''),
  headline: (r) => (r.gaps.length > 0 ? 'nothing new in what I can read' : 'nothing new to the shape'),
  footer: (hidden) => `appguide since --all (${hidden}) · --mark`,
  labels: { top: 'NEW TO THIS CODEBASE', also: 'ALSO CHANGED', gaps: 'NOT COVERED' },
}

/** Short enough to fit the column. A truncated label — "changes…" — is worse
 *  than the jargon it replaced. */
const PLAIN_KINDS: Record<Fact['kind'], string> = {
  route: 'URL',
  library: 'package',
  external: 'service',
  write: 'writes',
  read: 'reads',
  export: 'code',
  gap: 'unread',
}

export const plain: Words = {
  kind: (f) => PLAIN_KINDS[f.kind],

  detail: (c) => {
    const f = c.fact
    if (f.kind === 'route') {
      if (f.middleware === 'unresolved') return "I couldn't tell what checks this"
      // Counting the checks is a fact. Naming what they do is a guess.
      if (f.middleware.length === 0) return 'nothing checks who is calling it'
      return `${f.middleware.length} check${f.middleware.length === 1 ? '' : 's'} run first`
    }
    if (f.kind === 'library') return `version ${f.version}${f.direct ? '' : ", which isn't in your package list"}`
    if (f.kind === 'external') return f.via === 'url' ? 'called directly' : `through ${f.via}`
    return ''
  },

  why: (c) => {
    const f = c.fact
    if (c.type !== 'added') return ''
    switch (f.kind) {
      case 'route':
        return f.middleware !== 'unresolved' && f.middleware.length === 0
          ? 'Anyone on the internet can reach this one.'
          : 'A new way into your app.'
      case 'library': return "Someone else's code now runs inside your app."
      case 'external': return 'Your app now talks to a server it never used before.'
      case 'write': return "This part of your app couldn't change that data before."
      case 'read': return "This part of your app couldn't see that data before."
      default: return ''
    }
  },

  gap: (g) => {
    if (g.kind !== 'gap') return ''
    switch (g.reason) {
      case 'unsupported-framework': return `I can't read ${g.subject} yet, so anything it creates is missing from this list.`
      case 'parse-error': return `I couldn't read ${g.subject}, so I don't know what's in it.`
      case 'computed-route-path': return `One web address in ${g.subject} is put together while the app runs, so I can't tell you what it is.`
      case 'dynamic-dispatch': return `Some code in ${g.subject} decides what to run while the app runs, so I can't follow it.`
      case 'raw-sql': return `There's hand-written database code in ${g.subject} that I don't read.`
      case 'unresolved-import': return `${g.subject} is used but isn't in your package list.`
    }
  },

  headline: (r) => (r.gaps.length > 0
    ? 'nothing new that I can see — but there are parts I could not read'
    : 'nothing new'),

  // The hint is the point of the footer, so at a narrow terminal the count
  // goes rather than the instruction.
  footer: (hidden, numbered, cols) => {
    const total = `${hidden} change${hidden === 1 ? '' : 's'} in total`
    if (!numbered) return total
    const hint = 'Ask your agent: "explain #1" or "fix #1"'
    return hint.length + total.length + 9 <= cols - 4 ? `${hint}   ·   ${total}` : hint
  },

  labels: { top: 'WORTH A LOOK', also: 'ALSO CHANGED', gaps: "WHAT I COULDN'T READ" },
}

export const words = (voice: Voice): Words => (voice === 'plain' ? plain : technical)
