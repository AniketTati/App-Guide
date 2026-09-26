import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkWork, home, type HomeResult, type ProjectState } from '../core/service.js'
import { productOnMain } from '../core/product.js'
import { draftTask } from '../core/ask.js'
import { METHODS, type Project } from '../shared/api.js'

/**
 * Development only: the same calls over HTTP so every screen can be run and
 * checked in a browser. Read-only by construction — one fixed project from the
 * environment, nothing that writes a repository, marks kept in memory, and it
 * answers only to requests addressed to localhost, so a page on the internet
 * cannot reach it through DNS tricks.
 */
const path = process.env['APPGUIDE_DEV_PROJECT']
if (path === undefined) { console.error('set APPGUIDE_DEV_PROJECT to a repository'); process.exit(1) }
const project: Project = { id: 'dev', name: basename(path), path }
const state: ProjectState = { ...(process.env['APPGUIDE_DEV_SEEN'] ? { seenMain: process.env['APPGUIDE_DEV_SEEN'] } : {}), checked: {} }
const cache = process.env['APPGUIDE_DEV_CACHE'] ?? join(tmpdir(), 'appguide-dev-cache')
const PORT = 5198
let last: HomeResult | undefined

const calls: Record<string, (...a: string[]) => Promise<unknown>> = {
  projects: async () => [project],
  addProject: async () => null,
  removeProject: async () => undefined,
  home: async () => { last = await home(project, state, cache); state.seenMain ??= last.baseHead; return last.view },
  check: async (_id, workId) => (await checkWork(project, workId!, state, cache)).view,
  product: async () => ({ ...(await productOnMain(project.path, cache)), publicOk: state.publicOk ?? [] }),
  draftTask: async (_id, input) => draftTask(project.path, JSON.parse(input!) as never, cache),
  // The development server never writes to a repository.
  addTask: async () => { throw new Error('the development server is read-only — add tasks from the app') },
  openClaude: async () => false,
  markSeen: async () => { if (last) state.seenMain = last.baseHead },
  markChecked: async (_id, workId) => { const w = last?.work.find((x) => x.id === workId); if (w) state.checked[workId!] = { at: new Date().toISOString(), head: w.head, dirty: w.dirty, fingerprint: w.fingerprint } },
  markPublic: async (_id, route, on) => { const list = new Set(state.publicOk ?? []); if (on === 'on') list.add(route!); else list.delete(route!); state.publicOk = [...list] },
  copy: async () => undefined,
}

createServer((req, res) => {
  const host = req.headers.host ?? ''
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403).end(); return }
  // A page on another site can send a simple POST here; its Origin says so.
  const origin = req.headers.origin
  if (origin !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) { res.writeHead(403).end(); return }
  const method = /^\/api\/(\w+)$/.exec(req.url ?? '')?.[1]
  if (req.method !== 'POST' || method === undefined || !(METHODS as readonly string[]).includes(method)) { res.writeHead(404).end(); return }
  let body = ''
  req.on('data', (d: Buffer) => { body += d.toString(); if (body.length > 1_000_000) req.destroy() })
  req.on('end', async () => {
    try {
      const args = JSON.parse(body || '[]') as unknown
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('calls take ids')
      const result = await calls[method]!(...(args as string[]))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`App Guide dev server on http://127.0.0.1:${PORT} for ${path}`))
