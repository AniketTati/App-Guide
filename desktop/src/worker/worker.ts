import { checkWork, home, type ProjectState } from '../core/service.js'
import { listWork } from '../../../src/check/work.js'
import { productOnMain } from '../core/product.js'
import { addDraftedTask, draftTask } from '../core/ask.js'
import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskInput } from '../shared/api.js'
import type { Project } from '../shared/api.js'

// Scratch copies a crash left behind: every read makes one and removes it,
// but a killed reader can't. An hour old is nobody's.
void (async () => {
  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    if (!/^appguide-(commit|product|merge)-/.test(name)) continue
    const path = join(tmpdir(), name)
    const st = await stat(path).catch(() => null)
    if (st !== null && Date.now() - st.mtimeMs > 3_600_000) await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
})()

/**
 * Runs in an Electron utility process, never in the window's: a full read of
 * a large repository takes seconds and hundreds of megabytes of syntax trees.
 * One request at a time; each carries everything it needs.
 */
type Request =
  | { id: number; method: 'home'; project: Project; state: ProjectState; cacheDir: string }
  | { id: number; method: 'check'; project: Project; workId: string; state: ProjectState; cacheDir: string }
  | { id: number; method: 'poll'; project: Project }
  | { id: number; method: 'product'; project: Project; cacheDir: string }
  | { id: number; method: 'draft' | 'addTask'; project: Project; input: AskInput; cacheDir: string }

interface ParentPort { on(event: 'message', listener: (e: { data: Request }) => void): void; postMessage(message: unknown): void }
const port = (process as unknown as { parentPort: ParentPort }).parentPort

port.on('message', async ({ data: req }) => {
  try {
    let result: unknown
    if (req.method === 'home') result = await home(req.project, req.state, req.cacheDir)
    else if (req.method === 'check') result = await checkWork(req.project, req.workId, req.state, req.cacheDir)
    else if (req.method === 'product') result = await productOnMain(req.project.path, req.cacheDir)
    else if (req.method === 'draft') result = await draftTask(req.project.path, req.input, req.cacheDir)
    else if (req.method === 'addTask') result = await addDraftedTask(req.project.path, req.input, req.cacheDir)
    else {
      // Cheap: git only. Used to notice new commits between looks.
      const { baseHead, work } = await listWork(req.project.path)
      result = { baseHead, work: work.map((w) => ({ id: w.id, branch: w.branch, head: w.head, dirty: w.uncommitted.length, ahead: w.ahead, fingerprint: w.fingerprint })) }
    }
    port.postMessage({ id: req.id, ok: true, result })
  } catch (err) {
    port.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
