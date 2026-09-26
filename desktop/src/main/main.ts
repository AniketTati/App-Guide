import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { gitBinary, git } from '../../../src/git/repo.js'
import { METHODS, type Api, type CheckView, type HomeView, type Method, type ProductView, type Project } from '../shared/api.js'
import type { HomeResult, ProjectState } from '../core/service.js'

/**
 * The app's own process: its window, what it remembers, and the queue of
 * reads it hands to the utility process. It never reads a repository itself.
 */

interface State { projects: Project[]; projectState: Record<string, ProjectState> }
let state: State = { projects: [], projectState: {} }
const statePath = (): string => join(app.getPath('userData'), 'state.json')

async function loadState(): Promise<void> {
  try {
    const loaded = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<State>
    state = { projects: loaded.projects ?? [], projectState: loaded.projectState ?? {} }
  } catch {
    // first run, or an unreadable file: start empty rather than guess
  }
}
async function saveState(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${statePath()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, statePath())
}

const find = (id: string): Project => {
  const p = state.projects.find((x) => x.id === id)
  if (p === undefined) throw new Error('no such product')
  return p
}
const stateOf = (id: string): ProjectState => (state.projectState[id] ??= { checked: {} })
// Not "cache": Chromium keeps its own "Cache" in the same folder, and a Mac's
// file names ignore case, so the two would be one folder it may empty.
const cacheDir = (id: string): string => join(app.getPath('userData'), 'facts', id)

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

let queue: Promise<unknown> = Promise.resolve()
function ask<T>(req: Record<string, unknown>): Promise<T> {
  const run = (): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
    reader().postMessage({ id, ...req })
  })
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}

// ── What the page may ask for ─────────────────────────────────────────────────
const lastHome = new Map<string, HomeResult>()
const lastCheck = new Map<string, { head: string; dirty: number }>()

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
    // here on, Home shows what changes on main.
    if (ps.seenMain === undefined) { ps.seenMain = result.baseHead; await saveState() }
    return result.view
  },

  async product(id): Promise<ProductView> {
    return ask<ProductView>({ method: 'product', project: find(id), cacheDir: cacheDir(id) })
  },

  async check(id, workId): Promise<CheckView> {
    const project = find(id)
    const r = await ask<{ view: CheckView; head: string; dirty: number }>({ method: 'check', project, workId, state: stateOf(id), cacheDir: cacheDir(id) })
    lastCheck.set(`${id}\u0000${workId}`, { head: r.head, dirty: r.dirty })
    return r.view
  },

  async markSeen(id) {
    const h = lastHome.get(id)
    if (h === undefined) return
    stateOf(id).seenMain = h.baseHead
    await saveState()
  },

  async markChecked(id, workId) {
    const seen = lastCheck.get(`${id}\u0000${workId}`) ?? lastHome.get(id)?.work.find((w) => w.id === workId)
    if (seen === undefined) return
    stateOf(id).checked[workId] = { at: new Date().toISOString(), head: seen.head, dirty: seen.dirty }
    await saveState()
  },

  async copy(text) {
    if (text.length <= 200_000) clipboard.writeText(text)
  },
}

/** Only our own page may call, only listed methods, and only with strings —
 *  ids and text, never objects that could carry a path or a command. */
function allowed(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const dev = process.env['APPGUIDE_DEV_URL']
  return url.startsWith('file://') || (dev !== undefined && url.startsWith(dev))
}

ipcMain.handle('api', async (event, method: unknown, args: unknown) => {
  if (!allowed(event)) throw new Error('not allowed')
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) throw new Error('unknown call')
  if (!Array.isArray(args) || args.length > 3 || args.some((a) => typeof a !== 'string')) throw new Error('calls take ids')
  return (handlers[method as Method] as (...a: string[]) => Promise<unknown>)(...(args as string[]))
})

// ── Noticing new work between looks ──────────────────────────────────────────
const lastPoll = new Map<string, { baseHead: string; work: Map<string, { head: string; ahead: number; branch: string | null }> }>()

async function poll(): Promise<void> {
  for (const project of state.projects) {
    let r: { baseHead: string; work: { id: string; branch: string | null; head: string; ahead: number }[] }
    try { r = await ask({ method: 'poll', project }) } catch { continue }
    const before = lastPoll.get(project.id)
    const now = new Map(r.work.map((w) => [w.id, { head: w.head, ahead: w.ahead, branch: w.branch }]))
    lastPoll.set(project.id, { baseHead: r.baseHead, work: now })
    if (before === undefined) continue // the first poll is the baseline
    const news: string[] = []
    for (const [id, w] of now) {
      const was = before.work.get(id)
      const name = w.branch ?? basename(id)
      if (was === undefined) news.push(`New work in flight: ${name}`)
      else if (w.head !== was.head && w.ahead > was.ahead) news.push(`${name}: ${w.ahead - was.ahead} new commit${w.ahead - was.ahead === 1 ? '' : 's'}`)
    }
    if (r.baseHead !== before.baseHead) news.push('Main moved — see what changed')
    if (news.length > 0) {
      const n = new Notification({ title: project.name, body: news.slice(0, 3).join('\n') })
      n.on('click', () => { const win = BrowserWindow.getAllWindows()[0]; win?.show(); win?.focus() })
      n.show()
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('changed', project.id)
    }
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
  if (dev !== undefined) void win.loadURL(dev)
  else void win.loadFile(join(__dirname, 'renderer', 'index.html'))
}

app.setName('App Guide')
// For automated checks only: a separate place for what the app remembers,
// so a test run never touches the PM's own.
if (process.env['APPGUIDE_USER_DATA'] !== undefined) app.setPath('userData', process.env['APPGUIDE_USER_DATA'])
void app.whenReady().then(async () => {
  await loadState()
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
