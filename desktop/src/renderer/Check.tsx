import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ChangeKind, CheckView, MergeView } from '../shared/api.js'
import { api, inApp, onChanged } from './bridge.js'
import { ago, clock, plural } from './format.js'
import { Button, Empty, FileList, Problem, Section, Severity, Some, Spinner, Status } from './ui.js'
import { ChangeList } from './Changes.js'
import { TaskBody } from './Home.js'
import { Md, MdBlock } from './Md.js'

const KINDS: { kind: Exclude<ChangeKind, 'route'>; title: string }[] = [
  { kind: 'data', title: 'Data it reads and changes' },
  { kind: 'service', title: 'Outside services' },
  { kind: 'package', title: 'Packages' },
]

export function CheckScreen({ projectId, workId, onBack, onAsk }: {
  projectId: string; workId: string; onBack: () => void; onAsk: (what: string, why: string) => void
}) {
  const [view, setView] = useState<CheckView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [marked, setMarked] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)

  const load = useCallback(() => {
    setView(null)
    setError(null)
    setMoved(false)
    setMarked(false)
    void api.check(projectId, workId).then(setView).catch((e: Error) => setError(e.message))
  }, [projectId, workId])
  useEffect(load, [load])
  // Claude may still be working on it: say so when what's there now isn't
  // what this page read, rather than let it go stale.
  const shown = view?.fingerprint
  useEffect(() => onChanged((id, moved) => {
    const now = moved.find(([w]) => w === workId)?.[1]
    if (id === projectId && now !== undefined && shown !== undefined && now !== shown) setMoved(true)
  }), [projectId, workId, shown])

  const copy = (text: string, said: string): void => { void api.copy(text).then(() => { setDone(said); setTimeout(() => setDone(null), 4000) }) }

  if (error !== null) return <div className="page"><button type="button" className="back" onClick={onBack}>← Home</button><Problem title="Couldn’t read this work." detail={error} onRetry={load} /></div>
  if (view === null) return <div className="page"><button type="button" className="back" onClick={onBack}>← Home</button><div className="center"><Spinner label="Reading this work, and the product before and after it…" /></div></div>

  const w = view.work
  const product = view.changes.route.length + view.touched.length + view.changes.data.length + view.changes.service.length + view.changes.package.length
  const db = view.schema.tables.added.length + view.schema.tables.changed.length + view.schema.tables.removed.length + view.schema.lists.added.length + view.schema.lists.changed.length + view.schema.lists.removed.length + view.schema.migrations.length + (view.schema.settings ? 1 : 0)
  const noticed = view.screens.changed.length + view.screens.added.length + view.screens.removed.length + view.roleChanges.length + view.unmatched.added.length + view.unmatched.fixed.length
  return (
    <div className="page">
      <button type="button" className="back" onClick={onBack}>← Home</button>
      {moved && <div className="banner"><p>This work has changed since you opened it — Claude may still be on it.</p><Button small onClick={load}>Read again</Button></div>}
      <div className="page-head">
        <div>
          <h1>{w.label}</h1>
          <p className="meta">
            <span>{w.where === 'checkout' ? 'your checkout' : w.where === 'worktree' ? `Claude worktree ${w.name}` : `branch ${w.name}`}{w.branch !== null && w.where !== 'branch' ? ` · ${w.branch}` : ''}</span>
            <span>{w.ahead > 0 ? plural(w.ahead, 'commit') : 'nothing committed yet'}{w.uncommitted > 0 ? ` · ${plural(w.uncommitted, 'file')} not committed` : ''}</span>
            {w.lastCommit !== null && <span>last commit {ago(w.lastCommit)}</span>}
            <span>read {clock(view.readAt)} · <button type="button" className="link" onClick={load}>read again</button></span>
          </p>
        </div>
      </div>

      <p className="sentence">{view.sentence}</p>

      <div className="verdict">
        <Verdict label="Done when">
          {view.plan != null && view.plan.releases.length > 0 ? (
            <span>Its plan says what “done” means for each release. {view.plan.releases.map((r) => `${r.short} ${r.done} of ${r.total}`).join(' · ')} — below.</span>
          ) : view.tasks.length === 0 ? (w.plan !== null
              ? <span className="needs">No tracker task yet — it’s working from its plan, <span className="code">{w.plan.file}</span>, which doesn’t say when it’s done. Ask Claude to.</span>
              : <span className="needs">It doesn’t name a task, so there’s nothing to check it against.</span>)
            : view.verdict.criteria === 0 ? <span className="needs">{view.tasks.map((t) => t.id).join(', ')} {view.tasks.length === 1 ? 'has' : 'have'} no acceptance criteria written — ask Claude what “done” means here before you merge.</span>
            : <span>{plural(view.verdict.criteria, 'criterion', 'criteria')} written, under its tasks below. This screen can’t tell you whether they’re met — only what changed.</span>}
        </Verdict>
        <Verdict label="Merges into main"><Merge m={view.verdict.mergeMain} into={view.base.replace(/^origin\//, '')} /></Verdict>
        {view.verdict.mergeOthers.length > 0 && (
          <Verdict label="Other work">
            {view.verdict.mergeOthers.map((o) => <div key={o.label}>{o.label} ({plural(o.files, 'shared file')}): <Merge m={o.state} into={o.label} short /></div>)}
          </Verdict>
        )}
        <Verdict label="Pushed">
          {view.verdict.pushed.state === 'local' ? <span className="needs">Only on this Mac — not pushed yet.</span>
            : view.verdict.pushed.state === 'ahead' ? <span className="needs">{plural(view.verdict.pushed.unpushed, 'commit')} not pushed to {view.verdict.pushed.upstream}.</span>
            : view.verdict.pushed.state === 'detached' ? <span className="needs">Not on a branch — it can’t be pushed as it is.</span>
            : <span>On GitHub{view.verdict.pushed.upstream !== null ? ` as ${view.verdict.pushed.upstream}` : ''}.</span>}
        </Verdict>
        <Verdict label="Tests">{view.tests.length === 0 ? <span className="dim">It changes no test files.</span> : <span>It changes {plural(view.tests.length, 'test file')}.</span>}</Verdict>
        {(view.plan?.golive != null || view.schema.migrations.length > 0) && (
          <Verdict label="Before it goes live">
            {view.schema.migrations.length > 0 && <div>{view.schema.migrations.length === 1 ? 'A database migration' : `${view.schema.migrations.length} database migrations`} to run.</div>}
            {view.plan?.golive != null && (
              <details className="claude"><summary>What its plan says about going live</summary><MdBlock text={view.plan.golive} /></details>
            )}
          </Verdict>
        )}
      </div>

      <Section title="What people will notice" count={noticed || undefined}>
        {noticed === 0 ? <Empty>No screen, role or call between them changes.</Empty> : (
          <>
            {view.screens.added.length > 0 && <Group title="New screens">{view.screens.added.map((s) => <div key={s.path} className="file"><span>{s.name}</span><span className="code dim">{s.path}</span></div>)}</Group>}
            {view.screens.removed.length > 0 && <Group title="Screens it removes">{view.screens.removed.map((s) => <div key={s.path} className="file"><span>{s.name}</span><span className="code dim">{s.path}</span></div>)}</Group>}
            {view.screens.changed.length > 0 && (
              <Group title="Screens to try" note={view.running !== null ? `Their own page changed, or code they run did. This work’s copy of the app is running on localhost:${view.running} — open them there.` : 'Their own page changed, or code they run did. Start this work’s copy of the app to open them from here.'}>
                {view.tasks.filter((t) => t.tryIt != null).map((t) => <p key={t.id} className="note"><span className="label">What to try, from {t.id}:</span> <Md text={t.tryIt!} /></p>)}
                <div className="files">
                  <Some items={view.screens.changed} limit={8} render={(s) => (
                    <div key={s.path} className="file">
                      <span>{s.name} <span className="dim">{s.how === 'page' ? '— its page' : '— code it runs'}</span></span>
                      <span>
                        {view.running !== null && inApp() && <button type="button" className="link" onClick={() => { void api.openScreen(projectId, workId, s.path) }} title={`Opens localhost:${view.running} in your browser — this work’s own copy of the app`}>Open{s.path.includes('/:') ? ' its list' : ''}</button>}
                        {' '}<span className="code dim">{s.path}</span>
                      </span>
                    </div>
                  )} />
                </div>
              </Group>
            )}
            {view.roleChanges.length > 0 && (
              <Group title="Who can do what">
                <table className="table">
                  <thead><tr><th>Role</th><th>On</th><th>Before</th><th>After</th></tr></thead>
                  <tbody>{view.roleChanges.map((c, i) => <tr key={i}><td className="code">{c.role}</td><td>{c.resource}</td><td className="from">{c.before}</td><td>{c.after}</td></tr>)}</tbody>
                </table>
              </Group>
            )}
            {view.unmatched.added.length > 0 && (
              <Group title="Calls to routes that don’t exist">
                {view.unmatched.added.map((u, i) => (
                  <div key={i} className="file"><span className="accent-text code">{u.method} {u.path}</span><span className="dim">{u.via ?? u.screen ?? ''} · {u.where.slice(u.where.lastIndexOf('/') + 1)}</span></div>
                ))}
              </Group>
            )}
            {view.unmatched.fixed.length > 0 && <Group title="Broken calls it fixes">{view.unmatched.fixed.map((u, i) => <div key={i} className="file"><span className="code">{u.method} {u.path}</span><span className="dim">{u.where.slice(u.where.lastIndexOf('/') + 1)}</span></div>)}</Group>}
          </>
        )}
      </Section>

      <Section title="What it changes in the product" count={product + db || undefined} note="Read from the code, before and after. None of this comes from Claude’s description.">
        {product + db === 0 ? <Empty>No routes, checks, data, services or packages changed.</Empty> : (
          <>
            {view.changes.route.length > 0 && <Group title="Routes"><ChangeList changes={view.changes.route} roles={view.roles} limit={25} /></Group>}
            {view.touched.length > 0 && <Group title="Routes whose own code changed" note="They were there before; what they do inside may be different now. Values new in their code are shown under each."><ChangeList changes={view.touched} roles={view.roles} limit={12} showDetail /></Group>}
            {db > 0 && <Database schema={view.schema} />}
            {KINDS.filter((k) => view.changes[k.kind].length > 0).map((k) => <Group key={k.kind} title={k.title}><ChangeList changes={view.changes[k.kind]} limit={12} /></Group>)}
          </>
        )}
      </Section>

      {view.unseen.length > 0 && (
        <Section title="What I can’t read in it" count={view.unseen.reduce((n, u) => n + u.files.length, 0)} note="Changed, but in a part of the product I don’t read — so none of it is described above.">
          {view.unseen.map((u) => <Group key={u.label} title={<><span className="hatch" /> {u.label}</>}><FileList files={u.files} limit={6} /></Group>)}
        </Section>
      )}

      {view.plan != null && (
        <Section title="Its plan" count={view.plan.total || undefined} note={<><span className="code">{view.plan.file}</span> — “{view.plan.title}”. {view.plan.total > 0 ? `${view.plan.done} of ${view.plan.total} done${view.plan.partly > 0 ? `, ${view.plan.partly} partly` : ''}.` : ''}</>}>
          {view.plan.releases.length > 0 && (
            <table className="table">
              <thead><tr><th>Release</th><th>Done</th><th>Done when</th></tr></thead>
              <tbody>{view.plan.releases.map((r) => <tr key={r.name}><td>{r.name}</td><td className={r.done === r.total ? '' : 'from'}>{r.done} of {r.total}</td><td>{r.doneWhen}</td></tr>)}</tbody>
            </table>
          )}
          {view.plan.open.length > 0 && (
            <details className="claude"><summary>Not done yet — {view.plan.open.length}</summary>
              <div className="files">{view.plan.open.map((i) => <div key={i.id} className="file"><span><span className="code dim">{i.id}</span> {i.title}</span><span className="dim">{i.status ?? ''}</span></div>)}</div>
            </details>
          )}
        </Section>
      )}

      <Section title="Its tasks" count={view.tasks.length} note={view.tasks.length > 0 ? 'As its own copy of the tracker has them.' : undefined}>
        {view.tasks.length === 0
          ? <Empty>{w.plan !== null ? 'No tracker task yet — it works from its plan, above.' : w.ahead === 0 ? 'Nothing is committed yet and it hasn’t edited a tracker entry, so no task is named.' : 'Its commits don’t name a task.'}</Empty>
          : view.tasks.map((t) => (
            <div key={t.id} className="row row-task">
              <div className="row-main"><span className="task-id">{t.id}</span><span className="row-title"><Md text={t.title} /></span><Severity value={t.severity} /><Status status={t.status} note={t.statusNote} /></div>
              <TaskBody task={t} />
            </div>
          ))}
        {view.unknownTasks.length > 0 && <p className="note">Its commits also name {view.unknownTasks.join(', ')}, which no tracker defines.</p>}
      </Section>

      {view.outside.length > 0 && (
        <Section title="Outside what its tasks name" count={view.outside.length} note="Files it changed that none of its tasks mention. Often fine — worth a question.">
          <FileList files={view.outside} />
        </Section>
      )}
      {view.shared.length > 0 && (
        <Section title="Also changed by other work" count={view.shared.length}>
          <div className="files"><Some items={view.shared} limit={10} render={(s) => <div key={s.file} className="file"><span className="code">{s.file}</span><span className="dim">{s.with.join(', ')}</span></div>} /></div>
        </Section>
      )}
      {view.commits.length > 0 && (
        <Section title="Commits" count={view.commits.length}>
          <div className="files"><Some items={view.commits} limit={6} render={(c) => <div key={c.sha} className="file"><span><span className="code dim">{c.sha}</span> {c.subject}</span><span className="dim">{ago(c.date)}</span></div>} /></div>
        </Section>
      )}

      <div className="footer-bar">
        <p className="footer-note">{done ?? (marked ? 'Noted. Home shows it as looked at until it changes. When you’re happy, copy the next step for Claude.' : 'Only what changed is shown here — not whether it works.')}</p>
        <Button onClick={() => setNotes(notes === null ? '' : null)}>Send back…</Button>
        <Button onClick={() => copy(view.followUp, `Copied the questions. Paste them into ${session(w)}.`)}>Copy questions</Button>
        <Button onClick={() => copy(view.ship, `Copied. Paste it into ${session(w)} — it pushes the work and opens a pull request.`)}>Ready — copy next step</Button>
        <Button primary disabled={marked} onClick={() => { void api.markChecked(projectId, workId).then(() => setMarked(true)) }} title="Records that you've looked at it as it is now. If it changes, Home says so.">{marked ? 'Marked as looked at' : 'I’ve looked at it'}</Button>
        {notes !== null && (
          <div className="notes">
            <textarea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Reject should ask for a reason. Don’t change the export format." />
            <Button disabled={notes.trim() === ''} onClick={() => { copy(sendBack(view, notes), `Copied your notes. Paste them into ${session(w)}.`); setNotes(null) }}>Copy for Claude</Button>
            <Button onClick={() => { onAsk(`Follow-up to ${w.label}`, notes); setNotes(null) }}>Make it a task…</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Which Claude session a brief belongs in, in words the PM can find it by. */
function session(w: CheckView['work']): string {
  if (w.where === 'worktree') return `the Claude session working in ${w.name}`
  if (w.where === 'checkout') return `the Claude session working in your checkout${w.branch !== null ? ` (on ${w.branch})` : ''}`
  return `a new Claude session, on ${w.name}`
}

function sendBack(v: CheckView, notes: string): string {
  return [
    `I checked the work on ${v.work.branch ?? v.work.name} in App Guide and it isn't ready yet:`,
    '',
    notes.trim(),
    '',
    `For context, App Guide read it as: ${v.sentence}`,
    'Make these changes, then tell me what you changed and how you checked it.',
  ].join('\n')
}

function Verdict({ label, children }: { label: string; children: ReactNode }) {
  return <div className="verdict-row"><span className="label">{label}</span><div>{children}</div></div>
}

function Merge({ m, into, short }: { m: MergeView; into: string; short?: boolean }) {
  const now = m.state !== 'uncommitted' && m.state !== 'unknown' && m.asOfNow === true ? ' — as the files are now, not all committed' : ''
  if (m.state === 'clean') return <span>{short ? `merges cleanly${now}` : `Merges cleanly into ${into}${now === '' ? ' as it is now' : now}.`}</span>
  if (m.state === 'conflicts') return <span className="needs">{short ? 'would conflict' : `Would conflict with ${into}`} in {m.files.slice(0, 4).map((f) => f.slice(f.lastIndexOf('/') + 1)).join(', ')}{m.files.length > 4 ? ` and ${m.files.length - 4} more` : ''}{now}.</span>
  if (m.state === 'uncommitted') return <span className="dim">{short ? 'can’t tell until both are committed' : 'Nothing is committed yet, so I can’t tell.'}</span>
  return <span className="dim">This version of git can’t tell.</span>
}

function Group({ title, note, children }: { title: ReactNode; note?: string; children: ReactNode }) {
  return <div className="group"><h3>{title}</h3>{note !== undefined && <p className="section-note">{note}</p>}{children}</div>
}

function Database({ schema: s }: { schema: CheckView['schema'] }) {
  const line = (label: string, names: string[]) => names.length === 0 ? null : <div className="file"><span>{label}</span><span className="code">{names.join(', ')}</span></div>
  return (
    <Group title="Database" note="From the schema. The SQL inside migrations isn’t read.">
      <div className="files">
        {line('New tables', s.tables.added)}
        {line('Tables it changes', s.tables.changed)}
        {line('Tables it removes', s.tables.removed)}
        {line('New lists of values', s.lists.added)}
        {line('Lists of values it changes', s.lists.changed)}
        {line('Lists it removes', s.lists.removed)}
        {line(s.migrations.length === 1 ? 'A migration' : `${s.migrations.length} migrations`, s.migrations)}
        {s.settings && <div className="file"><span>Its connection or generator settings</span><span className="dim">changed</span></div>}
      </div>
    </Group>
  )
}
