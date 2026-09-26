import { useCallback, useEffect, useState } from 'react'
import type { ProductView, RolesView, RouteRow } from '../shared/api.js'
import { api } from './bridge.js'
import { plural } from './format.js'
import { RouteLine } from './Route.js'
import { Empty, Problem, Spinner } from './ui.js'

type Table = RolesView['tables'][number]
type Cell = { actions: string[]; scope: string | null }

export function WhoCanScreen({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProductView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [table, setTable] = useState(0)
  const [by, setBy] = useState<'data' | 'screen'>('data')
  const [cell, setCell] = useState<{ role: string; row: string } | null>(null)

  const load = useCallback(() => { setView(null); setError(null); void api.product(projectId).then(setView).catch((e: Error) => setError(e.message)) }, [projectId])
  useEffect(load, [load])

  if (error !== null) return <div className="page"><Problem title="Couldn’t read who can do what." detail={error} onRetry={load} /></div>
  if (view === null) return <div className="center"><Spinner label="Reading who can do what…" /></div>
  const roles = view.roles
  if (roles === null) return <div className="page"><h1>Who can do what</h1><Empty>I didn’t find a table of roles and permissions in this product’s code.</Empty></div>
  const t = roles.tables[table] ?? roles.tables[0]!
  const everything = t.rows.find((r) => r.resource === '*')
  const rows = t.rows.filter((r) => r.resource !== '*')
  const wide = t.roles.flatMap((role) => (everything?.cells[role] ?? []).map((c) => `${role} can ${c.actions.includes('*') ? 'do everything' : `${c.actions.join(', ')} everything`}${c.scope !== null && c.scope !== 'org' ? ` (${c.scope} only)` : ''}`))
  const opened = cell === null ? [] : routesFor(roles, t, cell.role, cell.row)

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Who can do what</h1>
          <p className="lede">{wide.length > 0 ? `${wide.join('. ')}. ` : ''}The rest, as <span className="code">{t.name}</span> sets them in <span className="code dim">{t.where.slice(t.where.lastIndexOf('/') + 1)}</span> — the defaults each customer’s admin may change.</p>
        </div>
        <div className="head-actions">
          {roles.tables.length > 1 && (
            <div className="seg">{roles.tables.map((x, i) => <button key={x.name} type="button" className={i === table ? 'on' : ''} onClick={() => { setTable(i); setCell(null) }}>{words(x.name)}</button>)}</div>
          )}
          <div className="seg">
            <button type="button" className={by === 'data' ? 'on' : ''} onClick={() => { setBy('data'); setCell(null) }}>By data</button>
            <button type="button" className={by === 'screen' ? 'on' : ''} onClick={() => { setBy('screen'); setCell(null) }}>By screen</button>
          </div>
        </div>
      </div>

      {by === 'data' ? (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead><tr><th>{t.roles.length} roles</th>{t.roles.map((r) => <th key={r}><Role name={r} /></th>)}</tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.resource}>
                  <th>{row.resource}</th>
                  {t.roles.map((role) => {
                    const cells = row.cells[role] ?? []
                    const n = cells.length === 0 ? 0 : routesFor(roles, t, role, row.resource).length
                    return (
                      <td key={role} className={cell?.role === role && cell.row === row.resource ? 'active' : ''}>
                        {cells.length === 0 ? <span className="dim">—</span> : (
                          <button type="button" onClick={() => setCell({ role, row: row.resource })} title={`${plural(n, 'route')} this opens`}>
                            {cells.map((c, i) => <Grant key={i} cell={c} />)}
                            <span className="cell-count">{plural(n, 'route')}</span>
                          </button>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <p className="note">For each screen, how many of the calls it can make each role isn’t allowed to. A screen usually hides those buttons from people who can’t use them — so a count is where to look, not a fault.</p>
          <ByScreen view={view} table={t} onPick={(role, row) => setCell({ role, row })} picked={cell} />
        </>
      )}

      {cell !== null && (
        <section className="section">
          <header className="section-head"><h2>{by === 'data' ? `What ${cell.role} can do with ${cell.row}` : `${cell.row}, as ${cell.role}`}<span className="count">{by === 'data' ? opened.length : undefined}</span></h2></header>
          {by === 'data'
            ? (opened.length === 0 ? <Empty>No route checks this permission.</Empty> : (
              <div className="changes">{opened.map((r) => {
                const row = rowsByKey(view).get(`${r.method} ${r.path}`)
                return <RouteLine key={`${r.method} ${r.path}`} method={r.method} path={r.path} checks={row?.checks} who={row?.who} roles={t.roles} data={row?.data} where={row?.where ?? ''} as={cell.role}
                  detail={`needs ${r.permission}${r.scope !== null && r.scope !== 'org' ? ` — ${cell.role} only on their ${r.scope} records` : ''}`} />
              })}</div>
            ))
            : <ScreenAs view={view} screen={cell.row} role={cell.role} roles={t.roles} />}
        </section>
      )}
    </div>
  )
}

/** "view, create" and, under it, "own only". */
function Grant({ cell: c }: { cell: Cell }) {
  return (
    <span className="grant">
      {c.actions.includes('*') ? 'everything' : c.actions.join(', ')}
      {c.scope !== null && c.scope !== 'org' && <span className="own">{c.scope} only</span>}
    </span>
  )
}

/** Each signed-in screen, and whether each role can make every call it makes. */
function ByScreen({ view, table, onPick, picked }: { view: ProductView; table: Table; onPick: (role: string, screen: string) => void; picked: { role: string; row: string } | null }) {
  const screens = view.groups.filter((g) => !g.note?.startsWith('A separate app')).flatMap((g) => g.screens).filter((s) => s.signIn !== 'none' && s.routes.length > 0)
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead><tr><th>{screens.length} screens</th>{table.roles.map((r) => <th key={r}><Role name={r} /></th>)}</tr></thead>
        <tbody>
          {screens.map((s) => (
            <tr key={s.path}>
              <th title={s.path}>{s.name}</th>
              {table.roles.map((role) => {
                const known = s.routes.filter((r) => r.who !== null)
                const refused = known.filter((r) => !r.who!.some((w) => w.role === role)).length
                const own = known.filter((r) => r.who!.some((w) => w.role === role && w.scope !== null && w.scope !== 'org')).length
                return (
                  <td key={role} className={picked?.role === role && picked.row === s.name ? 'active' : ''}>
                    <button type="button" onClick={() => onPick(role, s.name)}>
                      <span className="grant">{known.length === 0 ? <span className="dim">—</span> : refused === 0 ? 'everything' : refused === known.length ? <span className="dim">nothing</span> : `${refused} of ${known.length} not allowed`}
                        {own > 0 && refused < known.length && <span className="own">{own} own only</span>}</span>
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScreenAs({ view, screen, role, roles }: { view: ProductView; screen: string; role: string; roles: readonly string[] }) {
  const s = view.groups.flatMap((g) => g.screens).find((x) => x.name === screen)
  if (s === undefined) return null
  return <div className="changes">{s.routes.map((r: RouteRow) => <RouteLine key={`${r.method} ${r.path}`} method={r.method} path={r.path} checks={r.checks} who={r.who} roles={roles} data={r.data} where={r.where} as={role} />)}</div>
}

/** The routes a role's grant on a row opens: the routes whose check names an
 *  action the role has on that resource. */
function routesFor(roles: RolesView, t: Table, role: string, resource: string): { method: string; path: string; permission: string; scope: string | null }[] {
  const cells = t.rows.find((r) => r.resource === resource)?.cells[role] ?? []
  return cells.flatMap((c) => c.actions.flatMap((a) => {
    const keys = a === '*' ? Object.keys(roles.routes).filter((k) => k.endsWith(` ${resource}`)) : [`${a} ${resource}`]
    return keys.flatMap((k) => (roles.routes[k] ?? []).map((r) => ({ ...r, permission: k, scope: c.scope })))
  }))
}

const byKey = new WeakMap<ProductView, Map<string, RouteRow>>()
function rowsByKey(v: ProductView): Map<string, RouteRow> {
  let m = byKey.get(v)
  if (m === undefined) {
    m = new Map()
    for (const r of [...v.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...v.behind, ...v.layout, ...v.shared.flatMap((s) => s.routes)]) m.set(`${r.method} ${r.path}`, r)
    byKey.set(v, m)
  }
  return m
}

/** ROLE_PERMISSIONS -> "Role permissions"; API stays API. */
const words = (name: string): string => {
  const w = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim().replace(/\b(api|ai|url|id|sso)\b/g, (m) => m.toUpperCase())
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** LEGAL_COUNSEL may break after its underscore, never inside a word. */
const Role = ({ name }: { name: string }) => <>{name.split('_').map((part, i, all) => <span key={i}>{part}{i < all.length - 1 ? <>_<wbr /></> : null}</span>)}</>
