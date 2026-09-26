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
  where: 'checkout' | 'worktree'
  /** The folder name, e.g. field-capture. */
  label: string
  ahead: number
  uncommitted: number
  changed: number
  tasks: TaskRef[]
  /** Other work in flight that changed some of the same files. */
  sharesWith: { label: string; files: number }[]
  lastCommit: string | null
  /** When the PM last marked it checked, and whether it has moved since. */
  checkedAt: string | null
  movedSinceCheck: boolean
}

export interface CommitView { sha: string; subject: string; date: string; tasks: string[] }

export interface ProductCounts {
  routes: number
  noCheck: number
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
  /** Since the PM last looked at main; null on the first look. */
  main: { commits: CommitView[]; changes: ChangeView[]; sentence: string } | null
  product: ProductCounts
  blind: BlindSpot[]
  readAt: string
}

export interface CheckView {
  work: WorkView
  base: string
  sentence: string
  commits: CommitView[]
  tasks: TaskView[]
  unknownTasks: string[]
  changes: Record<ChangeKind, ChangeView[]>
  tests: string[]
  outside: string[]
  shared: { file: string; with: string[] }[]
  blind: BlindSpot[]
  /** A self-contained follow-up the PM can paste into Claude. */
  followUp: string
}

export interface RouteRow {
  method: string
  path: string
  /** Each check as written; 'unresolved' if unreadable. */
  checks: string[] | 'unresolved'
  noCheck: boolean
  /** Roles whose permissions pass its check, with their scope; null when its
   *  check is not one the role table speaks about. */
  who: { role: string; scope: string | null }[] | null
  data: { table: string; kind: 'write' | 'read'; via: string | null }[]
  where: string
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
  /** Calls that reach no route. */
  unmatched: { method: string; path: string; where: string; screen: string | null }[]
  roles: RolesView | null
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
}

export interface DraftView {
  id: string
  suggestedId: string
  /** The tracker it would go into; null if the product has none. */
  file: string | null
  /** The checkout's branch, where the file is. */
  branch: string | null
  /** Exactly what would be added to the tracker. */
  text: string
  /** A brief to paste into Claude. */
  brief: string
  /** Why it can't be added yet, or null. */
  problem: string | null
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
  copy(text: string): Promise<void>
  /** Draft a task from what the PM wrote. Writes nothing. */
  draftTask(projectId: string, input: string): Promise<DraftView>
  /** Add the drafted task to the tracker — the one write the app makes. */
  addTask(projectId: string, input: string): Promise<{ id: string; file: string; line: number }>
  /** Bring the Claude app forward. */
  openClaude(): Promise<boolean>
}

export type Method = keyof Api
export const METHODS: readonly Method[] = ['projects', 'addProject', 'removeProject', 'home', 'product', 'check', 'markSeen', 'markChecked', 'copy', 'draftTask', 'addTask', 'openClaude']
