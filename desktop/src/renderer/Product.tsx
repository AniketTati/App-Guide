import { useEffect, useMemo, useState } from 'react'
import type { ProductView, RouteRow, ScreenRow } from '../shared/api.js'
import { api } from './bridge.js'
import { plural } from './format.js'
import { Empty, Spinner } from './ui.js'

type Selection = { kind: 'screen'; screen: ScreenRow } | { kind: 'behind' } | { kind: 'layout' }

export function ProductScreen({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProductView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    setView(null)
    void api.product(projectId).then((v) => {
      setView(v)
      const first = v.groups[0]?.screens[0]
      if (first !== undefined) setSel({ kind: 'screen', screen: first })
    }).catch((e: Error) => setError(e.message))
  }, [projectId])

  const groups = useMemo(() => {
    if (view === null) return []
    const q = filter.trim().toLowerCase()
    if (q === '') return view.groups
    // Search by what a PM types: a screen's name, its address, or a route.
    return view.groups.map((g) => ({ ...g, screens: g.screens.filter((s) =>
      s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) ||
      s.routes.some((r) => `${r.method} ${r.path}`.toLowerCase().includes(q) || r.data.some((d) => d.table.toLowerCase().includes(q)))) }))
      .filter((g) => g.screens.length > 0)
  }, [view, filter])

  if (error !== null) return <div className="page"><div className="error">{error}</div></div>
  if (view === null) return <div className="center"><Spinner label="Reading what the product on main does — screens, routes, data, roles. The first time takes about ten seconds." /></div>

  const screens = view.groups.reduce((n, g) => n + g.screens.length, 0)
  const routes = new Set([...view.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...view.behind, ...view.layout].map((r) => `${r.method} ${r.path}`)).size
  return (
    <div className="split">
      <div className="outline">
        <div className="outline-head">
          <h1>Product</h1>
          <p className="lede">On <span className="code">{view.base}</span> · {plural(screens, 'screen')} · {plural(routes, 'route')}</p>
          <input className="search" placeholder="Find a screen, a route, or data…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {view.unmatched.length > 0 && (
          <div className="finding">
            <strong>{view.unmatched.length === 1 ? 'A screen calls a route that doesn’t exist' : `${view.unmatched.length} calls reach no route`}</strong>
            {view.unmatched.slice(0, 3).map((u, i) => <div key={i}><span className="code">{u.method} {u.path}</span> <span className="dim">— {u.where}</span></div>)}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="outline-group">
            <div className="outline-label" title={g.note}>{g.label}</div>
            {g.screens.map((s) => {
              const open = s.routes.filter((r) => r.noCheck).length
              const active = sel?.kind === 'screen' && sel.screen.path === s.path && sel.screen.app === s.app
              return (
                <button key={`${s.app}:${s.path}`} type="button" className={`outline-row ${active ? 'active' : ''}`} onClick={() => setSel({ kind: 'screen', screen: s })}>
                  <span className="outline-name">{s.name}</span>
                  <span className="outline-path code">{s.path}</span>
                  <span className="outline-meta" title={`${s.routes.length} routes${open > 0 ? `, ${open} with no check found` : ''}`}>{open > 0 ? <span className="accent-text">{open} with no check · </span> : null}{s.routes.length}</span>
                </button>
              )
            })}
          </div>
        ))}
        {filter === '' && (
          <div className="outline-group">
            <div className="outline-label">Behind the scenes</div>
            <button type="button" className={`outline-row ${sel?.kind === 'behind' ? 'active' : ''}`} onClick={() => setSel({ kind: 'behind' })}>
              <span className="outline-name">Routes no screen calls</span>
              <span className="outline-path">callbacks, webhooks, API keys, health</span>
              <span className="outline-meta">{view.behind.length}</span>
            </button>
            {view.layout.length > 0 && (
              <button type="button" className={`outline-row ${sel?.kind === 'layout' ? 'active' : ''}`} onClick={() => setSel({ kind: 'layout' })}>
                <span className="outline-name">Every signed-in screen</span>
                <span className="outline-path">calls made by the layout around them</span>
                <span className="outline-meta">{view.layout.length}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="trace">
        {sel === null ? <Empty>Choose a screen to see what it can do.</Empty>
          : sel.kind === 'screen' ? <ScreenTrace screen={sel.screen} />
          : sel.kind === 'behind' ? <RouteSet title="Routes no screen calls" note="Reached some other way — by the agents service, a webhook, an API key, a monitor — or not at all." routes={view.behind} />
          : <RouteSet title="Every signed-in screen" note="Called by the layout every signed-in screen sits in, so they aren’t listed under each one." routes={view.layout} />}
      </div>
    </div>
  )
}

function ScreenTrace({ screen: s }: { screen: ScreenRow }) {
  return (
    <div className="trace-body">
      <h2 className="trace-title">{s.name}</h2>
      <p className="lede"><span className="code">{s.path}</span> · {s.signIn === 'required' ? 'needs sign-in' : s.signIn === 'none' ? 'no sign-in' : 'sign-in not known'}{s.component !== null && s.component !== s.name ? ` · ${s.component}` : ''}</p>
      <p className="source">{s.where}</p>
      <RouteList title="What it can do" routes={s.routes} empty="It calls no route of its own — what it shows comes through the layout or shared pieces." />
    </div>
  )
}

function RouteSet({ title, note, routes }: { title: string; note: string; routes: readonly RouteRow[] }) {
  return (
    <div className="trace-body">
      <h2 className="trace-title">{title}</h2>
      <p className="lede">{note}</p>
      <RouteList title="Routes" routes={routes} empty="None." />
    </div>
  )
}

function RouteList({ title, routes, empty }: { title: string; routes: readonly RouteRow[]; empty: string }) {
  return (
    <section className="section">
      <header className="section-head"><h2>{title}<span className="count">{routes.length}</span></h2></header>
      {routes.length === 0 ? <Empty>{empty}</Empty> : routes.map((r) => <RouteItem key={`${r.method} ${r.path}`} route={r} />)}
    </section>
  )
}

function RouteItem({ route: r }: { route: RouteRow }) {
  const writes = r.data.filter((d) => d.kind === 'write')
  const reads = r.data.filter((d) => d.kind === 'read')
  return (
    <div className="route">
      <div className="route-title"><span className="code">{r.method} {r.path}</span>{r.noCheck && <span className="accent-text route-flag">no check found</span>}</div>
      {r.who !== null ? (
        <div className="route-line"><span className="label">Who</span><span className="route-value">{r.who.length === 0 ? <span className="dim">no role has this permission</span> : r.who.map((w) => <span key={w.role} className="role">{w.role}{w.scope !== null && w.scope !== 'org' ? <span className="dim"> · {w.scope}</span> : null}</span>)}</span></div>
      ) : Array.isArray(r.checks) && r.checks.length > 0 ? (
        <div className="route-line"><span className="label">Checks</span><span className="route-value">{r.checks.map((c, i) => <span key={i} className="code dim check">{c}</span>)}</span></div>
      ) : null}
      {r.data.length > 0 && (
        <div className="route-line"><span className="label">Data</span>
          <span className="route-value">
            {writes.length > 0 && <span>changes {writes.map((d) => d.table).join(', ')}</span>}
            {reads.length > 0 && <span className="dim">{writes.length > 0 ? ' · ' : ''}reads {reads.map((d) => d.table).join(', ')}</span>}
          </span>
        </div>
      )}
      <div className="route-line source">{r.where}</div>
    </div>
  )
}
