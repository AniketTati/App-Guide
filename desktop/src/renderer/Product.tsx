import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProductView, RouteRow, ScreenRow } from '../shared/api.js'
import { api } from './bridge.js'
import { plural } from './format.js'
import { RouteLine } from './Route.js'
import { Empty, Problem, Some, Spinner } from './ui.js'
import type { AskPrefill } from './Ask.js'

type Selection = { kind: 'screen'; screen: ScreenRow } | { kind: 'behind' } | { kind: 'layout' } | { kind: 'shared' } | { kind: 'jobs' } | { kind: 'running' } | { kind: 'open' }

const key = (r: { method: string; path: string }): string => `${r.method} ${r.path}`

export function ProductScreen({ projectId, start, onAsk }: { projectId: string; start?: 'open'; onAsk: (prefill: AskPrefill) => void }) {
  const [view, setView] = useState<ProductView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection | null>(null)
  const [filter, setFilter] = useState('')
  const [as, setAs] = useState<string | null>(null)
  const [publicOk, setPublicOk] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    setView(null)
    setError(null)
    void api.product(projectId).then((v) => {
      setView(v)
      setPublicOk(new Set(v.publicOk ?? []))
      const first = v.groups[0]?.screens[0]
      setSel(start === 'open' ? { kind: 'open' } : first !== undefined ? { kind: 'screen', screen: first } : null)
    }).catch((e: Error) => setError(e.message))
  }, [projectId, start])
  useEffect(load, [load])

  const all = useMemo(() => view === null ? [] : allRoutes(view), [view])
  const groups = useMemo(() => {
    if (view === null) return []
    const q = filter.trim().toLowerCase()
    if (q === '') return view.groups
    // Search by what a PM types: a screen's name, its address, a route, some data.
    const hit = (r: RouteRow): boolean => key(r).toLowerCase().includes(q) || r.data.some((d) => d.table.toLowerCase().includes(q))
    return view.groups.map((g) => ({ ...g, screens: g.screens.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) || s.routes.some(hit)) }))
      .filter((g) => g.screens.length > 0)
  }, [view, filter])

  if (error !== null) return <div className="page"><Problem title="Couldn’t read the product." detail={error} onRetry={load} /></div>
  if (view === null) return <div className="center"><Spinner label="Reading what the product on main does — screens, routes, data, roles. The first time takes about ten seconds." /></div>

  const roles = view.roles?.tables[0]?.roles ?? []
  const main = view.groups.filter((g) => !g.note?.startsWith('A separate app'))
  const other = view.groups.filter((g) => g.note?.startsWith('A separate app') === true)
  const screens = main.reduce((n, g) => n + g.screens.length, 0)
  const open = all.filter((r) => r.noCheck)
  const unreviewed = open.filter((r) => !publicOk.has(key(r))).length
  const q = filter.trim().toLowerCase()
  const behindHit = q === '' ? view.behind : view.behind.filter((r) => key(r).toLowerCase().includes(q))
  const sharedHit = q === '' ? view.shared : view.shared.filter((s) => s.name.toLowerCase().includes(q) || s.routes.some((r) => key(r).toLowerCase().includes(q)))
  const togglePublic = (r: RouteRow): void => {
    const on = !publicOk.has(key(r))
    const next = new Set(publicOk)
    if (on) next.add(key(r))
    else next.delete(key(r))
    setPublicOk(next)
    void api.markPublic(projectId, key(r), on ? 'on' : 'off')
  }
  const line = (r: RouteRow, extra?: { via?: string | null }): React.ReactNode => (
    <RouteLine key={key(r)} method={r.method} path={r.path} checks={r.checks} who={r.who} roles={roles} data={r.data} where={r.where}
      as={as} publicOk={publicOk.has(key(r))} via={extra?.via ?? r.via}
      actions={<>
        {r.noCheck && <button type="button" className="link" onClick={() => togglePublic(r)}>{publicOk.has(key(r)) ? 'Not meant to be public' : 'Public on purpose'}</button>}
        <button type="button" className="link" onClick={() => onAsk({ picks: [{ kind: 'route', key: key(r) }] })}>Make a task about it…</button>
      </>} />
  )

  return (
    <div className="split">
      <div className="outline">
        <div className="outline-head">
          <h1>Product</h1>
          <p className="lede">On <span className="code">{view.base}</span> · {plural(screens, 'screen')}{other.length > 0 ? ` (+${other.reduce((n, g) => n + g.screens.length, 0)} in ${other.map((g) => g.label).join(', ')})` : ''} · {plural(all.length, 'route')}</p>
          <input className="search" placeholder="Find a screen, a route, or some data…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="filters">
            <button type="button" className={`toggle ${sel?.kind === 'open' ? 'on' : ''}`} onClick={() => setSel({ kind: 'open' })}>No check found · {open.length}{unreviewed > 0 && unreviewed < open.length ? ` (${unreviewed} not reviewed)` : ''}</button>
            {roles.length > 0 && (
              <label className="dim">View as{' '}
                <select className="select" value={as ?? ''} onChange={(e) => setAs(e.target.value === '' ? null : e.target.value)}>
                  <option value="">everyone</option>
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
        {view.unmatched.length > 0 && q === '' && (
          <div className="finding">
            <div className="finding-head">{view.unmatched.length === 1 ? 'A call reaches no route' : `${view.unmatched.length} calls reach no route`}</div>
            <p className="dim">The screen asks for something the API doesn’t have, so that part of it never loads.</p>
            {view.unmatched.map((u, i) => (
              <div key={i} className="finding-item">
                <span><span className="code">{u.method} {u.path}</span> <span className="dim">in {u.via ?? u.where.slice(u.where.lastIndexOf('/') + 1)}</span></span>
                <button type="button" className="link" onClick={() => onAsk({ what: `Fix the call to ${u.method} ${u.path}, which no route answers`, why: `It's made in ${u.where}${u.via !== null ? ` (${u.via})` : ''}, so what it loads never appears.`, picks: [] })}>Make a task…</button>
              </div>
            ))}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="outline-group">
            <div className="outline-label" title={g.note}>{g.label}</div>
            {g.screens.map((s) => {
              const noCheck = s.routes.filter((r) => r.noCheck && !publicOk.has(key(r))).length
              const refused = as === null ? 0 : s.routes.filter((r) => r.who !== null && !r.who.some((w) => w.role === as)).length
              const active = sel?.kind === 'screen' && sel.screen.path === s.path && sel.screen.app === s.app
              return (
                <button key={`${s.app}:${s.path}`} type="button" className={`outline-row ${active ? 'active' : ''}`} onClick={() => setSel({ kind: 'screen', screen: s })}>
                  <span className="outline-name">{s.name}</span>
                  <span className="outline-path code">{s.path}</span>
                  <span className="outline-meta">
                    {as !== null ? (refused === 0 ? 'all allowed' : `${refused} of ${s.routes.length} not allowed`)
                      : <>{noCheck > 0 && <span className="accent-text">{noCheck} with no check · </span>}{s.routes.length}</>}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        <div className="outline-group">
          <div className="outline-label">Behind the scenes</div>
          <OutlineRow active={sel?.kind === 'behind'} onClick={() => setSel({ kind: 'behind' })} name="Routes no screen calls" sub="callbacks, webhooks, API keys, health" n={behindHit.length} />
          {view.shared.length > 0 && <OutlineRow active={sel?.kind === 'shared'} onClick={() => setSel({ kind: 'shared' })} name="Parts many screens share" sub={view.shared.map((s) => s.name).join(', ')} n={sharedHit.length} />}
          {view.layout.length > 0 && <OutlineRow active={sel?.kind === 'layout'} onClick={() => setSel({ kind: 'layout' })} name="Around every signed-in screen" sub="the layout, onboarding and the assistant" n={view.layout.length} />}
          {view.background.queues.length > 0 && <OutlineRow active={sel?.kind === 'jobs'} onClick={() => setSel({ kind: 'jobs' })} name="Background jobs" sub={view.background.queues.map((x) => x.name).join(', ')} n={view.background.queues.reduce((n, x) => n + x.jobs.length, 0)} />}
          {view.background.timers.length + view.background.sockets.length > 0 && <OutlineRow active={sel?.kind === 'running'} onClick={() => setSel({ kind: 'running' })} name="Always running" sub="timers and live connections" n={view.background.timers.length + view.background.sockets.length} />}
        </div>
      </div>
      <div className="trace">
        {sel === null ? <Empty>Choose a screen to see what it can do.</Empty>
          : sel.kind === 'screen' ? <ScreenTrace screen={sel.screen} view={view} as={as} line={line} onAsk={() => onAsk({ picks: [{ kind: 'screen', key: sel.screen.path }] })} />
          : sel.kind === 'open' ? (
            <Trace title="No check found" note={`Routes anyone can call without a check I could find. Some are meant to be open — a sign-in page, a webhook, a beacon. Mark those “public on purpose”, and Home counts only the rest.${unreviewed > 0 ? ` ${unreviewed} not reviewed yet.` : ''}`}>
              <div className="changes">{[...open].sort((a, b) => Number(publicOk.has(key(a))) - Number(publicOk.has(key(b)))).map((r) => line(r))}</div>
            </Trace>
          )
          : sel.kind === 'behind' ? <Trace title="Routes no screen calls" note="Reached some other way — by the agents service, a webhook, an API key, a monitor — or not at all."><div className="changes"><Some items={behindHit} limit={60} render={(r) => line(r)} /></div></Trace>
          : sel.kind === 'shared' ? (
            <Trace title="Parts many screens share" note="A dialog or an editor used on three screens or more — listed once here rather than under every screen.">
              {sharedHit.map((s) => (
                <section key={s.file} className="section">
                  <header className="section-head"><h2>{s.name}<span className="count">{s.routes.length}</span></h2></header>
                  <p className="section-note">On {s.screens.join(', ')}</p>
                  <div className="changes">{s.routes.map((r) => line(r))}</div>
                </section>
              ))}
            </Trace>
          )
          : sel.kind === 'jobs' ? <Jobs view={view} />
          : sel.kind === 'running' ? <Running view={view} />
          : <Trace title="Around every signed-in screen" note="Called by what surrounds every signed-in screen — the layout, onboarding, the assistant — so they aren’t listed under each one."><div className="changes">{view.layout.map((r) => line(r, { via: r.via }))}</div></Trace>}
      </div>
    </div>
  )
}

function allRoutes(v: ProductView): RouteRow[] {
  const out = new Map<string, RouteRow>()
  for (const r of [...v.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...v.behind, ...v.layout, ...v.shared.flatMap((s) => s.routes)]) out.set(key(r), r)
  return [...out.values()]
}

function OutlineRow({ active, onClick, name, sub, n }: { active: boolean; onClick: () => void; name: string; sub: string; n: number }) {
  return (
    <button type="button" className={`outline-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="outline-name">{name}</span>
      <span className="outline-path">{sub}</span>
      <span className="outline-meta">{n}</span>
    </button>
  )
}

function Trace({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <div className="trace-body"><h2 className="trace-title">{title}</h2><p className="lede">{note}</p><div className="section">{children}</div></div>
}

function ScreenTrace({ screen: s, view, as, line, onAsk }: { screen: ScreenRow; view: ProductView; as: string | null; line: (r: RouteRow) => React.ReactNode; onAsk: () => void }) {
  const parts = view.shared.filter((p) => p.screens.includes(s.name))
  const refused = as === null ? [] : s.routes.filter((r) => r.who !== null && !r.who.some((w) => w.role === as))
  return (
    <div className="trace-body">
      <div className="trace-head"><h2 className="trace-title">{s.name}</h2><button type="button" className="btn" onClick={onAsk}>Ask for a change here…</button></div>
      <p className="lede"><span className="code">{s.path}</span> · {s.signIn === 'required' ? 'needs sign-in' : s.signIn === 'none' ? 'no sign-in' : 'sign-in not known'}{s.file !== null ? <> · <span className="code dim">{s.file.slice(s.file.lastIndexOf('/') + 1)}</span></> : null}</p>
      {as !== null && s.routes.length > 0 && (
        <p className="sentence">{refused.length === 0 ? `${as} is allowed every call this screen makes.` : `${as} isn’t allowed ${refused.length} of the ${plural(s.routes.length, 'call')} this screen can make${refused.length === s.routes.length ? ' — none of it would work for them' : ''}. The screen may hide those from them; if it doesn’t, they’d see an error.`}</p>
      )}
      <section className="section">
        <header className="section-head"><h2>What it can do<span className="count">{s.routes.length}</span></h2></header>
        {s.routes.length === 0 ? <Empty>It calls no route of its own — what it shows comes through the parts around it.</Empty> : <div className="changes">{s.routes.map(line)}</div>}
      </section>
      {parts.length > 0 && (
        <section className="section">
          <header className="section-head"><h2>Through parts other screens share too<span className="count">{parts.reduce((n, p) => n + p.routes.length, 0)}</span></h2></header>
          {parts.map((p) => <div key={p.file} className="group"><h3>{p.name}</h3><div className="changes">{p.routes.map(line)}</div></div>)}
        </section>
      )}
    </div>
  )
}

function Jobs({ view }: { view: ProductView }) {
  return (
    <div className="trace-body">
      <h2 className="trace-title">Background jobs</h2>
      <p className="lede">Work put on a queue and done later, away from any screen — where much of what the product does can happen unseen.</p>
      {view.background.queues.map((q) => (
        <section key={q.name} className="section">
          <header className="section-head"><h2>{q.name}<span className="count">{q.jobs.length}</span></h2></header>
          <p className="section-note">Done by {q.workers.length === 0 ? 'no worker I could find' : q.workers.map((w) => w.slice(w.lastIndexOf('/') + 1)).join(', ')}{q.repeats > 0 ? ` · ${q.repeats} on a schedule` : ''}</p>
          <div className="files">{q.jobs.map((j) => <div key={j.name} className="file"><span className="code">{j.name}</span><span className="dim">added in {j.addedAt.map((w) => w.slice(w.lastIndexOf('/') + 1)).join(', ')}</span></div>)}</div>
        </section>
      ))}
    </div>
  )
}

function Running({ view }: { view: ProductView }) {
  return (
    <div className="trace-body">
      <h2 className="trace-title">Always running</h2>
      <p className="lede">Started with the app and running for as long as it does.</p>
      <section className="section">
        <div className="files">
          {view.background.timers.map((w) => <div key={w} className="file"><span>A timer started with the app</span><span className="code dim">{w.slice(w.lastIndexOf('/') + 1)}</span></div>)}
          {view.background.sockets.map((s) => <div key={s.where} className="file"><span>A live-connection server ({s.library})</span><span className="code dim">{s.where.slice(s.where.lastIndexOf('/') + 1)}</span></div>)}
        </div>
      </section>
    </div>
  )
}
