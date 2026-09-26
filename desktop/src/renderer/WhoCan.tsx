import { useEffect, useState } from 'react'
import type { ProductView } from '../shared/api.js'
import { api } from './bridge.js'
import { Empty, Spinner } from './ui.js'

export function WhoCanScreen({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProductView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [table, setTable] = useState(0)
  const [cell, setCell] = useState<{ role: string; resource: string } | null>(null)

  useEffect(() => { setView(null); void api.product(projectId).then(setView).catch((e: Error) => setError(e.message)) }, [projectId])

  if (error !== null) return <div className="page"><div className="error">{error}</div></div>
  if (view === null) return <div className="center"><Spinner label="Reading who can do what…" /></div>
  const roles = view.roles
  if (roles === null) return <div className="page"><h1>Who can do what</h1><Empty>I didn’t find a table of roles and permissions in this product’s code.</Empty></div>
  const t = roles.tables[table] ?? roles.tables[0]!
  const actionsFor = (role: string, resource: string): { actions: string[]; scope: string | null }[] => t.rows.find((r) => r.resource === resource)?.cells[role] ?? []
  const opened = cell === null ? [] : actionsFor(cell.role, cell.resource).flatMap((c) => c.actions.flatMap((a) => {
    const keys = a === '*' || cell.resource === '*' ? Object.keys(roles.routes).filter((k) => (a === '*' || k.startsWith(`${a} `)) && (cell.resource === '*' || k.endsWith(` ${cell.resource}`))) : [`${a} ${cell.resource}`]
    return keys.flatMap((k) => (roles.routes[k] ?? []).map((r) => ({ ...r, permission: k, scope: c.scope })))
  }))

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Who can do what</h1>
          <p className="lede">As <span className="code">{t.name}</span> says in <span className="code">{t.where}</span>. These are the defaults: each customer’s admin may change them.</p>
        </div>
        {roles.tables.length > 1 && (
          <div className="tabs">{roles.tables.map((x, i) => <button key={x.name} type="button" className={`tab ${i === table ? 'active' : ''}`} onClick={() => { setTable(i); setCell(null) }}>{x.name}</button>)}</div>
        )}
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead><tr><th />{t.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
          <tbody>
            {t.rows.map((row) => (
              <tr key={row.resource}>
                <th>{row.resource === '*' ? 'everything' : row.resource}</th>
                {t.roles.map((role) => {
                  const cells = row.cells[role] ?? []
                  const active = cell?.role === role && cell.resource === row.resource
                  return (
                    <td key={role} className={active ? 'active' : ''}>
                      {cells.length === 0 ? <span className="dim">—</span> : (
                        <button type="button" onClick={() => setCell({ role, resource: row.resource })}>
                          {cells.map((c, i) => <span key={i} className="grant">{c.actions.map((a) => (a === '*' ? 'everything' : a)).join(' · ')}{c.scope !== null && c.scope !== 'org' ? <em> · {c.scope}</em> : null}</span>)}
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
      {cell !== null && (
        <section className="section">
          <header className="section-head"><h2>What {cell.role} can do with {cell.resource === '*' ? 'everything' : cell.resource}<span className="count">{opened.length}</span></h2></header>
          {opened.length === 0 ? <Empty>No route checks for this permission.</Empty> : (
            <div className="files">{opened.map((r, i) => <div key={i} className="file"><span className="code">{r.method} {r.path}</span><span className="dim">{r.permission}{r.scope !== null && r.scope !== 'org' ? ` · ${r.scope} only` : ''}</span></div>)}</div>
          )}
        </section>
      )}
    </div>
  )
}
