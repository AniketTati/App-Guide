/**
 * The one contract between the page and everything that reads repositories.
 * The page never sees a path it can pass back, a command, or a raw fact list:
 * it asks by id and gets views, already in the PM's words.
 */

export interface Project {
  id: string
  name: string
  /** Shown, never sent back: every call names a project by id. */
  path: string
}

export interface TaskRef { id: string; title: string; status: string | null }

export interface TaskView extends TaskRef {
  file: string
  line: number
  fields: Record<string, string>
  criteria: string[]
  worklog: { label: string; text: string }[]
  /** The task as written, for tasks kept as a list entry rather than fields. */
  text: string
  /** As the tracker writes it: "Critical (authorization bypass)", "Low". */
  severity: string | null
  /** What follows the status: "needs a decision". */
  statusNote: string | null
  /** The tracker's latest word on it, from its "What's left" section. */
  latest: string | null
}

export type ChangeKind = 'route' | 'data' | 'service' | 'package' | 'code'

export interface ChangeView {
  type: 'added' | 'removed' | 'changed'
  kind: ChangeKind
  /** What is read first: `PATCH /api/v1/contracts/:id`, `api.stripe.com`. */
  title: string
  /** Plain words under it: "now changes contractFieldValue". */
  detail: string
  /** Routes: each check, as the code writes it; 'unresolved' if unreadable. */
  checks?: string[] | 'unresolved'
  /** Routes: the roles whose permissions pass its check, from the role table
   *  as this work leaves it; null when its checks are not ones the table
   *  speaks about. */
  who?: { role: string; scope: string | null }[] | null
  /** Routes: what it reads and changes, where known. */
  data?: { table: string; kind: 'write' | 'read'; via: string | null }[]
  /** The count that says how unusual it is: "no check found · 12 of 297 routes". */
  count?: string
  /** file:line */
  where: string
}

export interface BlindSpot {
  /** One plain sentence per kind of thing the app cannot read. */
  text: string
  /** A few words for the status bar: "82 Python files". */
  short: string
  count: number
  /** Where the first one is. */
  example: string
}

export interface WorkView {
  id: string
  branch: string | null
  where: 'checkout' | 'worktree' | 'branch'
  /** What it is for, in its own words: its plan's title, its first task's,
   *  else the folder or branch. */
  label: string
  /** The folder or branch, as git knows it: field-capture. */
  name: string
  ahead: number
  uncommitted: number
  changed: number
  /** Named by its commits, or — before its first commit — the tracker
   *  entries it added or changed. */
  tasks: TaskRef[]
  plan: { file: string; title: string } | null
  /** Other work in flight that changed some of the same files. */
  sharesWith: { label: string; files: number }[]
  lastCommit: string | null
  /** When the PM last marked it checked, and whether it has moved since. */
  checkedAt: string | null
  movedSinceCheck: boolean
  /** Looks finished — committed, every task done — and not checked since. */
  ready: boolean
  /** No commit for three weeks: kept apart from work in progress. */
  stale: boolean
}

export interface CommitView { sha: string; subject: string; date: string; tasks: string[] }

export interface ProductCounts {
  routes: number
  noCheck: number
  /** Of those, the ones the PM hasn't marked "public on purpose". */
  noCheckUnreviewed: number
  tables: number
  services: number
  packages: number
  files: number
}

export interface HomeView {
  project: Project
  base: string
  waiting: TaskView[]
  work: WorkView[]
  /** Work git could not read, and why. */
  skipped: { name: string; reason: string }[]
  /** Branches whose changes are all on main already (squash-merged). */
  merged: number
  /** When main was last fetched — "main" means main as of then. */
  fetchedAt: string | null
  /** Since the PM last looked at main; null on the first look. */
  main: { commits: CommitView[]; changes: ChangeView[]; sentence: string } | null
  /** Main's history was rewritten since the last look; counting starts again. */
  mainReset: boolean
  product: ProductCounts
  blind: BlindSpot[]
  readAt: string
}

export type MergeView = { state: 'clean' } | { state: 'conflicts'; files: string[] } | { state: 'uncommitted' } | { state: 'unknown' }

export interface CheckView {
  work: WorkView
  base: string
  /** The answer first: what it changes — or why no all-clear can be given. */
  sentence: string
  readAt: string
  /** What was read; a later read with another value means it moved. */
  fingerprint: string
  verdict: {
    /** Acceptance criteria written across its tasks. */
    criteria: number
    mergeMain: MergeView
    mergeOthers: { label: string; files: number; state: MergeView }[]
    pushed: { state: 'local' | 'pushed' | 'ahead' | 'remote' | 'detached'; unpushed: number; upstream: string | null }
  }
  commits: CommitView[]
  tasks: TaskView[]
  unknownTasks: string[]
  /** Screens whose code it changed: their own page, or code they run. */
  screens: { changed: { name: string; path: string; how: 'page' | 'uses'; app: string }[]; added: { name: string; path: string }[]; removed: { name: string; path: string }[] }
  /** What each role may do, before and after, where it differs. */
  roleChanges: { role: string; resource: string; before: string; after: string }[]
  /** Every role in the table, for "all 9 roles" and "all but VIEWER". */
  roles: string[]
  changes: Record<ChangeKind, ChangeView[]>
  /** Routes that were there before whose own code it changed. */
  touched: ChangeView[]
  schema: {
    tables: { added: string[]; removed: string[]; changed: string[] }
    lists: { added: string[]; removed: string[]; changed: string[] }
    migrations: string[]
  }
  /** Changed files the reader can't describe: another language, deploy settings. */
  unseen: { label: string; files: string[] }[]
  /** Calls from the screens to routes that don't exist: new ones, and ones it fixed. */
  unmatched: { added: UnmatchedView[]; fixed: UnmatchedView[] }
  tests: string[]
  outside: string[]
  shared: { file: string; with: string[] }[]
  blind: BlindSpot[]
  /** A self-contained follow-up the PM can paste into Claude. */
  followUp: string
  /** What to paste into Claude when it is ready: push it and open a PR. */
  ship: string
}

export interface UnmatchedView { method: string; path: string; where: string; screen: string | null; via: string | null }

export interface RouteRow {
  method: string
  path: string
  /** Each check as written; 'unresolved' if unreadable. */
  checks: string[] | 'unresolved'
  noCheck: boolean
  /** The PM said this one is meant to be open. */
  publicOk?: boolean
  /** Roles whose permissions pass its check, with their scope; null when its
   *  check is not one the role table speaks about. */
  who: { role: string; scope: string | null }[] | null
  data: { table: string; kind: 'write' | 'read'; via: string | null }[]
  where: string
  /** For a call around every screen or in a shared part: the component it's in. */
  via?: string | null
}

export interface ScreenRow {
  path: string
  /** Where the page component is defined. */
  file: string | null
  /** The sidebar's label, else the page component's name. */
  name: string
  component: string | null
  signIn: 'required' | 'none' | 'unknown'
  app: string
  where: string
  routes: RouteRow[]
}

export interface ProductView {
  base: string
  /** In the sidebar's order, then screens elsewhere, then those with no sign-in. */
  groups: { label: string; note?: string; screens: ScreenRow[] }[]
  /** Routes no screen calls: callbacks, webhooks, API keys, health. */
  behind: RouteRow[]
  /** Calls every signed-in screen makes through its layout. */
  layout: RouteRow[]
  /** Parts three or more screens use — a dialog, an editor — each once, with
   *  the screens it appears on and the routes it calls. */
  shared: { name: string; file: string; screens: string[]; routes: RouteRow[] }[]
  /** Calls that reach no route. */
  unmatched: UnmatchedView[]
  roles: RolesView | null
  /** Routes the PM marked "public on purpose" — theirs, not read from code. */
  publicOk?: string[]
  /** Work away from any screen. */
  background: {
    queues: { name: string; declared: string; jobs: { name: string; addedAt: string[] }[]; workers: string[]; repeats: number }[]
    timers: string[]
    sockets: { where: string; library: string }[]
  }
  readAt: string
}

export interface RolesView {
  /** Every table found, named as the code names it. */
  tables: {
    name: string
    where: string
    roles: string[]
    /** One row per resource; each cell the actions a role has on it, and its scope. */
    rows: { resource: string; cells: Record<string, { actions: string[]; scope: string | null }[]> }[]
  }[]
  /** "action resource" -> the routes that permission opens. */
  routes: Record<string, { method: string; path: string }[]>
}

/** What the PM wrote in "Ask for a change". Sent as JSON text. */
export interface AskInput {
  what: string
  why: string
  criteria: string[]
  /** Screens by path and routes by "METHOD /path", picked from Product. */
  picks: { kind: 'screen' | 'route'; key: string }[]
  /** Their own choice of ID, if they changed the suggestion. */
  id?: string
  /** Critical, High, Medium or Low. */
  severity?: string
  /** The preview they approved: adding refuses if the text would differ. */
  hash?: string
}

export interface DraftView {
  id: string
  suggestedId: string
  /** The tracker it would go into; null if the product has none. */
  file: string | null
  /** The checkout's branch, where the file is. */
  branch: string | null
  /** Exactly what would be added to the tracker, section heading included. */
  text: string
  /** A brief to paste into Claude: it adds the task first, then works it. */
  brief: string
  /** Why it isn't complete yet, or null. */
  problem: string | null
  /** Why the app won't add it to the tracker itself — only Claude should —
   *  or null when it may. */
  cantAdd: string | null
  /** Identifies this exact preview. */
  hash: string
}

/** Every call the page may make. Each takes ids, never paths or commands. */
export interface Api {
  projects(): Promise<Project[]>
  /** Opens the Mac's folder picker. Electron only. */
  addProject(): Promise<Project | null>
  removeProject(projectId: string): Promise<void>
  home(projectId: string): Promise<HomeView>
  /** What the product on main does: screens, routes, data, who may call. */
  product(projectId: string): Promise<ProductView>
  check(projectId: string, workId: string): Promise<CheckView>
  /** Main's current commit becomes "last looked". */
  markSeen(projectId: string): Promise<void>
  markChecked(projectId: string, workId: string): Promise<void>
  /** A route with no check that the PM says is meant to be public ('on'), or
   *  not ('off'): "METHOD /path". */
  markPublic(projectId: string, route: string, on: string): Promise<void>
  copy(text: string): Promise<void>
  /** Draft a task from what the PM wrote. Writes nothing. */
  draftTask(projectId: string, input: string): Promise<DraftView>
  /** Add the drafted task to the tracker — the one write the app makes. */
  addTask(projectId: string, input: string): Promise<{ id: string; file: string; line: number }>
  /** Bring the Claude app forward. */
  openClaude(): Promise<boolean>
}

export type Method = keyof Api
export const METHODS: readonly Method[] = ['projects', 'addProject', 'removeProject', 'home', 'product', 'check', 'markSeen', 'markChecked', 'markPublic', 'copy', 'draftTask', 'addTask', 'openClaude']
