import { useEffect, useMemo, useRef, useState } from 'react'
import type { AskInput, DraftView, ProductView } from '../shared/api.js'
import { api, inApp } from './bridge.js'

export type Pick = AskInput['picks'][number]
/** What a finding hands to "Ask for a change": the screens or routes it's
 *  about, and a first draft of what and why. */
export interface AskPrefill { picks: Pick[]; what?: string; why?: string }

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']

/** "Ask for a change": what should happen, where, and when it's done —
 *  drafted as a task in the tracker's own shape, shown exactly as it would be
 *  added, and handed to Claude as a brief that adds it first. */
export function AskSheet({ projectId, initial, onClose }: { projectId: string; initial: AskPrefill; onClose: () => void }) {
  const [what, setWhat] = useState(initial.what ?? '')
  const [why, setWhy] = useState(initial.why ?? '')
  const [criteria, setCriteria] = useState<string[]>(['', ''])
  const [severity, setSeverity] = useState('')
  const [picks, setPicks] = useState<Pick[]>(initial.picks)
  const [id, setId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<DraftView | null>(null)
  const [product, setProduct] = useState<ProductView | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<{ kind: 'added' | 'copied' | 'error' | 'claude'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => { void api.product(projectId).then(setProduct).catch(() => undefined) }, [projectId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const input = useMemo((): AskInput => ({ what, why, criteria, picks, ...(id === undefined ? {} : { id }), ...(severity === '' ? {} : { severity }) }), [what, why, criteria, picks, id, severity])
  // The preview shown is the one approved: a click never adds text that
  // wasn't on screen, even mid-typing.
  const [shown, setShown] = useState<string>('')
  useEffect(() => {
    const key = JSON.stringify(input)
    const t = setTimeout(() => { void api.draftTask(projectId, key).then((d) => { setDraft(d); setShown(key) }).catch(() => undefined) }, 250)
    return () => clearTimeout(t)
  }, [projectId, input])
  const current = draft !== null && shown === JSON.stringify(input)

  const options = useMemo(() => {
    if (product === null || query.trim() === '') return []
    const q = query.trim().toLowerCase()
    const screens = product.groups.flatMap((g) => g.screens).filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
      .map((s) => ({ kind: 'screen' as const, key: s.path, label: s.name, sub: s.path }))
    const seen = new Set<string>()
    const routes = [...product.groups.flatMap((g) => g.screens.flatMap((s) => s.routes)), ...product.behind, ...product.layout, ...product.shared.flatMap((s) => s.routes)]
      .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k) || !k.toLowerCase().includes(q)) return false; seen.add(k); return true })
      .map((r) => ({ kind: 'route' as const, key: `${r.method} ${r.path}`, label: `${r.method} ${r.path}`, sub: r.where.slice(r.where.lastIndexOf('/') + 1) }))
    return [...screens.slice(0, 6), ...routes.slice(0, 8)].filter((o) => !picks.some((p) => p.kind === o.kind && p.key === o.key))
  }, [product, query, picks])

  const labelOf = (p: Pick): string => p.kind === 'route' ? p.key : product?.groups.flatMap((g) => g.screens).find((s) => s.path === p.key)?.name ?? p.key
  const empty = what.trim() === ''

  const add = async (): Promise<void> => {
    if (draft === null) return
    setBusy(true)
    try {
      const r = await api.addTask(projectId, JSON.stringify({ ...input, hash: draft.hash }))
      setStatus({ kind: 'added', text: `Added ${r.id} to ${r.file} — not committed yet. Copy the brief for Claude: it commits the task first, then works it.` })
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    } finally { setBusy(false) }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet" role="dialog" aria-label="Ask for a change">
        <header className="sheet-head">
          <h2>Ask for a change</h2>
          <button type="button" className="close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="sheet-body">
          <div className="sheet-form">
            <label className="field">
              <span>What should change?</span>
              <textarea ref={first} rows={3} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="e.g. Let people in Finance approve renewals" />
              <small>The first line becomes the task’s title.</small>
            </label>
            <label className="field">
              <span>Why it matters <em>optional</em></span>
              <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Renewals wait on legal today" />
            </label>
            <label className="field">
              <span>How much does it matter? <em>optional</em></span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="">Not said</option>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div className="field">
              <span>Done when…</span>
              {criteria.map((c, i) => (
                <input key={i} value={c} placeholder={i === 0 ? 'e.g. Someone with the Finance role can approve a renewal' : 'e.g. Legal is told when Finance approves'}
                  onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? e.target.value : x)))} />
              ))}
              <button type="button" className="more" onClick={() => setCriteria([...criteria, ''])}>+ Another</button>
              <small>Claude checks its work against these, and they show up when you Check the result.</small>
            </div>
            <div className="field">
              <span>Where <em>from your product</em></span>
              <div className="picks">
                {picks.map((p) => (
                  <span key={`${p.kind}:${p.key}`} className="pick">
                    <span className={p.kind === 'route' ? 'code' : ''}>{labelOf(p)}</span>
                    <button type="button" onClick={() => setPicks(picks.filter((x) => x !== p))} aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={product === null ? 'Reading the product…' : 'Find a screen or a route…'} disabled={product === null} />
              {options.length > 0 && (
                <div className="options">
                  {options.map((o) => (
                    <button key={`${o.kind}:${o.key}`} type="button" className="option" onClick={() => { setPicks([...picks, { kind: o.kind, key: o.key }]); setQuery('') }}>
                      <span className={o.kind === 'route' ? 'code' : ''}>{o.label}</span><span className="dim">{o.sub}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="sheet-preview">
            <div className="preview-head">
              {draft?.file != null
                ? <p>What goes into <span className="code">{draft.file}</span>:</p>
                : <p className="dim">{draft === null ? 'Drafting…' : 'No tracker found in this product.'}</p>}
              <label className="id-field">ID <input value={id ?? draft?.suggestedId ?? ''} onChange={(e) => setId(e.target.value.toUpperCase())} /></label>
            </div>
            <pre className="preview">{empty ? <span className="dim">The task appears here, exactly as it would be added, as you write it.</span> : draft?.text ?? ''}</pre>
            {draft?.cantAdd != null && draft.file !== null && <p className="note">{draft.cantAdd}</p>}
          </div>
        </div>
        <footer className="sheet-foot">
          <p className={`sheet-status ${status?.kind === 'error' ? 'accent-text' : ''}`}>{status?.text ?? (empty ? 'Say what should change to begin.' : draft?.problem ?? 'Nothing is written anywhere until you choose to.')}</p>
          <button type="button" className="btn btn-primary" disabled={!current || empty} onClick={() => { void api.copy(draft!.brief).then(() => setStatus({ kind: 'copied', text: 'Copied. Paste it into a new Claude session — Claude adds the task to the tracker first, then works it.' })) }}>1 · Copy for Claude</button>
          {inApp() && <button type="button" className="btn" onClick={() => { void api.openClaude().then((ok) => setStatus(ok ? { kind: 'claude', text: 'Opened Claude. Paste the brief into a new session.' } : { kind: 'error', text: 'I couldn’t find the Claude app.' })) }}>2 · Open Claude</button>}
          <button type="button" className="btn" disabled={busy || !current || draft!.problem !== null || draft!.cantAdd !== null || status?.kind === 'added'} title={draft?.cantAdd ?? undefined} onClick={() => void add()}>
            {status?.kind === 'added' ? 'Added' : `Or add it to ${draft?.file ?? 'the tracker'} now`}
          </button>
        </footer>
      </div>
    </div>
  )
}
