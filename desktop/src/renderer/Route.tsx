import { useState, type ReactNode } from 'react'
import { Where } from './ui.js'

export interface RouteLineProps {
  method: string
  path: string
  checks: string[] | 'unresolved' | undefined
  who: { role: string; scope: string | null }[] | null | undefined
  /** Every role in the table, to say "all 9 roles" or "all but VIEWER". */
  roles: readonly string[]
  data?: { table: string; kind: 'write' | 'read'; via: string | null }[] | undefined
  where: string
  /** In a Check: New, Gone or Changed. */
  type?: 'added' | 'removed' | 'changed' | undefined
  /** Plain words for what changed. */
  detail?: string | undefined
  /** Viewing the product as one role: whether that role may make this call. */
  as?: string | null
  /** Marked "public on purpose" by the PM. */
  publicOk?: boolean
  via?: string | null | undefined
  /** Buttons for the open row: "Public on purpose", "Make a task". */
  actions?: ReactNode
}

/**
 * One route, one line: method · path · who may call it · where. Everything
 * else — each check as written, every role, the data — opens under it. The
 * same on every screen, so a route reads the same wherever it appears.
 */
export function RouteLine(p: RouteLineProps) {
  const [open, setOpen] = useState(false)
  const none = Array.isArray(p.checks) && p.checks.length === 0 && p.type !== 'removed'
  const writes = p.data?.filter((d) => d.kind === 'write').map((d) => d.table) ?? []
  const reads = p.data?.filter((d) => d.kind === 'read').map((d) => d.table) ?? []
  const refused = p.as != null && p.who != null && !p.who.some((w) => w.role === p.as)
  const scoped = p.as != null ? p.who?.find((w) => w.role === p.as && w.scope !== null && w.scope !== 'org') : undefined
  const who = p.checks === 'unresolved' ? <><span className="hatch" /> checks not readable</>
    : none ? (p.publicOk === true ? 'open — public on purpose' : 'no check found')
    : p.as != null && p.who != null ? (refused ? `not allowed for ${p.as}` : scoped !== undefined ? `${p.as} — ${scoped.scope} only` : `${p.as} can`)
    : whoSummary(p.who, p.roles, p.checks)
  return (
    <div className={`rl ${p.type === 'removed' ? 'rl-gone' : ''}`}>
      <button type="button" className="rl-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {p.type !== undefined && <span className={`rl-type ${p.type === 'added' ? 'rl-new' : ''}`}>{p.type === 'added' ? 'New' : p.type === 'removed' ? 'Gone' : 'Changed'}</span>}
        <span className="rl-method">{p.method}</span>
        <Path path={p.path} />
        <span className={`rl-who ${none && p.publicOk !== true ? 'accent-text' : refused ? 'refused' : ''}`}>{who}</span>
        <Where where={p.where} />
      </button>
      {open && (
        <div className="rl-more">
          {p.detail !== undefined && p.detail !== '' && <Line label="">{p.detail}</Line>}
          {p.who != null && <Line label="Who">{p.who.length === 0 ? <span className="dim">no role has this permission</span> : p.roles.length > 0
            ? p.roles.map((r) => { const w = p.who!.find((x) => x.role === r); return <span key={r} className={`role ${w === undefined ? 'off' : ''}`}>{r}{w !== undefined && w.scope !== null && w.scope !== 'org' ? ` · ${w.scope} only` : ''}</span> })
            : p.who.map((w) => <span key={w.role} className="role">{w.role}</span>)}</Line>}
          {Array.isArray(p.checks) && p.checks.length > 0 && <Line label="Checks">{p.checks.map((c, i) => <span key={i} className="code dim">{c === 'in-handler check' ? 'checks inside its own code' : c}</span>)}</Line>}
          {(writes.length > 0 || reads.length > 0) && <Line label="Data">{writes.length > 0 && <span>changes {writes.join(', ')}</span>}{reads.length > 0 && <span className="dim">reads {reads.join(', ')}</span>}</Line>}
          {p.via != null && <Line label="From">{p.via}</Line>}
          <Line label="Where"><span className="code dim">{p.where}</span></Line>
          {p.actions !== undefined && <div className="rl-actions">{p.actions}</div>}
        </div>
      )}
    </div>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rl-line"><span className="label">{label}</span><span className="rl-value">{children}</span></div>
}

/** `/api/v1/contracts/:id` with the prefix most routes share set back. */
export function Path({ path }: { path: string }) {
  const m = /^(\/api\/v\d+)(\/.*)?$/.exec(path)
  return <span className="rl-path code" title={path}>{m === null ? path : <><span className="dim">{m[1]}</span>{m[2] ?? ''}</>}</span>
}

/** "all 9 roles", "all but VIEWER", "ADMIN, LEGAL_OPS +3" — and who is kept to their own. */
export function whoSummary(who: { role: string; scope: string | null }[] | null | undefined, roles: readonly string[], checks: string[] | 'unresolved' | undefined): string {
  if (who == null) {
    if (!Array.isArray(checks) || checks.length === 0) return ''
    const first = checks[0] === 'in-handler check' ? 'checks in its own code' : checks[0]!.replace(/\(.*$/, '')
    return `${first}${checks.length > 1 ? ` +${checks.length - 1}` : ''}`
  }
  if (who.length === 0) return 'no role has this permission'
  const own = who.filter((w) => w.scope !== null && w.scope !== 'org').map((w) => w.role)
  const ownNote = own.length === 0 ? '' : ` · ${own.length === 1 ? own[0] : `${own.length} roles`} own only`
  if (roles.length > 0 && who.length === roles.length) return `all ${roles.length} roles${ownNote}`
  const missing = roles.filter((r) => !who.some((w) => w.role === r))
  if (roles.length > 0 && missing.length <= 2) return `all but ${missing.join(', ')}${ownNote}`
  return `${who.slice(0, 2).map((w) => w.role).join(', ')}${who.length > 2 ? ` +${who.length - 2}` : ''}${ownNote}`
}
