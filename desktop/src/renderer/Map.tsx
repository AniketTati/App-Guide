import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CheckView, Note, ProductView, RouteRow, WorkView } from '../shared/api.js'
import { api, inApp } from './bridge.js'
import { ago, plural } from './format.js'
import { RouteLine } from './Route.js'
import { Button, Problem, Spinner } from './ui.js'
import { Md } from './Md.js'
import { buildMap, groupBehind, type Card, type Frame, type Link, type ProductMap } from './map/layout.js'
import { notesBrief } from './map/brief.js'
import type { AskPrefill } from './Ask.js'

/**
 * The product as a map: see it, check a piece of work on it, pin notes to
 * any part of it, and send the notes to Claude. Everything here is read from
 * the code; the notes are the PM's own.
 */
export function MapScreen(props: MapProps) {
  return <ReactFlowProvider><MapInner {...props} /></ReactFlowProvider>
}

interface MapProps {
  projectId: string
  product: string
  /** Pieces of work in flight, to check on the map. */
  work: readonly WorkView[]
  /** 'main', or the id of a piece of work to show. */
  viewing: string
  onViewing: (v: string) => void
  onReport: (workId: string) => void
  onAsk: (prefill: AskPrefill) => void
}

type CardData = { card: Card; selected: boolean; dim: boolean; linked: string | null }
type FrameData = { frame: Frame }

const nodeTypes = { card: CardNode, frame: FrameNode }

function MapInner({ projectId, product, work, viewing, onViewing, onReport, onAsk }: MapProps) {
  const [view, setView] = useState<ProductView | null>(null)
  const [check, setCheck] = useState<CheckView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [as, setAs] = useState<string | null>(null)
  const [panel, setPanel] = useState<'details' | 'notes'>('details')
  const [find, setFind] = useState('')
  const flow = useReactFlow()

  const load = useCallback(() => {
    setView(null)
    setCheck(null)
    setError(null)
    setSelected(null)
    const product = viewing === 'main' ? api.product(projectId) : api.workProduct(projectId, viewing)
    void product.then(setView).catch((e: Error) => setError(e.message))
    if (viewing !== 'main') void api.check(projectId, viewing).then(setCheck).catch((e: Error) => setError(e.message))
    void api.notes(projectId).then(setNotes).catch(() => undefined)
  }, [projectId, viewing])
  useEffect(load, [load])

  const here = useMemo(() => notes.filter((n) => n.on === viewing), [notes, viewing])
  const map = useMemo(() => (view === null ? null : buildMap(view, { check, as, notes: here.filter((n) => n.sentAt === null) })), [view, check, as, here])

  const linked = useMemo(() => {
    const out = new Map<string, string>()
    if (map === null || selected === null) return out
    for (const l of map.links) {
      if (l.from === selected) out.set(l.to, l.kind)
      if (l.to === selected) out.set(l.from, l.kind)
    }
    return out
  }, [map, selected])

  const nodes = useMemo((): Node[] => {
    if (map === null) return []
    const frames: Node<FrameData>[] = map.frames.map((f) => ({
      id: f.id, type: 'frame', position: { x: f.x, y: f.y }, data: { frame: f }, draggable: false, selectable: false, zIndex: 0,
      width: f.w, height: f.h, style: { width: f.w, height: f.h },
    }))
    const cards: Node<CardData>[] = map.cards.map((c) => ({
      id: c.id, type: 'card', position: { x: c.x, y: c.y }, draggable: false, zIndex: 1,
      data: { card: c, selected: c.id === selected, dim: selected !== null && c.id !== selected && !linked.has(c.id), linked: linked.get(c.id) ?? null },
      width: c.w, height: c.h, style: { width: c.w, height: c.h },
    }))
    return [...frames, ...cards]
  }, [map, selected, linked])

  const edges = useMemo((): Edge[] => (map === null || selected === null ? [] : map.links.filter((l) => l.from === selected || l.to === selected).map(edgeOf)), [map, selected])

  // Find a card by what the PM types, and bring it into view.
  const focus = useCallback((id: string) => {
    const c = map?.cards.find((x) => x.id === id)
    if (c === undefined) return
    setSelected(id)
    setPanel('details')
    void flow.setCenter(c.x + c.w / 2, c.y + c.h / 2, { zoom: 1.1, duration: 400 })
  }, [map, flow])
  useEffect(() => {
    const q = find.trim().toLowerCase()
    if (q === '' || map === null) return
    const hit = map.cards.find((c) => c.label.toLowerCase().includes(q)) ?? map.cards.find((c) => c.sub.toLowerCase().includes(q))
    if (hit !== undefined) focus(hit.id)
  }, [find, map, focus])

  const card = map?.cards.find((c) => c.id === selected) ?? null
  const roles = view?.roles?.tables[0]?.roles ?? []
  const current = work.find((w) => w.id === viewing) ?? null

  const addNote = async (text: string): Promise<void> => {
    if (card === null) return
    const n = await api.addNote(projectId, JSON.stringify({ on: viewing, target: { kind: card.kind, key: card.key, label: card.label }, text }))
    setNotes((all) => [...all, n])
  }
  const removeNote = async (id: string): Promise<void> => { await api.removeNote(projectId, id); setNotes((all) => all.filter((n) => n.id !== id)) }
  const send = async (list: Note[]): Promise<string> => {
    if (view === null) return ''
    const d = new Date()
    const text = notesBrief(list, { product, base: view.base, view, check, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
    await api.copy(text)
    await api.markNotesSent(projectId, JSON.stringify(list.map((n) => n.id)))
    const at = new Date().toISOString()
    setNotes((all) => all.map((n) => (list.some((x) => x.id === n.id) ? { ...n, sentAt: at } : n)))
    return text
  }

  return (
    <div className="map">
      <div className="map-bar">
        <label className="map-field">Viewing
          <select className="select" value={viewing} onChange={(e) => onViewing(e.target.value)}>
            <option value="main">main — the product as it is</option>
            {work.map((w) => <option key={w.id} value={w.id}>{w.ready ? '● ' : ''}{w.label}{w.tasks[0] !== undefined ? ` (${w.tasks[0].id})` : ''}</option>)}
          </select>
        </label>
        {roles.length > 0 && (
          <label className="map-field">As
            <select className="select" value={as ?? ''} onChange={(e) => setAs(e.target.value === '' ? null : e.target.value)}>
              <option value="">everyone</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <input className="search map-find" placeholder="Find a screen or some data…" value={find} onChange={(e) => setFind(e.target.value)} />
        <span className="map-spacer" />
        <Legend work={check !== null} as={as} />
      </div>

      {current !== null && <Verdict work={current} check={check} projectId={projectId} notes={here.filter((n) => n.sentAt === null).length} onReport={() => onReport(current.id)} onNotes={() => setPanel('notes')} />}

      <div className="map-body">
        <div className="map-canvas">
          {error !== null ? <div className="page"><Problem title="Couldn’t draw the map." detail={error} onRetry={load} /></div>
            : map === null ? <div className="center"><Spinner label={viewing === 'main' ? 'Drawing the product on main…' : 'Drawing the product as this work leaves it…'} /></div>
            : (
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={nodeTypes}
                onNodeClick={(_, n) => { if (n.type === 'card') { setSelected(n.id); setPanel('details') } }}
                onPaneClick={() => setSelected(null)}
                fitView fitViewOptions={{ padding: 0.06, maxZoom: 1, nodes: startAt(map) }} minZoom={0.12} maxZoom={2}
                nodesConnectable={false} nodesDraggable={false} elementsSelectable
                proOptions={{ hideAttribution: true }} colorMode="system"
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap pannable zoomable position="bottom-right" nodeClassName={(n) => (n.type === 'frame' ? 'mm-frame' : (n.data as CardData).card.needs !== null ? 'mm-needs' : (n.data as CardData).card.change !== null ? 'mm-change' : 'mm-card')} />
              </ReactFlow>
            )}
        </div>

        <aside className="map-panel">
          <div className="seg map-tabs">
            <button type="button" className={panel === 'details' ? 'on' : ''} onClick={() => setPanel('details')}>Details</button>
            <button type="button" className={panel === 'notes' ? 'on' : ''} onClick={() => setPanel('notes')}>Notes{here.filter((n) => n.sentAt === null).length > 0 ? ` · ${here.filter((n) => n.sentAt === null).length}` : ''}</button>
          </div>
          {panel === 'details'
            ? (view === null || map === null ? null : card === null
              ? <Overview view={view} check={check} map={map} viewing={viewing} />
              : <Details key={card.id} card={card} view={view} check={check} map={map} as={as} projectId={projectId} viewing={viewing}
                  notes={here.filter((n) => n.target.kind === card.kind && n.target.key === card.key)}
                  onPin={addNote} onRemove={removeNote} onFocus={focus} onAsk={onAsk} />)
            : <NotesPanel notes={here} viewing={viewing} onFocus={(n) => { const id = map?.cards.find((c) => c.kind === n.target.kind && c.key === n.target.key)?.id; if (id !== undefined) focus(id) }} onRemove={removeNote} onSend={send} />}
        </aside>
      </div>
    </div>
  )
}

/** Where the map opens: the screens, big enough to read — not everything at once. */
function startAt(map: ProductMap): { id: string }[] {
  const screens = map.frames.filter((f) => f.id !== 'frame:data' && f.id !== 'frame:behind')
  const first = screens.filter((f) => f.y === 0)
  return (first.length > 0 ? first : screens).map((f) => ({ id: f.id }))
}

function edgeOf(l: Link): Edge {
  const style = l.kind === 'writes' ? { stroke: 'var(--ink)', strokeWidth: 1.5 }
    : l.kind === 'reads' ? { stroke: 'var(--ink-3)', strokeWidth: 1.2, strokeDasharray: '5 4' }
    : l.kind === 'goes' ? { stroke: 'var(--ink-2)', strokeWidth: 1.4 }
    : { stroke: 'var(--ink-3)', strokeWidth: 1.2, strokeDasharray: '2 3' }
  return {
    id: `${l.from}->${l.to}:${l.kind}`, source: l.from, target: l.to, style, zIndex: 2,
    ...(l.kind === 'goes' || l.kind === 'writes' ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: l.kind === 'writes' ? 'var(--ink)' : 'var(--ink-2)' } } : {}),
  }
}

function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  return (
    <div className="mframe">
      <div className="mframe-label">{data.frame.label}</div>
      {data.frame.note !== undefined && <div className="mframe-note">{data.frame.note}</div>}
    </div>
  )
}

function CardNode({ data }: NodeProps<Node<CardData>>) {
  const c = data.card
  const cls = ['mcard', `k-${c.kind}`, data.selected ? 'sel' : '', data.dim ? 'dim' : '', data.linked !== null ? 'linked' : '', c.change !== null ? `ch-${c.change}` : '', c.access !== null ? `ac-${c.access}` : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} title={[c.changeNote, c.needs, c.accessNote].filter(Boolean).join(' · ') || undefined}>
      <Handle type="target" position={Position.Left} className="mhandle" isConnectable={false} />
      <div className="mcard-top">
        <span className="mcard-label">{c.label}</span>
        {c.change !== null && <span className={`mchange mchange-${c.change}`}>{c.change === 'new' ? 'New' : c.change === 'gone' ? 'Gone' : c.change === 'touched' ? 'Touched' : 'Changed'}</span>}
        {c.notes > 0 && <span className="mnotes" title={`${c.notes} note${c.notes === 1 ? '' : 's'}`}>{c.notes}</span>}
      </div>
      <div className="mcard-sub">{c.sub}</div>
      {(c.kind === 'screen' || c.kind === 'part' || c.kind === 'group' || c.kind === 'job') && (
        <div className="mcard-facts">
          {c.needs !== null ? <span className="accent-text">● {c.needs}</span> : c.accessNote !== null ? <span>{c.accessNote}</span> : <span>{c.facts.join(' · ')}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="mhandle" isConnectable={false} />
    </div>
  )
}

function Legend({ work, as }: { work: boolean; as: string | null }) {
  return (
    <div className="legend">
      <span><i className="lg-line" /> changes</span>
      <span><i className="lg-line lg-dash" /> reads</span>
      <span><i className="lg-line lg-go" /> leads to</span>
      {work && <span><i className="lg-box lg-new" /> new or changed by this work</span>}
      {work && <span><i className="lg-box" /> runs changed code</span>}
      {as !== null && <span><i className="lg-box lg-none" /> {as} can’t use</span>}
      <span className="accent-text">● needs you</span>
    </div>
  )
}

/** In a Check: is it ready — in one line across the top of the map. */
function Verdict({ work, check, projectId, notes, onReport, onNotes }: { work: WorkView; check: CheckView | null; projectId: string; notes: number; onReport: () => void; onNotes: () => void }) {
  const [said, setSaid] = useState<string | null>(null)
  const [marked, setMarked] = useState(false)
  useEffect(() => { setMarked(false); setSaid(null) }, [work.id])
  if (check === null) return <div className="map-verdict"><Spinner label="Reading this work against main…" /></div>
  const v = check.verdict
  const merge = v.mergeMain.state === 'clean' ? 'merges cleanly' : v.mergeMain.state === 'conflicts' ? `conflicts with main in ${v.mergeMain.files.length} file${v.mergeMain.files.length === 1 ? '' : 's'}` : v.mergeMain.state === 'uncommitted' ? 'nothing committed yet' : 'merge unknown'
  const clash = v.mergeOthers.filter((o) => o.state.state === 'conflicts')
  return (
    <div className="map-verdict">
      <div className="mv-text">
        <strong>{work.label}</strong>
        <span className="mv-sentence">{check.sentence}</span>
        <span className="mv-facts">
          <span className={v.mergeMain.state === 'conflicts' ? 'accent-text' : ''}>{merge}</span>
          {clash.map((o) => <span key={o.label} className="accent-text">would conflict with {o.label}</span>)}
          <span className={v.pushed.state === 'local' || v.pushed.state === 'ahead' ? 'accent-text' : ''}>{v.pushed.state === 'local' ? 'not pushed' : v.pushed.state === 'ahead' ? `${v.pushed.unpushed} not pushed` : 'on GitHub'}</span>
          <span className={v.criteria === 0 && check.plan === null ? 'accent-text' : ''}>{check.plan !== null && check.plan.total > 0 ? `plan ${check.plan.done} of ${check.plan.total} done` : v.criteria === 0 ? 'no “done when” written' : `${plural(v.criteria, 'criterion', 'criteria')}`}</span>
          {said !== null && <span>{said}</span>}
        </span>
      </div>
      <div className="mv-actions">
        <Button small onClick={onReport}>Full report</Button>
        <Button small onClick={onNotes}>Send back{notes > 0 ? ` (${notes} notes)` : '…'}</Button>
        <Button small onClick={() => { void api.copy(check.ship).then(() => setSaid('copied — paste it into its Claude session')) }}>Ready — copy next step</Button>
        <Button small primary disabled={marked} onClick={() => { void api.markChecked(projectId, work.id).then(() => setMarked(true)) }}>{marked ? 'Looked at' : 'I’ve looked at it'}</Button>
      </div>
    </div>
  )
}

/** Nothing picked: what's on the map, in a few words. */
function Overview({ view, check, map, viewing }: { view: ProductView; check: CheckView | null; map: ProductMap; viewing: string }) {
  const screens = map.cards.filter((c) => c.kind === 'screen').length
  const tables = map.cards.filter((c) => c.kind === 'table').length
  const needs = map.cards.filter((c) => c.needs !== null)
  return (
    <div className="panel-body">
      <h3 className="panel-title">{viewing === 'main' ? 'The product on main' : 'This work, on the map'}</h3>
      <p className="note">{plural(screens, 'screen')} · {plural(tables, 'kind')} of data · {plural(view.behind.length, 'route')} no screen calls</p>
      {check !== null && <p className="sentence">{check.sentence}</p>}
      <p className="panel-hint">Pick any card to see what it does and who can use it. Pin a note to it — they collect under Notes, and go to Claude together.</p>
      {needs.length > 0 && (
        <>
          <h4 className="panel-h">Needs you</h4>
          {needs.map((c) => <p key={c.id} className="panel-line"><span className="accent-text">●</span> {c.label} — {c.needs}</p>)}
        </>
      )}
    </div>
  )
}

function Details({ card, view, check, map, as, projectId, viewing, notes, onPin, onRemove, onFocus, onAsk }: {
  card: Card; view: ProductView; check: CheckView | null; map: ProductMap; as: string | null; projectId: string; viewing: string
  notes: Note[]; onPin: (text: string) => Promise<void>; onRemove: (id: string) => Promise<void>; onFocus: (id: string) => void; onAsk: (p: AskPrefill) => void
}) {
  const roles = view.roles?.tables[0]?.roles ?? []
  const routes = routesOf(card, view)
  const changed = new Map([...(check?.changes.route ?? []), ...(check?.touched ?? [])].map((r) => [r.title, r]))
  const out = map.links.filter((l) => l.from === card.id)
  const into = map.links.filter((l) => l.to === card.id)
  const name = (id: string): string => map.cards.find((c) => c.id === id)?.label ?? id
  const screen = card.kind === 'screen' ? view.groups.flatMap((g) => g.screens).find((s) => s.path === card.key) : undefined
  return (
    <div className="panel-body">
      <h3 className="panel-title">{card.label}</h3>
      <p className="note">{card.kind === 'screen' ? <span className="code">{card.key}</span> : card.sub}{screen?.file != null ? <> · <span className="code">{screen.file.slice(screen.file.lastIndexOf('/') + 1)}</span></> : null}</p>
      {card.changeNote !== null && <p className="panel-line"><strong>{card.change === 'new' ? 'New' : card.change === 'gone' ? 'Gone' : card.change === 'touched' ? 'Touched' : 'Changed'}</strong> — {card.changeNote}</p>}
      {card.needs !== null && <p className="panel-line accent-text">● {card.needs}</p>}
      {as !== null && card.accessNote !== null && <p className="panel-line">{card.accessNote}</p>}

      {card.kind === 'screen' && viewing !== 'main' && check?.running != null && inApp() && (
        <p className="panel-line"><button type="button" className="link" onClick={() => { void api.openScreen(projectId, viewing, card.key) }}>Open it in this work’s running copy (localhost:{check.running})</button></p>
      )}

      {out.some((l) => l.kind === 'goes') && <Chips title="Leads to" ids={out.filter((l) => l.kind === 'goes').map((l) => l.to)} name={name} onFocus={onFocus} />}
      {into.some((l) => l.kind === 'goes') && <Chips title="Reached from" ids={into.filter((l) => l.kind === 'goes').map((l) => l.from)} name={name} onFocus={onFocus} />}
      {out.some((l) => l.kind === 'writes') && <Chips title="Changes" ids={out.filter((l) => l.kind === 'writes').map((l) => l.to)} name={name} onFocus={onFocus} />}
      {out.some((l) => l.kind === 'reads') && <Chips title="Reads" ids={out.filter((l) => l.kind === 'reads').map((l) => l.to)} name={name} onFocus={onFocus} />}
      {into.some((l) => l.kind === 'writes') && <Chips title="Changed from" ids={into.filter((l) => l.kind === 'writes').map((l) => l.from)} name={name} onFocus={onFocus} />}
      {into.some((l) => l.kind === 'reads') && <Chips title="Read from" ids={into.filter((l) => l.kind === 'reads').map((l) => l.from)} name={name} onFocus={onFocus} />}
      {out.some((l) => l.kind === 'uses') && <Chips title="Uses" ids={out.filter((l) => l.kind === 'uses').map((l) => l.to)} name={name} onFocus={onFocus} />}
      {into.some((l) => l.kind === 'uses') && <Chips title="Used on" ids={into.filter((l) => l.kind === 'uses').map((l) => l.from)} name={name} onFocus={onFocus} />}

      {card.kind === 'role' && check !== null && (
        <div className="panel-sec">
          <h4 className="panel-h">What changes</h4>
          {check.roleChanges.filter((c) => c.role === card.key).map((c, i) => <p key={i} className="panel-line">{c.resource}: <span className="dim">{c.before}</span> → {c.after}</p>)}
        </div>
      )}

      {routes.length > 0 && (
        <div className="panel-sec">
          <h4 className="panel-h">{card.kind === 'table' ? 'Routes that change or read it' : card.kind === 'group' && card.key.startsWith('behind:') ? 'Its routes' : 'What it can do'} <span className="count">{routes.length}</span></h4>
          <div className="changes">
            {[...routes].sort((a, b) => Number(changed.has(`${b.method} ${b.path}`)) - Number(changed.has(`${a.method} ${a.path}`))).slice(0, 40).map((r) => {
              const c = changed.get(`${r.method} ${r.path}`)
              return <RouteLine key={`${r.method} ${r.path}`} method={r.method} path={r.path} checks={r.checks} who={r.who} roles={roles} data={r.data} where={r.where} as={as}
                publicOk={view.publicOk?.includes(`${r.method} ${r.path}`)} type={c?.type} detail={c?.detail} showDetail={c !== undefined} />
            })}
          </div>
          {routes.length > 40 && <p className="note">and {routes.length - 40} more</p>}
        </div>
      )}

      {card.kind === 'job' && card.key !== 'always' && (
        <div className="panel-sec">
          <h4 className="panel-h">Its jobs</h4>
          {view.background.queues.find((q) => q.name === card.key)?.jobs.map((j) => <p key={j.name} className="panel-line"><span className="code">{j.name}</span> <span className="dim">added in {j.addedAt.map((w) => w.slice(w.lastIndexOf('/') + 1)).join(', ')}</span></p>)}
        </div>
      )}

      <NoteBox label={card.label} notes={notes} onPin={onPin} onRemove={onRemove} />
      {viewing === 'main' && card.kind === 'screen' && <p className="panel-line"><button type="button" className="link" onClick={() => onAsk({ picks: [{ kind: 'screen', key: card.key }] })}>Or write a full task for it…</button></p>}
    </div>
  )
}

function Chips({ title, ids, name, onFocus }: { title: string; ids: string[]; name: (id: string) => string; onFocus: (id: string) => void }) {
  return (
    <div className="panel-sec">
      <h4 className="panel-h">{title} <span className="count">{ids.length}</span></h4>
      <div className="chips">{[...new Set(ids)].map((id) => <button key={id} type="button" className="chip chip-btn" onClick={() => onFocus(id)}>{name(id)}</button>)}</div>
    </div>
  )
}

/** Pin a note to what's picked; the notes already on it, with a way to take one back. */
function NoteBox({ label, notes, onPin, onRemove }: { label: string; notes: Note[]; onPin: (text: string) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [text, setText] = useState('')
  return (
    <div className="panel-sec notebox">
      <h4 className="panel-h">Your notes on it</h4>
      {notes.map((n) => (
        <div key={n.id} className={`pinned ${n.sentAt !== null ? 'sent' : ''}`}>
          <Md text={n.text} />
          <span className="pinned-meta">{n.sentAt !== null ? `sent ${ago(n.sentAt)}` : ago(n.at)} · <button type="button" className="link" onClick={() => void onRemove(n.id)}>remove</button></span>
        </div>
      ))}
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`A note on ${label} — e.g. “Reject should ask for a reason.”`} rows={3}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() !== '') { void onPin(text.trim()).then(() => setText('')) } }} />
      <div className="notebox-actions"><Button small primary disabled={text.trim() === ''} onClick={() => { void onPin(text.trim()).then(() => setText('')) }}>Pin note</Button><span className="kbd">⌘↩</span></div>
    </div>
  )
}

/** Every note on this map, and the one step that sends them to Claude. */
function NotesPanel({ notes, viewing, onFocus, onRemove, onSend }: { notes: Note[]; viewing: string; onFocus: (n: Note) => void; onRemove: (id: string) => Promise<void>; onSend: (list: Note[]) => Promise<string> }) {
  const [done, setDone] = useState<string | null>(null)
  const open = notes.filter((n) => n.sentAt === null)
  const sent = notes.filter((n) => n.sentAt !== null)
  return (
    <div className="panel-body">
      <h3 className="panel-title">{viewing === 'main' ? 'Your notes on the product' : 'Your notes on this work'}</h3>
      {open.length === 0 && <p className="panel-hint">No notes yet. Pick a card on the map and pin one — a question, something to change, something that looks wrong.</p>}
      {open.map((n) => (
        <div key={n.id} className="pinned">
          <button type="button" className="link pinned-target" onClick={() => onFocus(n)}>{n.target.label}</button>
          <Md text={n.text} />
          <span className="pinned-meta">{ago(n.at)} · <button type="button" className="link" onClick={() => void onRemove(n.id)}>remove</button></span>
        </div>
      ))}
      {open.length > 0 && (
        <div className="panel-send">
          <Button primary onClick={() => { void onSend(open).then(() => setDone(viewing === 'main' ? 'Copied. Paste it into a new Claude session — it adds each note as a task first.' : 'Copied. Paste it into the Claude session doing this work.')) }}>
            Send {plural(open.length, 'note')} to Claude
          </Button>
          {inApp() && <Button onClick={() => { void api.openClaude() }}>Open Claude</Button>}
        </div>
      )}
      {done !== null && <p className="note">{done}</p>}
      {sent.length > 0 && (
        <details className="claude">
          <summary>Sent — {sent.length}</summary>
          {sent.map((n) => <div key={n.id} className="pinned sent"><span className="pinned-target">{n.target.label}</span><Md text={n.text} /><span className="pinned-meta">sent {ago(n.sentAt!)}</span></div>)}
        </details>
      )}
    </div>
  )
}

/** The routes behind a card: a screen's own, a part's, a group's. */
function routesOf(card: Card, view: ProductView): RouteRow[] {
  if (card.kind === 'screen') return view.groups.flatMap((g) => g.screens).find((s) => s.path === card.key)?.routes ?? []
  if (card.kind === 'part') return view.shared.find((p) => p.file === card.key)?.routes ?? []
  if (card.kind === 'group' && card.key === 'layout') return view.layout
  if (card.kind === 'group' && card.key.startsWith('behind:')) return groupBehind(view.behind).get(card.key.slice('behind:'.length)) ?? []
  if (card.kind === 'table') {
    const all = [...view.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...view.shared.flatMap((p) => p.routes), ...view.layout, ...view.behind]
    const seen = new Set<string>()
    return all.filter((r) => r.data.some((d) => d.table === card.key) && !seen.has(`${r.method} ${r.path}`) && seen.add(`${r.method} ${r.path}`) !== undefined)
  }
  return []
}
