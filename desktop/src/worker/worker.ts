import { checkWork, home, type ProjectState } from '../core/service.js'
import { listWork } from '../../../src/check/work.js'
import { productOnMain } from '../core/product.js'
import { addDraftedTask, draftTask } from '../core/ask.js'
import type { AskInput } from '../shared/api.js'
import type { Project } from '../shared/api.js'

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
      result = { baseHead, work: work.map((w) => ({ id: w.id, branch: w.branch, head: w.head, dirty: w.uncommitted.length, ahead: w.ahead })) }
    }
    port.postMessage({ id: req.id, ok: true, result })
  } catch (err) {
    port.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
