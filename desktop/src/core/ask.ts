import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listWork } from '../../../src/check/work.js'
import { baseRef, git } from '../../../src/git/repo.js'
import { addTask, digest, formatTask, insertTask, problemWith, SEVERITIES, shapeOf, suggestId, type TaskDraft } from '../../../src/tracker/draft.js'
import { parseTasks, readTasks, type Task } from '../../../src/tracker/tasks.js'
import { productOnMain } from './product.js'
import type { AskInput, DraftView, ProductView, RouteRow, ScreenRow } from '../shared/api.js'

/** "Ask for a change": a task in the tracker's own shape, and a brief for
 *  Claude built from what the code says about the screens and routes the PM
 *  picked. Drafting writes nothing. */
export async function draftTask(root: string, input: AskInput, cacheDir: string): Promise<DraftView> {
  return (await prepare(root, input, cacheDir)).view
}

/** The preview, and the exact entry and tracker it was made from. */
async function prepare(root: string, input: AskInput, cacheDir: string): Promise<{ view: DraftView; entry: string; tracker: string }> {
  const [tasks, product, branch] = await Promise.all([readTasks(root), productOnMain(root, cacheDir), currentBranch(root)])
  const file = trackerFile(tasks)
  const tracker = file === null ? '' : await readFile(join(root, file), 'utf8').catch(() => '')
  const used = await idsEverywhere(root, file, tasks)
  const date = today()
  const suggestedId = suggestId(tasks, file ?? '', tracker, date, used)
  const picked = resolvePicks(input.picks, product)
  const severity = SEVERITIES.find((s) => s === input.severity) ?? null
  const draft: TaskDraft = {
    id: (input.id ?? '').trim() === '' ? suggestedId : input.id!.trim(),
    title: input.what.split('\n')[0] ?? '',
    why: [input.what.split('\n').slice(1).join(' '), input.why].filter((s) => s.trim() !== '').join(' '),
    evidence: picked.map((p) => p.evidence),
    criteria: input.criteria,
    severity,
  }
  const entry = formatTask(draft, shapeOf(tasks, file ?? '', tracker))
  const { block } = insertTask(tracker, entry, date)
  const problem = file === null ? 'I didn’t find a tracker in this product — copy the brief for Claude instead.' : problemWith(draft, used)
  const view: DraftView = {
    id: draft.id, suggestedId, file, branch,
    text: file === null ? entry.trimEnd() : block,
    brief: brief(draft, entry, file, date, picked, product.base),
    problem,
    cantAdd: file === null ? 'There is no tracker to add it to.' : await cantAdd(root, file, branch),
    hash: digest(`${file}\u0000${digest(tracker)}\u0000${block}`),
  }
  return { view, entry, tracker }
}

/**
 * Adds the task exactly as previewed. Refuses if the preview would now come
 * out differently — another ID taken, the tracker edited — or if the checkout
 * isn't a clean, current main, where the task would land on someone's branch.
 */
export async function addDraftedTask(root: string, input: AskInput, cacheDir: string): Promise<{ id: string; file: string; line: number }> {
  const { view, entry, tracker } = await prepare(root, input, cacheDir)
  if (view.problem !== null || view.file === null) throw new Error(view.problem ?? 'no tracker')
  if (view.cantAdd !== null) throw new Error(view.cantAdd)
  if (input.hash === undefined || input.hash !== view.hash) throw new Error('The tracker changed since you saw the preview — look at it again before adding.')
  const { line } = await addTask(root, view.file, entry, today(), digest(tracker))
  return { id: view.id, file: view.file, line }
}

/** Why the app shouldn't write the task itself, or null when it may. */
async function cantAdd(root: string, file: string, branch: string | null): Promise<string | null> {
  const base = await baseRef(root).catch(() => null)
  const main = base?.replace(/^origin\//, '') ?? 'main'
  if (branch !== main) return `Your checkout is on ${branch ?? 'no branch'}, not ${main}: the task would land on that branch. Copy it for Claude instead — the brief has Claude add it to the tracker first.`
  const dirty = (await git(root, ['status', '--porcelain=v1', '-z', '--', file]).catch(() => '')) !== ''
  if (dirty) return `${file} has changes nobody has committed yet. Copy it for Claude instead — the brief has Claude add it to the tracker first.`
  if (base !== null && base !== main) {
    const behind = Number((await git(root, ['rev-list', '--count', `HEAD..${base}`]).catch(() => '0')).trim())
    if (behind > 0) return `Your checkout of ${main} is ${behind} commit${behind === 1 ? '' : 's'} behind. Copy it for Claude instead — the brief has Claude add it to the tracker first.`
  }
  return null
}

/**
 * Every task ID in use: in the checkout's tracker, main's, each worktree's
 * and each branch's — an ID Claude gave a task on a branch is taken too.
 */
async function idsEverywhere(root: string, file: string | null, local: readonly Task[]): Promise<Set<string>> {
  const out = new Set(local.map((t) => t.id))
  if (file === null) return out
  const key = `${root}\u0000${file}`
  const hit = seen.get(key)
  if (hit !== undefined && Date.now() - hit.at < 30_000) { for (const id of hit.ids) out.add(id); return out }
  const ids = new Set<string>()
  const list = await listWork(root).catch(() => null)
  for (const w of list?.work ?? []) {
    if (w.path === null) continue
    for (const t of await readTasks(w.path).catch(() => [] as Task[])) ids.add(t.id)
  }
  const shas = new Set((await git(root, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes']).catch(() => '')).split('\n').filter(Boolean))
  for (const sha of shas) {
    const text = await git(root, ['show', `${sha}:${file}`]).catch(() => null)
    if (text !== null) for (const t of parseTasks(file, text)) ids.add(t.id)
  }
  seen.set(key, { at: Date.now(), ids })
  for (const id of ids) out.add(id)
  return out
}

const seen = new Map<string, { at: number; ids: Set<string> }>()

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The tracker the PM uses: a file named like one, with the most tasks. */
function trackerFile(tasks: readonly Task[]): string | null {
  const count = new Map<string, number>()
  for (const t of tasks) if (/tracker/i.test(t.file)) count.set(t.file, (count.get(t.file) ?? 0) + 1)
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

interface Picked { evidence: string; context: string }

function resolvePicks(picks: AskInput['picks'], product: ProductView): Picked[] {
  const screens = product.groups.flatMap((g) => g.screens)
  const routes = new Map<string, RouteRow>()
  for (const r of [...screens.flatMap((s) => s.routes), ...product.behind, ...product.layout, ...product.shared.flatMap((s) => s.routes)]) routes.set(`${r.method} ${r.path}`, r)
  const out: Picked[] = []
  for (const p of picks) {
    if (p.kind === 'screen') {
      const s = screens.find((x) => x.path === p.key)
      if (s !== undefined) out.push(screenPick(s))
    } else {
      const r = routes.get(p.key)
      if (r !== undefined) out.push(routePick(r))
    }
  }
  return out
}

function screenPick(s: ScreenRow): Picked {
  const file = s.file === null ? '' : ` — \`${s.file}\``
  return {
    evidence: `The ${s.name} screen (\`${s.path}\`)${file}`,
    context: `The ${s.name} screen (${s.path})${s.file === null ? '' : ` is ${s.file}`}; it calls ${s.routes.length} route${s.routes.length === 1 ? '' : 's'}${s.routes.length > 0 ? `, including ${s.routes.slice(0, 5).map((r) => `${r.method} ${r.path}`).join(', ')}` : ''}.`,
  }
}

function routePick(r: RouteRow): Picked {
  const who = r.who === null ? (Array.isArray(r.checks) && r.checks.length > 0 ? `checked by ${r.checks.join(', ')}` : 'no check found')
    : r.who.length === 0 ? 'no role has its permission' : `callable by ${r.who.map((w) => `${w.role}${w.scope !== null && w.scope !== 'org' ? ` (${w.scope})` : ''}`).join(', ')}`
  const changes = r.data.filter((d) => d.kind === 'write').map((d) => d.table)
  return {
    evidence: `\`${r.method} ${r.path}\` in \`${r.where}\``,
    context: `${r.method} ${r.path} (${r.where}): ${who}${changes.length > 0 ? `; it changes ${changes.join(', ')}` : ''}.`,
  }
}

/** The task goes into the tracker before any code: whoever works it, the
 *  record is on the branch with the work. */
function brief(d: TaskDraft, entry: string, file: string | null, date: string, picked: readonly Picked[], base: string): string {
  const lines = file === null
    ? ['Here is a task. Add it to the project’s tracker first, in its own commit, then work it.', '', entry.trimEnd()]
    : [
        `First make sure task ${d.id} below is in ${file}: if it isn't, add it under a section headed "## Asked for in App Guide (${date})", before the run log and summary, and commit that on its own. Then work it, following the cycle and ground rules at the top of ${file}, and name the task in each commit subject, like "(${d.id})".`,
        '',
        entry.trimEnd(),
      ]
  if (picked.length > 0) {
    lines.push('', `For context, read from the code on ${base} by App Guide:`)
    for (const p of picked) lines.push(`- ${p.context}`)
  }
  return lines.join('\n')
}

async function currentBranch(root: string): Promise<string | null> {
  try { return (await git(root, ['branch', '--show-current'])).trim() || null } catch { return null }
}
