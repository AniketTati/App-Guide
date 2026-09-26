import { useState, type ReactNode } from 'react'

export function Section({ title, count, action, children, note, quiet }: { title: string; count?: number; action?: ReactNode; children: ReactNode; note?: ReactNode; quiet?: boolean }) {
  return (
    <section className={`section ${quiet ? 'quiet' : ''}`}>
      <header className="section-head">
        <h2>{title}{count !== undefined && <span className="count">{count.toLocaleString()}</span>}</h2>
        {action !== undefined && <div className="section-action">{action}</div>}
      </header>
      {note !== undefined && <p className="section-note">{note}</p>}
      <div className="section-body">{children}</div>
    </section>
  )
}

/** A task's status, in the tracker's own word. Only a status that means
 *  "you act next" takes the accent. */
export function Status({ status, note }: { status: string | null; note?: string | null }) {
  if (status === null) return <span className="pill pill-quiet">no status</span>
  const needsYou = status === 'VERIFY-PENDING' || status === 'BLOCKED'
  return <span className={`pill ${needsYou ? 'pill-accent' : status === 'DONE' ? 'pill-quiet' : 'pill-outline'}`} title={note ?? undefined}>{status}{note != null && note !== '' ? ` · ${note}` : ''}</span>
}

/** "Critical (authorization bypass)" -> "Critical". */
export function Severity({ value }: { value: string | null }) {
  if (value === null) return null
  const word = /^(critical|high|medium|low)(?:[-–](critical|high|medium|low))?/i.exec(value)?.[0] ?? value
  return <span className="sev" title={value}>{word}</span>
}

export function Button({ children, onClick, primary, disabled, title, small }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string; small?: boolean }) {
  return <button type="button" className={`btn ${primary ? 'btn-primary' : ''} ${small ? 'btn-small' : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="code">{children}</code>
}

export function Spinner({ label }: { label: string }) {
  return <div className="loading"><span className="dot" /><span>{label}</span></div>
}

/** Something went wrong: what, in words, and a way to try again. */
export function Problem({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <strong>{title}</strong>
      <p>{detail}</p>
      {onRetry !== undefined && <Button onClick={onRetry}>Try again</Button>}
    </div>
  )
}

/** The first few, and the rest on request. */
export function Some<T>({ items, limit, render, more }: { items: readonly T[]; limit: number; render: (item: T, i: number) => ReactNode; more?: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <>
      {shown.map(render)}
      {!all && items.length > limit && <button type="button" className="more" onClick={() => setAll(true)}>{more ?? 'Show all'} {items.length.toLocaleString()}</button>}
    </>
  )
}

/** `apps/api/src/routes/contracts.ts:83` shown as `contracts.ts:83`; the full path on hover. */
export function Where({ where }: { where: string }) {
  return <span className="where" title={where}>{where.slice(where.lastIndexOf('/') + 1)}</span>
}

export function FileList({ files, limit = 12 }: { files: readonly string[]; limit?: number }) {
  return <div className="files"><Some items={files} limit={limit} render={(f) => <div key={f} className="file"><span className="code">{f}</span></div>} /></div>
}
