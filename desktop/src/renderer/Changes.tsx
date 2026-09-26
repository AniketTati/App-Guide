import type { ChangeView } from '../shared/api.js'
import { RouteLine } from './Route.js'
import { Some, Where } from './ui.js'

/**
 * Structural changes, one per row. A route is a RouteLine — the same line as
 * everywhere else; anything else is what changed, then its plain words, then
 * where.
 */
export function ChangeList({ changes, limit, roles = [] }: { changes: readonly ChangeView[]; limit?: number; roles?: readonly string[] }) {
  return (
    <div className="changes">
      <Some items={changes} limit={limit ?? changes.length} render={(c, i) => c.kind === 'route'
        ? <RouteLine key={`${c.title}:${i}`} type={c.type} method={c.title.split(' ')[0]!} path={c.title.slice(c.title.indexOf(' ') + 1)}
            checks={c.checks} who={c.type === 'removed' ? undefined : c.who} roles={roles} data={c.data} where={c.where} detail={c.detail} />
        : <ChangeRow key={`${c.kind}:${c.title}:${i}`} change={c} />} />
    </div>
  )
}

function ChangeRow({ change: c }: { change: ChangeView }) {
  return (
    <div className={`change change-${c.type}`}>
      <span className={`change-type ${c.type === 'added' ? 'is-new' : ''}`}>{c.type === 'added' ? 'New' : c.type === 'removed' ? 'Gone' : 'Changed'}</span>
      <div className="change-main">
        <div className="change-title"><span className={c.kind === 'code' || c.kind === 'package' || c.kind === 'service' ? 'code' : ''}>{c.title}</span></div>
        {(c.detail !== '' || c.count !== undefined) && (
          <div className="change-detail">{c.detail}{c.count !== undefined && <span className="count-note">{c.count}</span>}</div>
        )}
      </div>
      <Where where={c.where} />
    </div>
  )
}
