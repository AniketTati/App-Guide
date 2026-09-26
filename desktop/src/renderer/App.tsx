import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeView, Project } from '../shared/api.js'
import { api, inApp, onChanged } from './bridge.js'
import { clock, plural } from './format.js'
import { Home } from './Home.js'
import { CheckScreen } from './Check.js'
import { ProductScreen } from './Product.js'
import { WhoCanScreen } from './WhoCan.js'
import { MapScreen } from './Map.js'
import { AskSheet, type AskPrefill } from './Ask.js'
import { Button, Problem, Spinner } from './ui.js'

/**
 * The map is the product; Today is what waits on the PM; Who can do what is
 * the role table. A Check opens on the map, with the full report a click away.
 */
type Screen = { name: 'map' } | { name: 'today' } | { name: 'list'; start?: 'open' } | { name: 'who' } | { name: 'report'; workId: string }

/** Where to start, from the address: #map, #map=<work>, #today, #who, #report=<work>, #ask. */
function fromHash(): { screen: Screen; viewing: string; ask: boolean } {
  const h = decodeURIComponent(window.location.hash.replace(/^#/, ''))
  const none = { viewing: 'main', ask: false }
  if (h === 'today') return { screen: { name: 'today' }, ...none }
  if (h === 'who') return { screen: { name: 'who' }, ...none }
  if (h === 'product' || h === 'list') return { screen: { name: 'list' }, ...none }
  if (h === 'product=open') return { screen: { name: 'list', start: 'open' }, ...none }
  if (h === 'ask') return { screen: { name: 'map' }, viewing: 'main', ask: true }
  if (h.startsWith('map=')) return { screen: { name: 'map' }, viewing: h.slice('map='.length), ask: false }
  if (h.startsWith('check=')) return { screen: { name: 'map' }, viewing: h.slice('check='.length), ask: false }
  if (h.startsWith('report=')) return { screen: { name: 'report', workId: h.slice('report='.length) }, ...none }
  return { screen: { name: 'map' }, ...none }
}

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>(() => fromHash().screen)
  const [viewing, setViewing] = useState<string>(() => fromHash().viewing)
  const [home, setHome] = useState<HomeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [asking, setAsking] = useState<AskPrefill | null>(() => (fromHash().ask ? { picks: [] } : null))
  const ask = (prefill: AskPrefill = { picks: [] }): void => setAsking(prefill)

  // A link to a screen works while the app is open, not only at start.
  useEffect(() => {
    const onHash = (): void => { const h = fromHash(); setScreen(h.screen); setViewing(h.viewing); if (h.ask) setAsking((a) => a ?? { picks: [] }) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // ⌘N anywhere: ask for a change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setAsking((a) => a ?? { picks: [] }) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    void api.projects().then((ps) => {
      setProjects(ps)
      setCurrent((c) => c ?? ps[0]?.id ?? null)
    }).catch((e: Error) => setError(e.message))
  }, [])

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try { setHome(await api.home(id)) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (current !== null) void load(current) }, [current, load])
  // New commits or new work between looks: what waits re-reads itself. Edits
  // Claude is still making refresh it too, but at most every two minutes.
  const lastRead = useRef(0)
  useEffect(() => onChanged((id, moved) => {
    if (id !== current || screen.name === 'report') return
    if (moved.length === 0 || Date.now() - lastRead.current > 120_000) { lastRead.current = Date.now(); void load(id) }
  }), [current, screen, load])

  const add = async (): Promise<void> => {
    const p = await api.addProject()
    if (p === null) return
    const ps = await api.projects()
    setProjects(ps)
    setScreen({ name: 'map' })
    setViewing('main')
    setHome(null)
    setCurrent(p.id)
  }

  if (projects === null) return <Frame><div className="center"><Spinner label="Starting…" /></div></Frame>
  if (projects.length === 0) return <Frame><Welcome onOpen={() => void add()} /></Frame>
  const project = projects.find((p) => p.id === current) ?? projects[0]!
  const mine = home !== null && home.project.id === project.id
  const check = (workId: string): void => { setViewing(workId); setScreen({ name: 'map' }) }

  return (
    <Frame
      left={
        <>
          <select className="product-pick" value={project.id} title={project.path}
            onChange={(e) => { if (e.target.value === '+') { void add(); return } setHome(null); setViewing('main'); setScreen({ name: 'map' }); setCurrent(e.target.value) }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {inApp() && <option value="+">Open another product…</option>}
          </select>
          <nav className="tabs-top">
            <button type="button" className={screen.name === 'map' ? 'on' : ''} onClick={() => setScreen({ name: 'map' })}>Map</button>
            <button type="button" className={screen.name === 'today' ? 'on' : ''} onClick={() => setScreen({ name: 'today' })}>
              Today{mine && waitingCount(home) > 0 && <span className="badge">{waitingCount(home)}</span>}
            </button>
            <button type="button" className={screen.name === 'who' ? 'on' : ''} onClick={() => setScreen({ name: 'who' })}>Who can do what</button>
          </nav>
        </>
      }
      action={<button type="button" className="btn" onClick={() => ask()}>Ask for a change <span className="kbd">⌘N</span></button>}
      status={mine ? <StatusBar home={home} /> : null}
    >
      {error !== null && <div className="page"><Problem title={`Couldn’t read ${project.name}.`} detail={error} onRetry={() => void load(project.id)} /></div>}
      {screen.name === 'map' && (
        <MapScreen key={`${project.id}:${viewing}`} projectId={project.id} product={project.name} work={mine ? home.work.filter((w) => !w.stale) : []}
          viewing={viewing} onViewing={setViewing} onReport={(workId) => setScreen({ name: 'report', workId })} onAsk={ask} />
      )}
      {screen.name === 'today' && (!mine
        ? (loading && <div className="center"><Spinner label={`Reading ${project.name}… The first read takes about ten seconds; after that it’s quick.`} /></div>)
        : <Home home={home} refreshing={loading} onRefresh={() => void load(project.id)} onCheck={check}
            onSeen={() => { void api.markSeen(project.id).then(() => load(project.id)) }}
            onOpenChecks={() => setScreen({ name: 'list', start: 'open' })}
            onAsk={(what, why) => ask({ picks: [], what, why })} />)}
      {screen.name === 'list' && <ProductScreen key={screen.start ?? 'all'} projectId={project.id} {...(screen.start === undefined ? {} : { start: screen.start })} onAsk={ask} />}
      {screen.name === 'who' && <WhoCanScreen projectId={project.id} />}
      {screen.name === 'report' && (
        <CheckScreen projectId={project.id} workId={screen.workId} onBack={() => check(screen.workId)} onAsk={(what, why) => ask({ picks: [], what, why })} />
      )}
      {asking !== null && <AskSheet projectId={project.id} initial={asking} onClose={() => setAsking(null)} />}
    </Frame>
  )
}

function Frame({ children, left, status, action }: { children: React.ReactNode; left?: React.ReactNode; status?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`app ${inApp() ? 'in-app' : ''}`}>
      <header className="topbar">
        {left ?? <div className="topbar-title">App Guide</div>}
        {action !== undefined && <div className="topbar-right">{action}</div>}
      </header>
      <div className="body">
        <main className="main">{children}</main>
      </div>
      {status !== undefined && status !== null && <footer className="statusbar">{status}</footer>}
    </div>
  )
}

/** Tasks waiting, and finished work waiting for a Check. */
const waitingCount = (home: HomeView): number => home.waiting.length + home.work.filter((w) => w.ready).length

/** Parts of the product it can't read, named — "82 Python files, in
 *  apps/agents" — and the finer print on hover. */
function StatusBar({ home }: { home: HomeView }) {
  const parts = home.blind.filter((b) => / files?(, in |$)/.test(b.short) && !/that didn’t parse/.test(b.short))
  const rest = home.blind.filter((b) => !parts.includes(b))
  return (
    <>
      <span className="status-label">Can’t read</span>
      {home.blind.length === 0
        ? <span>everything on main was readable</span>
        : parts.map((b, i) => <span key={i} className="status-item" title={`${b.text}\nfirst one: ${b.example}`}><span className="hatch" />{b.short}</span>)}
      {rest.length > 0 && <span className="status-more" title={rest.map((b) => b.text).join('\n')}>{parts.length > 0 ? `+${rest.length} more` : `${plural(rest.length, 'thing')} I can’t read`}</span>}
      <span className="status-spacer" />
      <span className="status-read">read {clock(home.readAt)}</span>
    </>
  )
}

function Welcome({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="welcome">
      <h1>See your product as a map — and what each piece of work changes on it.</h1>
      <p>App Guide reads your product’s code on this Mac and draws it: its screens, where each leads, the data they change, and who can use them. Check Claude’s work on the same map, pin notes to anything, and send them to Claude. Nothing leaves your Mac.</p>
      <Button primary onClick={onOpen}>Open your product…</Button>
      <p className="welcome-hint">Choose the folder your code lives in — the one Claude works in.</p>
    </div>
  )
}
