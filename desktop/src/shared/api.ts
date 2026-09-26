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

/** Every call the page may make. Each takes ids, never paths or commands. */
export interface Api {
  projects(): Promise<Project[]>
  /** Opens the Mac's folder picker. Electron only. */
  addProject(): Promise<Project | null>
  removeProject(projectId: string): Promise<void>
  home(projectId: string): Promise<HomeView>
  check(projectId: string, workId: string): Promise<CheckView>
  /** Main's current commit becomes "last looked". */
  markSeen(projectId: string): Promise<void>
  markChecked(projectId: string, workId: string): Promise<void>
  copy(text: string): Promise<void>
}

export type Method = keyof Api
export const METHODS: readonly Method[] = ['projects', 'addProject', 'removeProject', 'home', 'check', 'markSeen', 'markChecked', 'copy']
