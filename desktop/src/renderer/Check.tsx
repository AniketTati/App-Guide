import { useEffect, useState } from 'react'
import type { ChangeKind, CheckView } from '../shared/api.js'
import { api } from './bridge.js'
import { plural } from './format.js'
import { Button, Empty, Section, Spinner, Status } from './ui.js'
import { ChangeList } from './Changes.js'
import { TaskBody } from './Home.js'
import { Md } from './Md.js'

const KINDS: { kind: ChangeKind; title: string }[] = [
  { kind: 'route', title: 'Routes' },
  { kind: 'data', title: 'Data' },
  { kind: 'service', title: 'Outside services' },
  { kind: 'package', title: 'Packages' },
  { kind: 'code', title: 'Code other parts can use' },
]

export function CheckScreen({ projectId, workId, onBack }: { projectId: string; workId: string; onBack: () => void }) {
  const [view, setView] = useState<CheckView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [marked, setMarked] = useState(false)

  useEffect(() => {
    setView(null)
    void api.check(projectId, workId).then(setView).catch((e: Error) => setError(e.message))
  }, [projectId, workId])

  if (error !== null) return <div className="page"><button type="button" className="back" onClick={onBack}>← Home</button><div className="error">{error}</div></div>
  if (view === null) return <div className="page"><button type="button" className="back" onClick={onBack}>← Home</button><div className="center"><Spinner label="Reading this work against main…" /></div></div>

  const w = view.work
  const total = KINDS.reduce((n, k) => n + view.changes[k.kind].length, 0)
  return (
    <div className="page">
      <button type="button" className="back" onClick={onBack}>← Home</button>
      <div className="page-head">
        <div>
          <h1>{w.where === 'checkout' && w.branch !== null ? w.branch : w.label}</h1>
          <p className="lede">
            {w.where === 'checkout' ? 'Your checkout' : w.branch !== null ? <span className="code">{w.branch}</span> : 'This worktree'} against <span className="code">{view.base}</span>
            {' · '}{w.ahead > 0 ? plural(w.ahead, 'commit') : 'no commits yet'}
            {w.uncommitted > 0 && ` · ${plural(w.uncommitted, 'uncommitted file')}`}
          </p>
        </div>
        <div className="head-actions">
          <Button onClick={() => { void api.copy(view.followUp).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }) }}>{copied ? 'Copied' : 'Copy a follow-up for Claude'}</Button>
          <Button primary onClick={() => { void api.markChecked(projectId, workId).then(() => setMarked(true)) }} disabled={marked}>{marked ? 'Checked' : 'Mark checked'}</Button>
        </div>
      </div>

      <p className="sentence big">{view.sentence}</p>

      <Section title="Tasks" count={view.tasks.length} note={view.tasks.length > 0 ? 'As this branch’s own tracker describes them.' : undefined}>
        {view.tasks.length === 0
          ? <Empty>{w.ahead === 0 ? 'No commits yet, so no task is named. Tasks show once Claude commits.' : 'Its commits don’t name a task.'}</Empty>
          : view.tasks.map((t) => (
            <div key={t.id} className="row row-task">
              <div className="row-main static"><span className="task-id">{t.id}</span><span className="row-title"><Md text={t.title} /></span><Status status={t.status} /></div>
              <TaskBody task={t} />
            </div>
          ))}
        {view.unknownTasks.length > 0 && <p className="note">Its commits also name {view.unknownTasks.join(', ')}, which no tracker defines.</p>}
      </Section>

      <Section title="What it changes" count={total} note={total === 0 ? undefined : 'Read from the code, compared with main. Nothing here comes from Claude’s description.'}>
        {total === 0 ? <Empty>Nothing about how the product is put together — routes, data, services, packages — changed.</Empty> : KINDS.filter((k) => view.changes[k.kind].length > 0).map((k) => (
          <div key={k.kind} className="group">
            <h3>{k.title} <span className="count">{view.changes[k.kind].length}</span></h3>
            <ChangeList changes={view.changes[k.kind]} limit={k.kind === 'code' ? 6 : 25} />
          </div>
        ))}
      </Section>

      {view.outside.length > 0 && (
        <Section title="Outside what its tasks name" count={view.outside.length} note="Files it changed that none of its tasks mention. Often fine — worth a look before merging.">
          <FileList files={view.outside} />
        </Section>
      )}

      <Section title="Shared with other work in flight" count={view.shared.length}>
        {view.shared.length === 0 ? <Empty>No other work in flight changes the same files.</Empty> : (
          <div className="files">{view.shared.map((s) => <div key={s.file} className="file"><span className="code">{s.file}</span><span className="dim">also changed in {s.with.join(', ')}</span></div>)}</div>
        )}
      </Section>

      <Section title="Tests it touched" count={view.tests.length}>
        {view.tests.length === 0 ? <Empty>It changed no test files.</Empty> : <FileList files={view.tests} />}
      </Section>

      <p className="footnote">This can’t tell you whether it works — only what it changed. The worklog above is Claude’s own account.</p>
    </div>
  )
}

function FileList({ files }: { files: readonly string[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? files : files.slice(0, 12)
  return (
    <div className="files">
      {shown.map((f) => <div key={f} className="file"><span className="code">{f}</span></div>)}
      {!all && files.length > 12 && <button type="button" className="more" onClick={() => setAll(true)}>Show all {files.length}</button>}
    </div>
  )
}
