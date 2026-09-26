import { useState } from 'react'
import type { ChangeView, HomeView, TaskView, WorkView } from '../shared/api.js'
import { ago, plural } from './format.js'
import { Button, Empty, Section, Severity, Status } from './ui.js'
import { ChangeList } from './Changes.js'
import { Md, MdBlock } from './Md.js'

export function Home({ home, refreshing, onRefresh, onCheck, onSeen, onOpenChecks, onAsk }: {
  home: HomeView; refreshing: boolean; onRefresh: () => void; onCheck: (workId: string) => void; onSeen: () => void
  onOpenChecks: () => void; onAsk: (what: string, why: string) => void
}) {
  const ready = home.work.filter((w) => w.ready)
  const flight = home.work.filter((w) => !w.ready && !w.stale)
  const older = home.work.filter((w) => !w.ready && w.stale)
  const waiting = home.waiting.length + ready.length
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{headline(home, ready)}</h1>
          <p className="meta">
            <span>{flight.length === 0 ? 'Nothing else in flight' : `${plural(flight.length, 'piece')} of work in flight`}</span>
            <span>main as of {home.fetchedAt === null ? 'its last fetch' : `its last fetch, ${ago(home.fetchedAt)}`}</span>
            <span>read {ago(home.readAt)} · <button type="button" className="link" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'reading…' : 'read again'}</button></span>
          </p>
        </div>
      </div>

      <Section title="Waiting on you" count={waiting}>
        {waiting === 0 ? <Empty>Nothing in your tracker is waiting on you, and no finished work is waiting for a Check.</Empty> : (
          <>
            {home.waiting.map((t) => <WaitingTask key={t.id} task={t} onAsk={onAsk} />)}
            {ready.map((w) => <ReadyWork key={w.id} work={w} onCheck={() => onCheck(w.id)} />)}
          </>
        )}
      </Section>

      <Section title="In flight" count={flight.length} note={flight.length > 0 ? 'Work that isn’t on main yet — your checkout, the worktrees Claude is using, and recent branches.' : undefined}>
        {flight.length === 0 ? <Empty>Nothing else is in flight: no worktree or recent branch has work that isn’t on main.</Empty> : flight.map((w) => <WorkRow key={w.id} work={w} onCheck={() => onCheck(w.id)} />)}
      </Section>

      {(older.length > 0 || home.skipped.length > 0 || home.merged > 0) && <Older older={older} skipped={home.skipped} merged={home.merged} onCheck={onCheck} />}

      <MainSince main={home.main} reset={home.mainReset} onSeen={onSeen} />

      <Section title={`${home.project.name} on main today`}>
        <div className="facts">
          <Fact n={home.product.routes} label="routes" />
          <button type="button" className="fact" onClick={onOpenChecks} title="See each one, and mark the ones that are meant to be open">
            <span className={`fact-n ${home.product.noCheckUnreviewed > 0 ? 'accent-text' : ''}`}>{home.product.noCheck.toLocaleString()}</span>
            <span className="fact-label">with no check found{home.product.noCheck > 0 ? (home.product.noCheckUnreviewed === 0 ? ' · all marked public' : home.product.noCheckUnreviewed < home.product.noCheck ? ` · ${home.product.noCheckUnreviewed} not reviewed` : ' · not reviewed') : ''}</span>
          </button>
          <Fact n={home.product.tables} label="kinds of data" />
          <Fact n={home.product.services} label="outside services" />
        </div>
      </Section>
    </div>
  )
}

/** The answer first: what needs you, in one sentence. */
function headline(home: HomeView, ready: readonly WorkView[]): string {
  const parts: string[] = []
  if (home.waiting.length > 0) parts.push(`${plural(home.waiting.length, 'task')} ${home.waiting.length === 1 ? 'waits' : 'wait'} on you`)
  if (ready.length === 1) parts.push(`${ready[0]!.tasks[0]?.id ?? ready[0]!.label} is ready to check`)
  else if (ready.length > 1) parts.push(`${ready.length} pieces of work are ready to check`)
  const moved = home.main?.commits.length ?? 0
  if (parts.length === 0) return moved > 0 ? `Nothing needs you. ${plural(moved, 'commit')} landed on main since you looked.` : 'Nothing needs you right now.'
  return `${parts.join(', and ')}.`
}

function WaitingTask({ task, onAsk }: { task: TaskView; onAsk: (what: string, why: string) => void }) {
  const [open, setOpen] = useState(false)
  // The tracker's latest word first; the reason written with the task after.
  const why = task.worklog.find((w) => /^why\b/i.test(w.label)) ?? task.worklog.find((w) => /left out|follow/i.test(w.label))
  const said = task.latest ?? (why !== undefined ? why.text : null)
  return (
    <div className="row row-task">
      <button type="button" className="row-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="task-id">{task.id}</span>
        <span className="row-title"><Md text={task.title} /></span>
        <Severity value={task.severity} />
        <Status status={task.status} note={task.statusNote} />
      </button>
      {said !== null && <p className="row-detail"><span className="label">{task.latest !== null ? 'Where it stands:' : `${why!.label}:`}</span> <Md text={said} /></p>}
      {open && (
        <>
          <TaskBody task={task} />
          <p className="row-detail"><button type="button" className="link" onClick={() => onAsk(`Follow up on ${task.id}: ${task.title}`, said ?? '')}>Ask Claude to follow up on this…</button></p>
        </>
      )}
    </div>
  )
}

function ReadyWork({ work, onCheck }: { work: WorkView; onCheck: () => void }) {
  return (
    <div className="row row-work">
      <div className="work-main">
        <div className="work-name">
          <span className="row-title">{work.label}</span>
          {work.tasks.map((t) => <span key={t.id} className="chip id" title={t.title}>{t.id}</span>)}
        </div>
        <div className="work-meta">
          <span>{work.movedSinceCheck ? 'Changed since you checked it' : 'Finished — every task done, all committed — and not checked yet'}</span>
          <span className="dim">{work.name} · {plural(work.ahead, 'commit')}{work.lastCommit !== null ? ` · ${ago(work.lastCommit)}` : ''}</span>
        </div>
      </div>
      <div className="work-side"><Button primary onClick={onCheck}>Check it</Button></div>
    </div>
  )
}

export function TaskBody({ task }: { task: TaskView }) {
  return (
    <div className="task-body">
      {task.criteria.length > 0 && (
        <>
          <h4>Done when</h4>
          <ul>{task.criteria.map((c, i) => <li key={i}><Md text={c} /></li>)}</ul>
        </>
      )}
      {(task.worklog.length > 0 || (task.criteria.length === 0 && task.text !== '')) && (
        <details className="claude">
          <summary>What Claude wrote about it</summary>
          {task.worklog.length > 0
            ? <dl>{task.worklog.map((w, i) => <div key={i}><dt>{w.label}</dt><dd><Md text={w.text} /></dd></div>)}</dl>
            : <MdBlock text={task.text} />}
        </details>
      )}
      <p className="note code">{task.file}:{task.line}</p>
    </div>
  )
}

function WorkRow({ work, onCheck }: { work: WorkView; onCheck: () => void }) {
  const size = work.ahead > 0
    ? `${plural(work.ahead, 'commit')} · ${plural(work.changed, 'file')}${work.uncommitted > 0 ? ` · ${work.uncommitted} not committed` : ''}`
    : `${plural(work.uncommitted, 'file')} changed · nothing committed yet`
  return (
    <div className="row row-work">
      <div className="work-main">
        <div className="work-name">
          <span className="row-title">{work.label}</span>
          {work.tasks.map((t) => <span key={t.id} className="chip id" title={t.title}>{t.id}{t.status !== null && t.status !== 'DONE' ? ` · ${t.status}` : ''}</span>)}
        </div>
        <div className="work-meta">
          <span className="dim">{work.where === 'checkout' ? 'your checkout' : work.where === 'worktree' ? `Claude worktree ${work.name}` : `branch ${work.name}`}{work.branch !== null && work.where !== 'branch' ? ` · ${work.branch}` : ''}</span>
          <span>{size}</span>
          {work.lastCommit !== null && <span className="dim">last commit {ago(work.lastCommit)}</span>}
          {work.sharesWith.map((s) => <span key={s.label} className="dim" title="Both change these files; the Check says whether they merge.">shares {plural(s.files, 'file')} with {s.label}</span>)}
        </div>
      </div>
      <div className="work-side">
        <span className={work.checkedAt !== null && work.movedSinceCheck ? 'accent-text' : 'dim'}>
          {work.checkedAt === null ? '' : work.movedSinceCheck ? 'changed since you checked' : `checked ${ago(work.checkedAt)}`}
        </span>
        <Button onClick={onCheck}>Check</Button>
      </div>
    </div>
  )
}

function Older({ older, skipped, merged, onCheck }: { older: WorkView[]; skipped: HomeView['skipped']; merged: number; onCheck: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const newest = older.map((w) => w.lastCommit).filter((d): d is string => d !== null).sort().pop() ?? null
  const summary = [
    older.length > 0 ? `${plural(older.length, 'older branch', 'older branches')} with work not on main${newest !== null ? `, the newest from ${ago(newest)}` : ''}` : '',
    merged > 0 ? `${plural(merged, 'branch', 'branches')} already on main` : '',
    skipped.length > 0 ? `${skipped.length} I couldn’t read` : '',
  ].filter(Boolean).join(' · ')
  return (
    <Section title="Older branches" quiet>
      <p className="note"><button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : summary}</button></p>
      {open && (
        <>
          {older.map((w) => (
            <div key={w.id} className="row row-work">
              <div className="work-main">
                <div className="work-name"><span className="row-title">{w.label}</span></div>
                <div className="work-meta"><span className="dim">{w.name}</span><span>{plural(w.ahead, 'commit')} · {plural(w.changed, 'file')}</span>{w.lastCommit !== null && <span className="dim">last commit {ago(w.lastCommit)}</span>}</div>
              </div>
              <div className="work-side"><Button onClick={() => onCheck(w.id)}>Check</Button></div>
            </div>
          ))}
          {skipped.map((s) => <p key={s.name} className="note">{s.name}: not read — {s.reason}.</p>)}
          {merged > 0 && <p className="note">{plural(merged, 'branch', 'branches')} left out: everything they change is already the same on main.</p>}
        </>
      )}
    </Section>
  )
}

function MainSince({ main, reset, onSeen }: { main: HomeView['main']; reset: boolean; onSeen: () => void }) {
  if (reset) return <Section title="On main since you last looked" quiet><p className="note">Main’s history was rewritten since your last look, so I’m counting again from today.</p></Section>
  if (main === null) return <Section title="On main since you last looked" quiet><p className="note">This is your first look. From now on, this shows what lands on main between your visits.</p></Section>
  if (main.commits.length === 0) return <Section title="On main since you last looked" quiet><p className="note">{main.sentence}</p></Section>
  const byTask = new Map<string, number>()
  for (const c of main.commits) for (const t of c.tasks) byTask.set(t, (byTask.get(t) ?? 0) + 1)
  const shown: ChangeView[] = main.changes
  return (
    <Section title="On main since you last looked" count={main.commits.length} action={<Button onClick={onSeen}>Mark as seen</Button>}>
      <p className="sentence">{main.sentence}</p>
      {byTask.size > 0 && <div className="chips">{[...byTask].map(([t, n]) => <span key={t} className="chip id">{t}{n > 1 ? ` ×${n}` : ''}</span>)}</div>}
      <ChangeList changes={shown} limit={8} />
    </Section>
  )
}

function Fact({ n, label }: { n: number; label: string }) {
  return <div className="fact"><span className="fact-n">{n.toLocaleString()}</span><span className="fact-label">{label}</span></div>
}
