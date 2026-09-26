import { useState } from 'react'
import type { ChangeView, HomeView, TaskView, WorkView } from '../shared/api.js'
import { ago, plural } from './format.js'
import { Button, Empty, Section, Status } from './ui.js'
import { ChangeList } from './Changes.js'
import { Md, MdBlock } from './Md.js'

export function Home({ home, refreshing, onRefresh, onCheck, onSeen }: {
  home: HomeView; refreshing: boolean; onRefresh: () => void; onCheck: (workId: string) => void; onSeen: () => void
}) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{home.project.name}</h1>
          <p className="lede">{lede(home)}</p>
        </div>
        <Button onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Reading…' : 'Read again'}</Button>
      </div>

      <Section title="Waiting on you" count={home.waiting.length}>
        {home.waiting.length === 0 ? <Empty>Nothing in your tracker is waiting on you.</Empty> : home.waiting.map((t) => <WaitingTask key={t.id} task={t} />)}
      </Section>

      <Section title="In flight" count={home.work.length} note={home.work.length > 0 ? 'Work that isn’t on main yet — your checkout and every worktree Claude is using.' : undefined}>
        {home.work.length === 0 ? <Empty>Nothing is in flight: every branch is on main.</Empty> : home.work.map((w) => <WorkRow key={w.id} work={w} onCheck={() => onCheck(w.id)} />)}
      </Section>

      <Section title="On main since you last looked" count={home.main === null ? undefined : home.main.commits.length}
        action={home.main !== null && home.main.commits.length > 0 ? <Button onClick={onSeen}>Mark as seen</Button> : undefined}>
        <MainSince main={home.main} />
      </Section>

      <Section title={`${home.project.name} on main today`}>
        <div className="facts">
          <Fact n={home.product.routes} label="routes" />
          <Fact n={home.product.noCheck} label="with no check found" accent={home.product.noCheck > 0} />
          <Fact n={home.product.tables} label="kinds of data" />
          <Fact n={home.product.services} label="outside services" />
          <Fact n={home.product.packages} label="packages" />
        </div>
      </Section>
    </div>
  )
}

function lede(home: HomeView): string {
  const parts: string[] = []
  parts.push(home.waiting.length === 0 ? 'Nothing is waiting on you' : `${plural(home.waiting.length, 'task')} waiting on you`)
  parts.push(home.work.length === 0 ? 'nothing in flight' : `${home.work.length} in flight`)
  const moved = home.main?.commits.length ?? 0
  if (moved > 0) parts.push(`${plural(moved, 'commit')} on main since you looked`)
  return `${parts.join(' · ')}.`
}

function WaitingTask({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false)
  const why = task.worklog.find((w) => /^why\b/i.test(w.label)) ?? task.worklog.find((w) => /left out|follow/i.test(w.label))
  return (
    <div className="row row-task">
      <button type="button" className="row-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="task-id">{task.id}</span>
        <span className="row-title"><Md text={task.title} /></span>
        <Status status={task.status} />
      </button>
      {why !== undefined && <p className="row-detail"><span className="label">{why.label}:</span> <Md text={why.text} /></p>}
      {open && <TaskBody task={task} />}
    </div>
  )
}

export function TaskBody({ task }: { task: TaskView }) {
  return (
    <div className="task-body">
      {task.criteria.length > 0 && (
        <>
          <h4>Acceptance criteria</h4>
          <ul>{task.criteria.map((c, i) => <li key={i}><Md text={c} /></li>)}</ul>
        </>
      )}
      {task.worklog.length > 0 && (
        <>
          <h4>Worklog <span className="dim">— written by Claude</span></h4>
          <dl>{task.worklog.map((w, i) => <div key={i}><dt>{w.label}</dt><dd><Md text={w.text} /></dd></div>)}</dl>
        </>
      )}
      {task.criteria.length === 0 && task.worklog.length === 0 && task.text !== '' && <MdBlock text={task.text} />}
      <p className="source">{task.file}:{task.line}</p>
    </div>
  )
}

function WorkRow({ work, onCheck }: { work: WorkView; onCheck: () => void }) {
  const size = work.ahead > 0
    ? `${plural(work.ahead, 'commit')} · ${plural(work.changed, 'file')}${work.uncommitted > 0 ? ` · ${work.uncommitted} uncommitted` : ''}`
    : `${plural(work.uncommitted, 'uncommitted file')} · no commits yet`
  return (
    <div className="row row-work">
      <div className="work-main">
        <div className="work-name">
          <span className="row-title">{work.label}</span>
          {work.branch !== null && <span className="code dim">{work.branch}</span>}
          {work.where === 'worktree' && <span className="tag">Claude worktree</span>}
        </div>
        <div className="work-meta">
          <span>{size}</span>
          {work.lastCommit !== null && <span className="dim">last commit {ago(work.lastCommit)}</span>}
          {work.tasks.map((t) => <span key={t.id} className="chip" title={t.title}>{t.id}{t.status !== null && t.status !== 'DONE' ? ` · ${t.status}` : ''}</span>)}
          {work.sharesWith.map((s) => <span key={s.label} className="chip chip-warn" title="Merging both may conflict">shares {plural(s.files, 'file')} with {s.label}</span>)}
        </div>
      </div>
      <div className="work-side">
        <span className={work.checkedAt === null || work.movedSinceCheck ? 'accent-text' : 'dim'}>
          {work.checkedAt === null ? 'not checked yet' : work.movedSinceCheck ? 'changed since you checked' : `checked ${ago(work.checkedAt)}`}
        </span>
        <Button onClick={onCheck}>Check</Button>
      </div>
    </div>
  )
}

function MainSince({ main }: { main: HomeView['main'] }) {
  if (main === null) return <Empty>This is your first look. From now on, this shows what changes on main between your visits.</Empty>
  if (main.commits.length === 0) return <Empty>{main.sentence}</Empty>
  const byTask = new Map<string, number>()
  for (const c of main.commits) for (const t of c.tasks) byTask.set(t, (byTask.get(t) ?? 0) + 1)
  const shown: ChangeView[] = main.changes
  return (
    <div>
      <p className="sentence">{main.sentence}</p>
      {byTask.size > 0 && <div className="chips">{[...byTask].map(([t, n]) => <span key={t} className="chip">{t}{n > 1 ? ` ×${n}` : ''}</span>)}</div>}
      <ChangeList changes={shown} limit={8} />
    </div>
  )
}

function Fact({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return <div className="fact"><span className={`fact-n ${accent ? 'accent-text' : ''}`}>{n.toLocaleString()}</span><span className="fact-label">{label}</span></div>
}
