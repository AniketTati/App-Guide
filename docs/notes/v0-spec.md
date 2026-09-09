# v0 spec — the receipt

Rewritten after five critiques (developer, vibe coder, PM, designer, GTM) all
independently reached the same conclusion. Sequencing lives in
[PLAN.md](../PLAN.md); this is the product.

**One sentence:** when your coding agent finishes, this prints a few lines
saying what it structurally changed — new routes, new dependencies, new outbound
calls, new database writes — and what it could not see.

**It is a receipt, not an atlas.** You get one every time, most are boring, and
the entire value is that the one time it isn't, you notice.

---

## 1. The moment

The question in the user's head when an agent stops is not *"what is in my
codebase."* It is **"do I need to actually read this?"** That is a binary trust
decision with a three-second budget.

So the output **arrives on its own** — a `Stop` hook, installed once — appears
in the terminal the developer is already looking at, and is short by contract.

```bash
npx appguide init-hook     # one time
```

Terminal scrollback is also a free passive notification: come back from lunch and
it is sitting there, timestamped.

## 2. Length is the severity channel

Ninety percent of the value is in the sessions where you are told you *don't*
need to look. That turns this from a fear product — which gets muted — into a
time-saving one, which gets kept.

- **Always print at least one line.** Silence is ambiguous: did it run, or find
  nothing?
- **Never more than ~22 lines** by default. Overflow behind `--all`.
- **Cap the exception block at 3.** A "top" block of nine is not a top block.

After twenty three-line receipts, a twenty-line one triggers a reaction before
the eye reads a word.

## 3. The six signals

Each is a *changed fact*, not a state.

1. **Routes** added / removed / changed — and whether the new one has middleware.
   *"New route, no middleware"* is the most valuable line this will ever print.
2. **Dependencies** added / removed, direct and transitive.
3. **Outbound calls** — new external hosts or SDKs reached.
4. **Data writes** — first-ever write to a table from a module that never wrote
   to it.
5. **Exported surface** added / removed.
6. **What it could not see** — promoted, not demoted. A delta with silent blind
   spots is more dangerous than a picture with them, because *"nothing changed"*
   is an exhaustive claim.

## 4. Ranking — three deterministic axes

1. **Boundary before interior.** Things that change the edge of the system
   outrank things that rearrange the inside.
2. **Rare before common.** Within a tier, what is unusual *in this codebase*.
3. **Reach before leaf.** How many routes reach it. A graph count.

Ties break by kind: Route > External > Table > Library > Module edge > Symbol.
Zero opinions. Every input is countable.

## 5. Severity is arithmetic, never adjective

The tool never says a change is dangerous. It says the change is **the only one
of its kind here**, and lets the shape of the codebase supply the alarm.

`no middleware · 1 of 48 routes` is not a judgment. It is a ratio the reader can
verify and the tool cannot get wrong.

- **No line is promoted to the top block without a corroborating denominator.**
  Mechanically enforceable, and a guarantee against false alarms.
- **Never print red.** Red means broken; this never claims that. An absolute rule
  means it structurally cannot cry wolf.
- **Firstness self-extinguishes.** The second time `billing/` writes to `users`,
  it is not first any more and drops out by itself. No suppression list, no
  rules file, no ArchUnit trap.

Stated limit, in the README rather than discovered: the top block is about what
is **new to the shape of the system**. If the bad change is the second of its
kind, this will not rank it. Anything more is a rules engine.

## 6. The output

### Alarming session

```
────────────────────────────────────────────────────────────────────────────
 appguide · session 14:02–15:47 · 31 files

 Your agent added 3 routes, one with no middleware, made billing/ write to
 users for the first time, and pulled in node-fetch.

 NEW TO THIS CODEBASE
   route   POST /api/admin/reset-usage      no middleware · 1 of 48 routes
           src/api/admin.ts:14              every other route has ≥1

   write   billing/usage.ts → users         first write to users from outside
           :112 updateSeatCount()           auth/ · 3 other files write it

   dep     node-fetch 2.6.7                 first new direct dep in 41 days
           src/lib/webhook.ts:8             undici already present

 ALSO CHANGED
   route   GET  /api/usage                  requireAuth, billingGuard
   table   usage_events                     new · written by billing/ only
   symbol  14 across 9 files                no module boundary crossed

 NOT COVERED
   src/handlers/registry.ts didn't parse · 1 route path is built at runtime
   → a change inside either would not appear above

 appguide since --all (23) · --mark
────────────────────────────────────────────────────────────────────────────
```

### All-clear

```
 appguide · session 09:12–09:40 · 6 files · nothing new to the shape
   4 symbols in 3 files · 0 routes · 0 deps · no boundary crossed
   everything it touched was readable                appguide since --all
```

### Typography

- **One prose sentence at the top, and only there.** It reads three times faster
  than a table for the "do I care" question.
- **Fixed three-column grid**: kind (7ch, dim) · subject (32ch, full) ·
  corroborating count (dim). **Never wrap — truncate.** The grid *is* the
  hierarchy.
- **Every exception gets an indented dim second line** with `file:line` and the
  evidence. This is the show-your-work line that converts "a tool told me" into
  "I can check that."
- **Dim the routine rather than highlighting the exceptional.** Subtraction beats
  addition in a terminal.

## 7. Coverage — scoped, never a percentage

A global `87%` reads as a grade on the user's own code, collides with test
coverage, has no correct value, and only drifts downward.

- **No global number, ever.**
- **Scoped to the session.** If 412 call sites resolve dynamically but none are
  in the 31 files this session touched, they are not part of this moment.
  Usually this section is two items or zero.
- **Phrased as a property of the code, neutrally.** `1 route path is built at
  runtime` is a fact. "AppGuide could not resolve" is an apology; "uses an
  unanalyzable pattern" is an accusation.
- **State the cost, not the count** — the `→ a change inside either would not
  appear above` line is what makes everything above it believable.
- **Include the negative dimension**, driven off `package.json`: *"you depend on
  `@trpc/server` and `hono`; I have no extractor for either, so the route list is
  structurally incomplete, not empty."* Without this, coverage can report 94%
  while missing 100% of the routes — the exact silent failure this exists to
  prevent.

## 8. Framework order — by how badly the existing habit fails

Not by age. `grep -rn "router\.\(get\|post\)"` already gets 80% of Express in
three seconds; nothing works for tRPC.

1. **Next.js server actions** — no URL to grep for, and the archetypal "the agent
   added an entry point nobody asked for" case.
2. **tRPC** — procedures are object nesting; grep fails completely.
3. **NestJS** — decorator + prefix composition; grep gives fragments.
4. **Express** — grep mostly works already.

ORM order likewise: **Drizzle before Prisma** (`create-t3-app` now scaffolds
Drizzle by default).

**Route extraction is a documented plugin interface from day one.** If someone
hits an empty panel on their stack and cannot add forty lines to fix it, they
close the tab.

## 9. Surfaces

```
npx appguide init-hook     install the Stop hook (once)
npx appguide since         what changed since the mark
npx appguide since --all   everything, not just the top
npx appguide --mark        advance the mark
npx appguide --json        the raw delta, versioned schema
npx appguide --markdown    for a PR comment or Slack
```

- **The mark is "the last time you looked,"** not "the last session." Three
  sessions over lunch must all be covered, or being away silently loses
  information.
- **`--json` ships day one with a versioned schema.** The deterministic primitive
  an agent can call is the durable half; the human rendering is the disposable
  half.
- **A GitHub Action ships with v0.** The CLI is where people try it; CI is where
  a team adopts it and where a budget line appears. It also forces markdown
  output, which is what makes findings shareable.
- **An append-only session ledger is written from commit one** — one record per
  agent session, attributed to the *session*, never to a developer — even though
  nothing reads it yet. It is the only architectural decision here that is
  unrecoverable later.

## 10. Deliberately not in v0

- **No `map.html`, no module graph, no data matrix, no flows.** Code
  visualization has never supported a standalone product; flows cannot be
  honestly claimed above L1 ([flow-levels.md](flow-levels.md)); the matrix is
  3,000 cells and 95% empty.
- **No MCP server yet.** It is the most-competed thing in the space. `--json`
  first; the server when someone asks.
- **No rules, no config file, no authoring.**
- **No account, no telemetry, no network.**
- **Not for the non-technical vibe coder.** They are unreachable by a solo OSS
  tool and will get this free from the platform they already pay.

## 11. Success looks like

A developer comes back from a meeting, glances at three lines under their agent's
own summary, and knows whether to read the diff. Twenty times in a row it says
*nothing new to the shape*. The twenty-first time it doesn't, and they catch
something they would have shipped.
