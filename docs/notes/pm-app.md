# The PM app — plan

What we are building for a product manager who maintains an agent-built product
and never opens a terminal: what they see, how work reaches the agent, how it is
built, in what order, and when to stop. Status lives in [../PLAN.md](../PLAN.md)
§1; reasoning in [../decisions.md](../decisions.md) §19.

**Revised after five critiques** — developer, the PM themselves, product,
design, go-to-market. What changed and why: decisions #102–#108. **Built, then
critiqued again** by the PM, a designer and a code review, and fixed: §9 and
decisions #116–#126.

## 1. Who, and what they already do

**The person.** The PM who maintains **draft-legal**, an open-source contract
management product built almost entirely by Claude Code. They do not use a
terminal. Their loop today:

- **Tasks live in `FIX_TRACKER.md`** (and numbered plan documents): an ID
  (`S2`, `DD1`, `EE1`), a status (`TODO`, `IN-PROGRESS`, `DONE`,
  `VERIFY-PENDING`, `NOT-REPRODUCIBLE`, `BLOCKED`), acceptance criteria, and a
  worklog Claude fills in. The tracker also carries the agent's ground rules and
  the five-step cycle every task follows.
- **Claude works in the Claude app, in worktrees** under `.claude/worktrees/`,
  one commit per task, each commit ending with its task IDs — `(DD5-DD7)`.
- **The PM checks, then merges a wave** as one pull request (#52: 179 commits).

**Their questions, in their order:** *What's waiting on me? What's in flight,
and will it collide? Did this branch do what the task said — and what else did
it do? Who can do what now? Is that feature real or theatre?* The map of the
product is context for those questions, not the destination.

**The product, measured 2026-09-26:** a React web app (its routes declared in
`App.tsx`, its sidebar in `Sidebar.tsx`), a Fastify API (297 routes; 252 under
`/api/v1`, every one matched with the permission it needs — #101), a Python
FastAPI agents service, Prisma (43 models), six background queues, a
WebSocket server, and a role table. Only measured numbers appear in the app:
a count that disagrees with the PM's own docs ("4 agents" where the README
says 8) ends trust on the first screen.

## 2. Principles

1. **Local only.** Code never leaves the machine. No account, no telemetry.
2. **Never guess.** Every item and every line between items comes from the
   code, with where and how it was established. What can't be followed is
   drawn as *can't follow*. Blind spots are always on screen.
3. **Their words.** Their task IDs, their statuses, their sidebar sections,
   their role names, their counts. Endpoints are shown as `PATCH
   /contracts/:id` — they search by it. None of our jargon: no *receipt*,
   *mark*, *fact*.
4. **Counts, not adjectives.** Never red — and no green either: grayscale
   plus one accent for "needs you".
5. **"No check found", never "anyone".** A hook counts as a check only if it
   can refuse a request (a 401/403 or a throw in its code); a check written
   inside a handler is named with its line; guards installed through `onRoute`
   count. An empty list is an absence we measured, not a claim about who can
   reach the route.
6. **No terminal, ever.** And no surprise edits: the app never changes a
   tracked file without showing the change and asking.
7. **Around their tools, not instead of them.** The tracker stays the list of
   work, the Claude app stays where Claude works, git stays the record.

## 3. What they see

Four places, plus three things always on screen: search (⌘K), *Ask for a
change* (⌘N), and a status bar saying what the app can't read.

**Home — what needs you.**
- *Waiting on you*: tracker tasks marked `VERIFY-PENDING` or `BLOCKED`, with
  the check they need; branches with work not yet checked.
- *In flight*: every worktree and branch ahead of main — its tasks (from the
  IDs in its commits), commits, changed files, uncommitted work, and the files
  it shares with another worktree.
- *Changed on main since you last looked*, grouped by task ID.
- One line of counts they can check against their own product.

**Check — one branch or worktree against main.** The screen they open before
merging. In this order: one sentence from the app's own diff · the tasks in
it, each with its acceptance criteria and what the worklog says was verified
and left out · what changed structurally (routes and who may call them before
and after, screens, data, services, packages) · what it touched outside the
files its tasks name · tests added · files it shares with other work in flight
· the task's manual check, with a button that opens that screen in the running
app · what Claude says, last and labelled as Claude's. *Mark checked* records
it; it never touches git.

**Product — what the product does.** An outline in their sidebar's own
sections, plus *No sign-in* and *Behind the scenes* (queues, inbound email,
webhooks, agent callbacks). Selecting a row draws its trace: screens → routes
(with who may call them) → data, AI and services. Solid line: same code.
Dashed: through a shared component. Hatched stub: can't follow. Also listed:
routes no screen calls, and screen calls that match no route.

**Who can do what.** Their nine roles against what each permission unlocks,
with the routes behind every cell. Footnote: these are the defaults; each
customer's admin can change them.

**History** — past checks and what each merged wave changed.

## 4. How a change reaches Claude

1. *Ask for a change* (⌘N): what should happen, and *where* — picked from
   Product.
2. The app drafts a task in the tracker's own format — an ID in the next free
   family, title, why it matters, acceptance criteria, the picked items with
   files and lines as evidence — and shows it.
3. *Add to FIX_TRACKER* writes it into the tracker in their checkout after
   showing the exact change. *Copy for Claude* copies a brief: "Work task X by
   the cycle and ground rules in FIX_TRACKER.md", plus the context. *Open
   Claude* switches to the Claude app.
4. When the branch appears, it is on Home and gets its Check.

The app does **not** run Claude itself in v1: the Claude app already gives
every session its own worktree, and Anthropic's terms for scripted use changed
three times this year (decision #105).

## 5. How it is built

### 5.1 Reading the product

Done and measured: Fastify routes and permissions, 252 of 252 (#101); honest
blind spots in workspaces and other languages (#100). Next, each measured:
- **What counts as a check** (principle 5): refusal in the hook's own code,
  followed to its definition; in-handler checks with their line; `onRoute`
  guards; the identity the agents service uses when it calls the API.
- **Today's silent misses**: writes through `tx.*` inside `$transaction` (53
  in draft-legal) and raw SQL (18) — the first read, the second declared.
- **The fact model, v3**: a route's identity includes the part of the
  workspace it lives in (the API's and the agents service's `GET /health` are
  different routes); existing notes migrate once.
- **Screens** from React Router (`App.tsx`, nested and layout routes) grouped by
  the sidebar's sections; which ones need sign-in from the layout they sit in.
- **Screen → route links**: the axios instance's `baseURL`, `fetch`, template
  paths normalised to `:param`, through the components a screen imports —
  stopping at the HTTP client and at modules three or more screens share, or
  every page appears to call `/auth/*`. Calls made by the layout are shown as
  *every signed-in screen*. Each link is *direct* or *via ComponentName*;
  calls that match no route are findings. Gate: precision and recall ≥ 90%
  on 40 hand-checked links (270 of 305 call sites already match exactly one
  route).
- **Route → data**: Prisma calls inside the handler (and `$transaction`
  callbacks), one hop into imported functions; the models themselves from
  `schema.prisma`.
- **Behind the scenes**: BullMQ queues and workers, cron jobs, the WebSocket
  server, inbound webhooks.
- **Roles**: `DEFAULT_ROLE_PERMISSIONS` (their permission table) read
  statically.
- **Python agents service** (FastAPI via tree-sitter, so no Python needed on the
  PM's Mac) — after the loop above works; declared unread until then. Its
  checks live in an HTTP middleware, not in `Depends`, so reading routes
  alone would call all 26 open.

### 5.2 Git and the tracker

- Worktrees from `git worktree list`; the base branch from `origin/HEAD`.
- A branch is compared at its merge-base with main. Main's facts are read from
  `git archive` of that commit into a temporary folder and cached by commit.
  A worktree is read as it is on disk, uncommitted work included.
- Tasks from the tracker in both of its formats (heading with a `Status:` line;
  bold list entry ending in a status), and task IDs from commit subjects,
  ranges expanded (`DD5-DD7`).
- Reads never write. The app's own notes go in the repo's `.appguide/`, kept
  out of git by `.git/info/exclude` — never by editing their `.gitignore`.

### 5.3 The app

- **Electron.** The reader is TypeScript. A full read of draft-legal is ~3s
  and ~200 MB of syntax trees, so it runs in a utility process, never the
  window's; per-file results are cached by git blob SHA, so worktrees share
  them and only changed files are parsed again. A Dock icon, a real window, a
  native folder picker, notifications.
- **Renderer**: React + TypeScript + Vite. Plain SVG for the trace — no graph
  library. System font 13/18, monospace only for code names, fixed-width
  digits, grayscale plus one accent, hatching for *can't follow*.
- **One API, two transports**: Electron IPC through a preload bridge, and —
  for development only — a read-only local server, so every screen can be run
  and checked in a browser. Nothing on it can change anything.
- **Safety**: context isolation, no Node in the page, a strict content policy,
  an allow-list of calls that take ids, never paths or commands; env and
  secret files are never opened.
- **A Mac app's world**: launched from the Dock it has no shell PATH, so git
  and the Claude app are found by known locations; the repo sits under
  `~/Documents`, so macOS asks once for folder access.
- Lives in `desktop/` with its own package and lockfile, so installing the CLI
  never downloads Electron.

### 5.4 The receipt stays

The Claude Code hook remains the doorbell; the app is where it leads. One
reader, one set of notes, one "last looked" for both. The app offers to
install the hook into the project's *local* Claude settings
(`.claude/settings.local.json`), which are not committed.

### 5.5 Packaging

`App Guide.app`, built on and for this Mac, in `~/Applications`. Anyone else
needs a Developer ID and notarisation — when a second PM asks (#107).

## 6. Milestones and gates

| | Ships | Gate |
|---|---|---|
| M0 | This plan; decisions #102–#107; PLAN §1–§2 | done when committed |
| M1 | Read what Home and Check need: checks as in principle 5, `tx.*` writes, fact model v3, worktrees, merge-base diffs, tracker tasks, commit task IDs | every "no check found" route hand-verified; a Check for each worktree in flight matching `git diff` by hand; tracker counts match the file |
| M2 | The app: Home and Check, status bar, notifications; built into `~/Applications` | opened from the Dock with no terminal; the next real branch checked in it before merge |
| M3 | Product and Who can do what: screens, links, route → data, queues, roles | the PM's own five questions answered from the app, faster than asking Claude; link gate above |
| M4 | Ask for a change: tracker draft, Copy for Claude, Open Claude | a real task added and built through it |
| Use | four weeks from M2 | the PM opens it unprompted in ≥3 of 4 weeks; ≥80% of merged branches opened in it first; ≥1 finding becomes a task. Otherwise shrink back to the receipt |

**Latency**: a full read of draft-legal off the window's thread; a re-read
after a commit under ~2 seconds from the blob cache. **Quiet**:
Home says "nothing needs you" on most days, in one line.

## 7. Risks

- **The map lies.** A wrong link is worse than none. Runtime oracles where the
  product has them (#101), hand-checked samples elsewhere, provenance on every
  line.
- **Another app to remember** (#53). The hook and notifications bring the PM to
  it; Home must be worth one glance a day.
- **It's for one PM.** Named user, kill criteria above; the owner's choice, not
  evidence of demand (#102).
- **Displacement.** Claude already answers "what does X do" in chat. The app's
  edge is exhaustive, checkable answers and the before/after of a branch.

## 8. Not now

Running Claude from the app, hosted or team versions, Windows and Linux,
notarised distribution, a node-graph map, a permissions matrix labelled with
permission names, editable rule sets, live file watching (re-read when a session
stops or a branch moves), and publishing any finding about draft-legal's
security.

## 9. After the first build

Three critiques of the running app, against draft-legal. What they changed:

- **Facts before looks.** The tracker is read in all its shapes, with the
  "What's left" line as each open task's latest word; a Check lists what it
  can't read and gives no all-clear while any is there; roles come from the
  branch's own table; a 404 after a lookup handed the caller is a check.
- **A Check is a decision screen.** A one-sentence answer, then a verdict —
  criteria written, merges cleanly, pushed, tests — then what people will
  notice, then the product changes, then Claude's own words, folded away.
  Actions stay in reach: mark checked, ready (push and open a PR), send back
  with notes.
- **Reads never get in Claude's way**: no git locks, time limits, merges
  worked out without touching the repository's objects.
- **Ask writes only what was shown, only on a clean main**; otherwise Claude
  adds the task first, from the brief.
- **Design**: one accent for "needs you"; one route line everywhere; the
  answer as each page's headline; "public on purpose" marks; view as a role.

Still open, not built: a Claude session's own title beside its worktree;
pull-request and CI state (needs the network and the PM's GitHub sign-in);
the receipt hook offered from inside the app; reading the Python agents
service.
