import { useCallback, useEffect, useState } from 'react'
import type { HomeView, Project } from '../shared/api.js'
import { api, inApp, onChanged } from './bridge.js'
import { clock } from './format.js'
import { Home } from './Home.js'
import { CheckScreen } from './Check.js'
import { ProductScreen } from './Product.js'
import { WhoCanScreen } from './WhoCan.js'
import { AskSheet, type Pick } from './Ask.js'
import { Button, Spinner } from './ui.js'

type Screen = { name: 'home' } | { name: 'product' } | { name: 'who' } | { name: 'check'; workId: string }

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [home, setHome] = useState<HomeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [asking, setAsking] = useState<Pick[] | null>(null)

  // ⌘N anywhere: ask for a change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setAsking((a) => a ?? []) } }
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
  // When the app notices new commits between looks, Home re-reads itself.
  useEffect(() => onChanged((id) => { if (id === current && screen.name === 'home') void load(id) }), [current, screen, load])

  const add = async (): Promise<void> => {
    const p = await api.addProject()
    if (p === null) return
    const ps = await api.projects()
    setProjects(ps)
    setScreen({ name: 'home' })
    setHome(null)
    setCurrent(p.id)
  }

  if (projects === null) return <Frame><div className="center"><Spinner label="Starting…" /></div></Frame>
  if (projects.length === 0) return <Frame><Welcome onOpen={() => void add()} /></Frame>
  const project = projects.find((p) => p.id === current) ?? projects[0]!

  return (
    <Frame
      action={<button type="button" className="btn btn-primary topbar-action" onClick={() => setAsking([])}>Ask for a change <span className="kbd">⌘N</span></button>}
      title={project.name}
      subtitle={home !== null && home.project.id === project.id ? `against ${home.base}` : undefined}
      side={
        <nav className="nav">
          <button type="button" className={`nav-item ${screen.name === 'home' ? 'active' : ''}`} onClick={() => setScreen({ name: 'home' })}>
            Home{home !== null && home.waiting.length > 0 && <span className="badge">{home.waiting.length}</span>}
          </button>
          <button type="button" className={`nav-item ${screen.name === 'product' ? 'active' : ''}`} onClick={() => setScreen({ name: 'product' })}>Product</button>
          <button type="button" className={`nav-item ${screen.name === 'who' ? 'active' : ''}`} onClick={() => setScreen({ name: 'who' })}>Who can do what</button>
          <div className="nav-group">Products</div>
          {projects.map((p) => (
            <button type="button" key={p.id} className={`nav-item nav-product ${p.id === project.id ? 'active' : ''}`} title={p.path}
              onClick={() => { if (p.id !== project.id) { setHome(null); setScreen({ name: 'home' }); setCurrent(p.id) } else setScreen({ name: 'home' }) }}>
              {p.name}
            </button>
          ))}
          {inApp() && <button type="button" className="nav-item nav-add" onClick={() => void add()}>+ Open another product</button>}
        </nav>
      }
      status={home !== null && home.project.id === project.id ? <StatusBar home={home} /> : null}
    >
      {error !== null && <div className="error"><strong>Couldn’t read {project.name}.</strong> {error} <Button onClick={() => void load(project.id)}>Try again</Button></div>}
      {screen.name === 'home' && (home === null || home.project.id !== project.id
        ? (loading && <div className="center"><Spinner label={`Reading ${project.name}… The first read takes about ten seconds; after that it’s quick.`} /></div>)
        : <Home home={home} refreshing={loading} onRefresh={() => void load(project.id)} onCheck={(workId) => setScreen({ name: 'check', workId })}
            onSeen={async () => { await api.markSeen(project.id); await load(project.id) }} />)}
      {screen.name === 'product' && <ProductScreen projectId={project.id} onAsk={(picks) => setAsking(picks)} />}
      {screen.name === 'who' && <WhoCanScreen projectId={project.id} />}
      {asking !== null && <AskSheet projectId={project.id} initial={asking} onClose={() => setAsking(null)} />}
      {screen.name === 'check' && (
        <CheckScreen projectId={project.id} workId={screen.workId} onBack={() => { setScreen({ name: 'home' }); void load(project.id) }} />
      )}
    </Frame>
  )
}

function Frame({ children, side, title, subtitle, status, action }: { children: React.ReactNode; side?: React.ReactNode; title?: string; subtitle?: string | undefined; status?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`app ${inApp() ? 'in-app' : ''}`}>
      <header className="topbar">
        <div className="topbar-title">{title ?? 'App Guide'}{subtitle !== undefined && <span className="topbar-sub">{subtitle}</span>}</div>
        {action !== undefined && <div className="topbar-right">{action}</div>}
      </header>
      <div className="body">
        {side !== undefined && <aside className="side">{side}</aside>}
        <main className="main">{children}</main>
      </div>
      {status !== undefined && status !== null && <footer className="statusbar">{status}</footer>}
    </div>
  )
}

function StatusBar({ home }: { home: HomeView }) {
  const shown = home.blind.slice(0, 3)
  return (
    <>
      <span className="status-label">Can’t read</span>
      {home.blind.length === 0
        ? <span>everything on main was readable</span>
        : shown.map((b, i) => <span key={i} className="status-item" title={`${b.text}\nfirst one: ${b.example}`}><span className="hatch" />{b.short}</span>)}
      {home.blind.length > shown.length && <span className="status-more" title={home.blind.slice(shown.length).map((b) => b.text).join('\n')}>+{home.blind.length - shown.length} more</span>}
      <span className="status-spacer" />
      <span className="status-read">read {clock(home.readAt)}</span>
    </>
  )
}

function Welcome({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="welcome">
      <h1>See what’s in your product — and what just changed.</h1>
      <p>App Guide reads your product’s code on this Mac and shows you what’s waiting on you, the work Claude has in flight, and what each piece of work actually changed — before it merges. Nothing leaves your Mac.</p>
      <Button primary onClick={onOpen}>Open your product…</Button>
      <p className="welcome-hint">Choose the folder your code lives in — the one Claude works in.</p>
    </div>
  )
}
