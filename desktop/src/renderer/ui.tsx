import type { ReactNode } from 'react'

export function Section({ title, count, action, children, note }: { title: string; count?: number; action?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="section">
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
export function Status({ status }: { status: string | null }) {
  if (status === null) return <span className="pill pill-quiet">no status</span>
  const needsYou = status === 'VERIFY-PENDING' || status === 'BLOCKED'
  return <span className={`pill ${needsYou ? 'pill-accent' : status === 'DONE' ? 'pill-quiet' : 'pill-outline'}`}>{status}</span>
}

export function Button({ children, onClick, primary, disabled, title }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`btn ${primary ? 'btn-primary' : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
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
