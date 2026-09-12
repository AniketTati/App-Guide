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
  footer(total: number, numbered: boolean, cols: number, command: string): string
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
  footer: (total, _numbered, _cols, command) =>
    `${total} change${total === 1 ? '' : 's'} · clear with:\n  ${command} seen`,
  labels: { top: 'NEW TO THIS CODEBASE', also: 'ALSO CHANGED', gaps: 'NOT COVERED' },
}

/** Short enough to fit the column. A truncated label — "changes…" — is worse
 *  than the jargon it replaced. */
const PLAIN_KINDS: Record<Fact['kind'], string> = {
  route: 'URL',
  library: 'package',
  external: 'service',
  write: 'data',
  read: 'data',
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
    // A bare "controllers → review" gave the reader an arrow and no words.
    if (f.kind === 'write') return c.type === 'removed' ? 'no longer changes it' : 'now changes this data'
    if (f.kind === 'read') return c.type === 'removed' ? 'no longer reads it' : 'now reads this data'
    return ''
  },

  why: (c) => {
    const f = c.fact
    if (c.type !== 'added') return ''
    switch (f.kind) {
      case 'route': {
        if (f.middleware === 'unresolved' || f.middleware.length > 0) return 'A new way into your app.'
        // What the method means by HTTP's own definition — never a guess about
        // what the handler does.
        switch (f.method.toUpperCase()) {
          case 'DELETE': return 'Anyone on the internet can send it a delete request.'
          case 'PUT': case 'PATCH': return 'Anyone on the internet can send it changes.'
          case 'POST': return 'Anyone on the internet can send data to this one.'
          case 'ALL': return 'Anyone on the internet can send it any kind of request.'
          default: return 'Anyone on the internet can reach this one.'
        }
      }
      case 'library': return "Someone else's code now runs inside your app."
      case 'external': return 'Your app now talks to a server it never used before.'
      case 'write': return "This part of your app didn't change that data before."
      case 'read': return "This part of your app didn't read that data before."
      default: return ''
    }
  },

  gap: (g) => {
    if (g.kind !== 'gap') return ''
    switch (g.reason) {
      case 'unsupported-framework': return `I can't read ${g.subject} yet, so anything it creates is missing from this list.`
      case 'parse-error': return `I couldn't read ${g.subject}, so I don't know what's in it.`
      case 'computed-route-path': return `A web address in ${g.subject} is put together while the app runs, so I can't tell you what it is.`
      case 'unresolved-route-prefix': return `The web address in ${g.subject} has a prefix added somewhere else, so the real one is longer than what I show.`
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
  // The off switch gets its own line, and the command gets a line of its own
  // under it, so it is never truncated into something that does not run.
  footer: (total, numbered, cols, command) => {
    const count = `${total} change${total === 1 ? '' : 's'} in total`
    const hint = numbered ? 'Ask your agent: "explain #1" or "fix #1"' : ''
    const first = hint === '' ? count : (hint.length + count.length + 9 <= cols - 4 ? `${hint}   ·   ${count}` : hint)
    return `${first}\nDone looking? Ask your agent to run:\n  ${command} seen`
  },

  labels: { top: 'WORTH A LOOK', also: 'ALSO CHANGED', gaps: "WHAT I COULDN'T READ" },
}

export const words = (voice: Voice): Words => (voice === 'plain' ? plain : technical)
