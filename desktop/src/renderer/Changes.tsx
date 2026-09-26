import { useState } from 'react'
import type { ChangeView } from '../shared/api.js'

/** Structural changes, one per row: what a PM reads first, then the checks
 *  as the code writes them, then where. */
export function ChangeList({ changes, limit }: { changes: readonly ChangeView[]; limit?: number }) {
  const [all, setAll] = useState(false)
  const shown = all || limit === undefined ? changes : changes.slice(0, limit)
  return (
    <div className="changes">
      {shown.map((c, i) => <ChangeRow key={`${c.kind}:${c.title}:${i}`} change={c} />)}
      {!all && limit !== undefined && changes.length > limit && (
        <button type="button" className="more" onClick={() => setAll(true)}>Show all {changes.length.toLocaleString()}</button>
      )}
    </div>
  )
}

function ChangeRow({ change: c }: { change: ChangeView }) {
  const open = Array.isArray(c.checks) && c.checks.length === 0 && c.type !== 'removed'
  return (
    <div className={`change change-${c.type}`}>
      <span className={`change-type ${c.type === 'added' ? 'is-new' : ''}`}>{c.type === 'added' ? 'New' : c.type === 'removed' ? 'Gone' : 'Changed'}</span>
      <div className="change-main">
        <div className="change-title"><span className={c.kind === 'route' || c.kind === 'code' ? 'code' : ''}>{c.title}</span></div>
        <div className={`change-detail ${open ? 'accent-text' : ''}`}>
          {c.kind === 'route' && Array.isArray(c.checks) && c.checks.length > 0
            ? c.checks.map((k, i) => <span key={i} className="code dim check">{k}</span>)
            : c.detail}
          {c.count !== undefined && <span className="count-note">{c.count}</span>}
        </div>
      </div>
      <span className="where code dim" title={c.where}>{c.where}</span>
    </div>
  )
}
