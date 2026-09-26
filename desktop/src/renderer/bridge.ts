import type { Api, Method } from '../shared/api.js'

declare global {
  interface Window {
    appguide?: {
      call(method: string, ...args: string[]): Promise<unknown>
      onChanged(listener: (projectId: string, moved: [string, string][]) => void): () => void
    }
  }
}

/** Inside the app: the preload bridge. In a browser during development: the
 *  read-only dev server, through Vite's proxy. */
async function call(method: Method, ...args: string[]): Promise<unknown> {
  if (window.appguide !== undefined) return window.appguide.call(method, ...args)
  const res = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
  const data = (await res.json()) as unknown
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${method} failed`)
  return data
}

export const api: Api = {
  projects: () => call('projects') as ReturnType<Api['projects']>,
  addProject: () => call('addProject') as ReturnType<Api['addProject']>,
  removeProject: (id) => call('removeProject', id) as ReturnType<Api['removeProject']>,
  home: (id) => call('home', id) as ReturnType<Api['home']>,
  product: (id) => call('product', id) as ReturnType<Api['product']>,
  check: (id, workId) => call('check', id, workId) as ReturnType<Api['check']>,
  markSeen: (id) => call('markSeen', id) as ReturnType<Api['markSeen']>,
  markChecked: (id, workId) => call('markChecked', id, workId) as ReturnType<Api['markChecked']>,
  markPublic: (id, route, on) => call('markPublic', id, route, on) as ReturnType<Api['markPublic']>,
  draftTask: (id, input) => call('draftTask', id, input) as ReturnType<Api['draftTask']>,
  addTask: (id, input) => call('addTask', id, input) as ReturnType<Api['addTask']>,
  openClaude: () => call('openClaude') as ReturnType<Api['openClaude']>,
  openScreen: (id, workId, path) => call('openScreen', id, workId, path) as ReturnType<Api['openScreen']>,
  workProduct: (id, workId) => call('workProduct', id, workId) as ReturnType<Api['workProduct']>,
  notes: (id) => call('notes', id) as ReturnType<Api['notes']>,
  addNote: (id, note) => call('addNote', id, note) as ReturnType<Api['addNote']>,
  removeNote: (id, noteId) => call('removeNote', id, noteId) as ReturnType<Api['removeNote']>,
  markNotesSent: (id, ids) => call('markNotesSent', id, ids) as ReturnType<Api['markNotesSent']>,
  copy: async (text) => {
    if (window.appguide !== undefined) { await call('copy', text); return }
    await navigator.clipboard.writeText(text)
  },
}

export const inApp = (): boolean => window.appguide !== undefined
/** Something changed between looks: new commits, or — for the work named,
 *  with its new fingerprint — edits Claude is still making. */
export const onChanged = (listener: (projectId: string, moved: [string, string][]) => void): (() => void) =>
  window.appguide?.onChanged(listener) ?? (() => undefined)
