import { Fragment, type ReactNode } from 'react'

/**
 * The little markdown a tracker uses inline — **bold** and `code` — as text,
 * never as HTML: whatever a tracker says is shown, never run.
 */
export function Md({ text = '' }: { text: string | undefined }) {
  const out: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[1] !== undefined ? <strong key={m.index}>{m[1]}</strong> : <code key={m.index} className="code">{m[2]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</>
}

/** A block of tracker text: its lines, bullets kept as bullets. */
export function MdBlock({ text = '' }: { text: string | undefined }) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return (
    <div className="md">
      {lines.map((l, i) => {
        const bullet = /^(\s*)[-*]\s+(.*)$/.exec(l)
        return bullet !== null
          ? <p key={i} className="md-li" style={{ marginLeft: `${Math.min(bullet[1]!.length, 8) * 6}px` }}><Md text={bullet[2]!} /></p>
          : <p key={i}><Md text={l.trim()} /></p>
      })}
    </div>
  )
}
