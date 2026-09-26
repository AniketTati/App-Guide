import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { gitBinary, git } from '../../../src/git/repo.js'
import { METHODS, type Api, type AskInput, type CheckView, type DraftView, type HomeView, type Method, type ProductView, type Project } from '../shared/api.js'
import type { HomeResult, ProjectState } from '../core/service.js'

/**
 * The app's own process: its window, what it remembers, and the queue of
 * reads it hands to the utility process. It never reads a repository itself.
 */

interface State { projects: Project[]; projectState: Record<string, ProjectState> }
let state: State = { projects: [], projectState: {} }
const statePath = (): string => join(app.getPath('userData'), 'state.json')
/** Set when state.json existed but couldn't be read: nothing is saved over it. */
let unreadable = false

async function loadState(): Promise<void> {
  for (const path of [statePath(), `${statePath()}.bak`]) {
    let text: string
    try { text = await readFile(path, 'utf8') } catch { continue }
    try {
      const loaded = JSON.parse(text) as Partial<State>
      state = { projects: loaded.projects ?? [], projectState: loaded.projectState ?? {} }
      unreadable = false
      return
    } catch {
      unreadable = true
    }
  }
  if (unreadable) {
    // Keep the broken file for whoever looks, and start from nothing — never
    // save an empty state over what might still be recovered.
    const kept = `${statePath()}.unreadable-${Date.now()}`
    await rename(statePath(), kept).catch(() => undefined)
    unreadable = false
    await dialog.showMessageBox({ type: 'warning', message: 'App Guide couldn’t read what it remembered', detail: `Your products and checks will need adding again. The unreadable file was kept as ${basename(kept)}.` })
  }
}

// One save at a time, each through its own temporary file, the previous
// version kept as a backup: overlapping saves once raced each other away.
let saving: Promise<void> = Promise.resolve()
function saveState(): Promise<void> {
  const text = JSON.stringify(state, null, 2)
  const run = async (): Promise<void> => {
    await mkdir(app.getPath('userData'), { recursive: true })
    const tmp = `${statePath()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tmp, text, 'utf8')
    if (existsSync(statePath())) await copyFile(statePath(), `${statePath()}.bak`).catch(() => undefined)
    await rename(tmp, statePath())
  }
  const p = saving.then(run, run)
  saving = p.catch(() => undefined)
  return p
}

const find = (id: string): Project => {
  const p = state.projects.find((x) => x.id === id)
  if (p === undefined) throw new Error('no such product')
  return p
}
const stateOf = (id: string): ProjectState => (state.projectState[id] ??= { checked: {} })
// Not "cache": Chromium keeps its own "Cache" in the same folder, and a Mac's
// file names ignore case, so the two would be one folder it may empty. One
// folder per build of the reader: facts an older build read are never
// compared with a newer build's, which made every extractor change look like
// something Claude did.
const ENGINE = (() => {
  try { return createHash('sha256').update(readFileSync(join(__dirname, 'worker.cjs'))).digest('hex').slice(0, 12) } catch { return 'dev' }
})()
const factsRoot = (): string => join(app.getPath('userData'), 'facts')
const cacheDir = (id: string): string => join(factsRoot(), ENGINE, id)

/** Folders older builds left behind. */
async function sweepCaches(): Promise<void> {
  for (const entry of await readdir(factsRoot()).catch(() => [] as string[])) {
    if (entry !== ENGINE) await rm(join(factsRoot(), entry), { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── The reader, in a utility process, one request at a time ──────────────────
let worker: UtilityProcess | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function reader(): UtilityProcess {
  if (worker !== null) return worker
  const w = utilityProcess.fork(join(__dirname, 'worker.cjs'), [], { serviceName: 'App Guide reader' })
  w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = waiting.get(msg.id)
    if (p === undefined) return
    waiting.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'the reader failed'))
  })
  w.on('exit', () => {
    worker = null
    for (const p of waiting.values()) p.reject(new Error('the reader stopped'))
    waiting.clear()
  })
  worker = w
  return w
}

/** Long enough for a first read of a very large repository. A read that
 *  takes longer is stuck — a hung git, an unreachable file — and the reader
 *  is restarted rather than left to hold every screen. */
const READ_LIMIT = 5 * 60_000

let queue: Promise<unknown> = Promise.resolve()
function ask<T>(req: Record<string, unknown>): Promise<T> {
  const run = (): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return
      waiting.delete(id)
      reject(new Error('Reading took too long and was stopped. Try again — if it keeps happening, the repository may be very large or a file may be unreachable.'))
      worker?.kill()
    }, READ_LIMIT)
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    reader().postMessage({ id, ...req })
  })
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}

// ── What the page may ask for ─────────────────────────────────────────────────
const lastHome = new Map<string, HomeResult>()
const lastCheck = new Map<string, { head: string; dirty: number; fingerprint: string }>()

const handlers: { [M in Method]: (...args: string[]) => ReturnType<Api[M]> } = {
  async projects() { return state.projects },

  async addProject() {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Choose your product', message: 'Choose the folder your product’s code is in.', properties: ['openDirectory' as const], buttonLabel: 'Open' }
    const picked = win === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options)
    const folder = picked.filePaths[0]
    if (picked.canceled || folder === undefined) return null
    let top: string
    try {
      top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim()
    } catch {
      await dialog.showMessageBox({ type: 'info', message: 'That folder isn’t a git repository', detail: 'App Guide reads a product through its git history. Choose the folder your code lives in — the one Claude works in.' })
      return null
    }
    const existing = state.projects.find((p) => p.path === top)
    if (existing !== undefined) return existing
    const project: Project = { id: createHash('sha256').update(top).digest('hex').slice(0, 12), name: basename(top), path: top }
    state.projects.push(project)
    stateOf(project.id)
    await saveState()
    return project
  },

  async removeProject(id) {
    state.projects = state.projects.filter((p) => p.id !== id)
    delete state.projectState[id]
    await saveState()
  },

  async home(id): Promise<HomeView> {
    const project = find(id)
    const ps = stateOf(id)
    const result = await ask<HomeResult>({ method: 'home', project, state: ps, cacheDir: cacheDir(id) })
    lastHome.set(id, result)
    // The first look sets the baseline, as the receipt's first run does: from
    // here on, Home shows what changes on main. A baseline main's rewritten
    // history no longer has starts again, and Home says so.
    if (ps.seenMain === undefined || result.view.mainReset) { ps.seenMain = result.baseHead; await saveState() }
    return result.view
  },

  async product(id): Promise<ProductView> {
    const view = await ask<ProductView>({ method: 'product', project: find(id), cacheDir: cacheDir(id) })
    return { ...view, publicOk: stateOf(id).publicOk ?? [] }
  },

  async check(id, workId): Promise<CheckView> {
    const project = find(id)
    const r = await ask<{ view: CheckView; fingerprint: string; head: string }>({ method: 'check', project, workId, state: stateOf(id), cacheDir: cacheDir(id) })
    lastCheck.set(`${id}\u0000${workId}`, { head: r.head, dirty: r.view.work.uncommitted, fingerprint: r.fingerprint })
    return r.view
  },

  async markSeen(id) {
    const h = lastHome.get(id)
    if (h === undefined) return
    stateOf(id).seenMain = h.baseHead
    await saveState()
  },

  async markChecked(id, workId) {
    // What was read, not what is there now: checked means "as I saw it".
    const seen = lastCheck.get(`${id}\u0000${workId}`) ?? lastHome.get(id)?.work.find((w) => w.id === workId)
    if (seen === undefined) return
    stateOf(id).checked[workId] = { at: new Date().toISOString(), head: seen.head, dirty: seen.dirty, fingerprint: seen.fingerprint }
    await saveState()
  },

  async markPublic(id, route, on) {
    if (!/^[A-Z]+ \/\S{0,500}$/.test(route)) throw new Error('not a route')
    const ps = stateOf(id)
    const list = new Set(ps.publicOk ?? [])
    if (on === 'on') list.add(route)
    else list.delete(route)
    ps.publicOk = [...list].sort()
    await saveState()
  },

  async copy(text) {
    if (text.length <= 200_000) clipboard.writeText(text)
  },

  async draftTask(id, input): Promise<DraftView> {
    return ask<DraftView>({ method: 'draft', project: find(id), input: askInput(input), cacheDir: cacheDir(id) })
  },

  async addTask(id, input) {
    return ask<{ id: string; file: string; line: number }>({ method: 'addTask', project: find(id), input: askInput(input), cacheDir: cacheDir(id) })
  },

  async openClaude() {
    for (const path of ['/Applications/Claude.app', join(app.getPath('home'), 'Applications', 'Claude.app')]) {
      if (existsSync(path)) return (await shell.openPath(path)) === ''
    }
    return false
  },
}

/** What "Ask for a change" sends, checked field by field: only text, only
 *  within bounds, never anything that names a file or a command. */
function askInput(json: string): AskInput {
  const raw = JSON.parse(json) as Record<string, unknown>
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const picks = Array.isArray(raw['picks']) ? raw['picks'].slice(0, 40).flatMap((p) => {
    const o = p as Record<string, unknown>
    return (o['kind'] === 'screen' || o['kind'] === 'route') && typeof o['key'] === 'string' ? [{ kind: o['kind'] as 'screen' | 'route', key: o['key'].slice(0, 300) }] : []
  }) : []
  return {
    what: text(raw['what'], 4000),
    why: text(raw['why'], 4000),
    criteria: Array.isArray(raw['criteria']) ? raw['criteria'].slice(0, 20).map((c) => text(c, 1000)) : [],
    picks,
    ...(typeof raw['id'] === 'string' ? { id: raw['id'].slice(0, 8) } : {}),
  }
}

/** Only our own page may call — its exact file, or the development server
 *  when not packaged — only listed methods, and only with strings: ids and
 *  text, never objects that could carry a path or a command. */
const PAGE = pathToFileURL(join(__dirname, 'renderer', 'index.html')).href
function allowed(event: IpcMainInvokeEvent): boolean {
  const url = (event.senderFrame?.url ?? '').replace(/[?#].*$/, '')
  const dev = process.env['APPGUIDE_DEV_URL']
  return url === PAGE || (!app.isPackaged && dev !== undefined && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(dev) && url.startsWith(dev))
}

ipcMain.handle('api', async (event, method: unknown, args: unknown) => {
  if (!allowed(event)) throw new Error('not allowed')
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) throw new Error('unknown call')
  if (!Array.isArray(args) || args.length > 3 || args.some((a) => typeof a !== 'string' || a.length > 200_000)) throw new Error('calls take ids')
  return (handlers[method as Method] as (...a: string[]) => Promise<unknown>)(...(args as string[]))
})

// ── Noticing new work between looks ──────────────────────────────────────────
const lastPoll = new Map<string, { baseHead: string; work: Map<string, { head: string; ahead: number; branch: string | null; fingerprint: string }> }>()
let polling = false

async function poll(): Promise<void> {
  // A slow read must not stack a second poll behind it every minute.
  if (polling) return
  polling = true
  try { await pollAll() } finally { polling = false }
}

async function pollAll(): Promise<void> {
  for (const project of state.projects) {
    let r: { baseHead: string; work: { id: string; branch: string | null; head: string; ahead: number; fingerprint: string }[] }
    try { r = await ask({ method: 'poll', project }) } catch { continue }
    const before = lastPoll.get(project.id)
    const now = new Map(r.work.map((w) => [w.id, { head: w.head, ahead: w.ahead, branch: w.branch, fingerprint: w.fingerprint }]))
    lastPoll.set(project.id, { baseHead: r.baseHead, work: now })
    if (before === undefined) continue // the first poll is the baseline
    const news: string[] = []
    const moved: string[] = []
    for (const [id, w] of now) {
      const was = before.work.get(id)
      const name = w.branch ?? basename(id)
      if (was === undefined) news.push(`New work in flight: ${name}`)
      else if (w.head !== was.head && w.ahead > was.ahead) news.push(`${name}: ${w.ahead - was.ahead} new commit${w.ahead - was.ahead === 1 ? '' : 's'}`)
      if (was !== undefined && was.fingerprint !== w.fingerprint) moved.push(id)
    }
    if (r.baseHead !== before.baseHead) news.push('Main moved — see what changed')
    if (news.length > 0) {
      const n = new Notification({ title: project.name, body: news.slice(0, 3).join('\n') })
      n.on('click', () => { const win = BrowserWindow.getAllWindows()[0]; win?.show(); win?.focus() })
      n.show()
    }
    // Edits Claude is still making don't deserve a notification — but a
    // Check that is open on that work should say it has moved.
    if (news.length > 0 || moved.length > 0) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('changed', project.id, moved)
  }
}

// ── The window ───────────────────────────────────────────────────────────────
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 640,
    title: 'App Guide',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f6f4',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  // The page never navigates and never opens windows; links are not followed.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  const snapshot = process.env['APPGUIDE_SNAPSHOT']
  if (snapshot === undefined) win.once('ready-to-show', () => win.show())
  else {
    // For automated checks only: photograph the window once the first read
    // has had time to finish, then quit. The window is never shown.
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents.capturePage().then(async (image) => {
          await writeFile(snapshot, image.toPNG())
          app.quit()
        })
      }, Number(process.env['APPGUIDE_SNAPSHOT_DELAY'] ?? '15000'))
    })
  }
  const dev = process.env['APPGUIDE_DEV_URL']
  const hash = process.env['APPGUIDE_START']
  if (dev !== undefined) void win.loadURL(dev)
  else void win.loadFile(join(__dirname, 'renderer', 'index.html'), hash === undefined ? {} : { hash })
}

app.setName('App Guide')
// Settings for development only are ignored by the installed app: a page from
// another address, or another git, must never be one an environment variable
// can slip in.
if (app.isPackaged) { delete process.env['APPGUIDE_DEV_URL']; delete process.env['APPGUIDE_GIT'] }
// For automated checks only: a separate place for what the app remembers,
// so a test run never touches the PM's own.
if (process.env['APPGUIDE_USER_DATA'] !== undefined) app.setPath('userData', process.env['APPGUIDE_USER_DATA'])
void app.whenReady().then(async () => {
  await loadState()
  void sweepCaches()
  await gitBinary().catch(() => dialog.showErrorBox('git is missing', 'App Guide needs git to read branches and history. Installing Xcode’s command line tools provides it.'))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])] },
    { role: 'windowMenu' },
  ]))
  createWindow()
  setInterval(() => { void poll() }, 60_000)
  void poll()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
