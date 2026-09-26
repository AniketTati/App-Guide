import { git } from '../../../src/check/work.js'
import { addTask, formatTask, problemWith, suggestId, type TaskDraft } from '../../../src/tracker/draft.js'
import { readTasks, type Task } from '../../../src/tracker/tasks.js'
import { productOnMain } from './product.js'
import type { AskInput, DraftView, ProductView, RouteRow, ScreenRow } from '../shared/api.js'

/** "Ask for a change": a task in the tracker's own shape, and a brief for
 *  Claude built from what the code says about the screens and routes the PM
 *  picked. Drafting writes nothing. */
export async function draftTask(root: string, input: AskInput, cacheDir: string): Promise<DraftView> {
  const [tasks, product, branch] = await Promise.all([readTasks(root), productOnMain(root, cacheDir), currentBranch(root)])
  const file = trackerFile(tasks)
  const suggestedId = suggestId(tasks, file ?? '')
  const picked = resolvePicks(input.picks, product)
  const draft: TaskDraft = {
    id: (input.id ?? '').trim() === '' ? suggestedId : input.id!.trim(),
    title: input.what.split('\n')[0] ?? '',
    why: [input.what.split('\n').slice(1).join(' '), input.why].filter((s) => s.trim() !== '').join(' '),
    evidence: picked.map((p) => p.evidence),
    criteria: input.criteria,
  }
  const text = formatTask(draft)
  const problem = file === null ? 'I didn’t find a tracker in this product — copy the brief for Claude instead.' : problemWith(draft, tasks)
  return { id: draft.id, suggestedId, file, branch, text, brief: brief(draft, text, file, picked, product.base), problem }
}

export async function addDraftedTask(root: string, input: AskInput, cacheDir: string): Promise<{ id: string; file: string; line: number }> {
  const view = await draftTask(root, input, cacheDir)
  if (view.problem !== null || view.file === null) throw new Error(view.problem ?? 'no tracker')
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const { line } = await addTask(root, view.file, view.text, date)
  return { id: view.id, file: view.file, line }
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
  for (const r of [...screens.flatMap((s) => s.routes), ...product.behind, ...product.layout]) routes.set(`${r.method} ${r.path}`, r)
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

function brief(d: TaskDraft, text: string, file: string | null, picked: readonly Picked[], base: string): string {
  const lines = file === null
    ? ['Here is a task. Add it to the project’s tracker first, then work it.', '', text.trimEnd()]
    : [`Work task ${d.id} in ${file}, following the cycle and ground rules at the top of that file. Name the task in each commit subject, like "(${d.id})".`]
  if (file !== null) lines.push('', text.trimEnd())
  if (picked.length > 0) {
    lines.push('', `For context, read from the code on ${base} by App Guide:`)
    for (const p of picked) lines.push(`- ${p.context}`)
  }
  return lines.join('\n')
}

async function currentBranch(root: string): Promise<string | null> {
  try { return (await git(root, ['branch', '--show-current'])).trim() || null } catch { return null }
}
