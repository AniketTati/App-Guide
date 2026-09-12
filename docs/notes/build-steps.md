# Build steps

> **Status: steps 1–20 implemented, installable from GitHub.** G1 was measured
> against a runtime oracle and fails as written — 83.2% recall — with 100%
> precision and zero silent misses ([decisions.md](../decisions.md) §17). The
> 4-day evidence test in [PLAN.md](../PLAN.md) is still unrun, and is still the
> cheapest way to be wrong.

Numbered implementation steps for v0, each with a definition of done. Status
lives in [PLAN.md](../PLAN.md); the product surface in [v0-spec.md](v0-spec.md).

**Sequencing principle:** get one signal end-to-end before adding more, and
install the hook early so the tool runs on itself while being built.

---

## Stack

Decided here so it stops being a question.

| | Choice | Why |
|---|---|---|
| Language | TypeScript, Node ≥20 | it indexes TS, so it indexes itself |
| Extractor | `ts-morph` | the only heavy dependency |
| Package manager | `pnpm` | workspaces later, fast |
| Bundler | `tsup` | single-file CLI output |
| Tests | `vitest` | fast, no config |
| Arg parsing | `node:util` `parseArgs` | **zero deps** |
| Colour | raw ANSI, honour `NO_COLOR` | **zero deps** |

**Runtime dependency budget: `ts-morph` and nothing else.** A tool that runs
after every agent session cannot carry a dependency tree.

## Layout

```
src/
  cli.ts                  parseArgs, dispatch, exit codes
  model/
    facts.ts              the Fact union — the core type
    ids.ts                stable fact identity
    snapshot.ts           read/write the ledger
  extract/
    project.ts            tsconfig discovery, TS version resolution
    libraries.ts          package.json + import graph
    imports.ts            import graph, internal vs external
    routes/               index.ts + one file per framework
    data/                 index.ts + one file per ORM
    external.ts           outbound hosts and SDKs
    coverage.ts           gaps, including unsupported-framework detection
  diff/
    compare.ts            two snapshots → added / removed / changed
    rarity.ts             denominators ("1 of 48 routes")
    rank.ts               boundary > interior, rare > common, reach > leaf
  render/
    terminal.ts           the receipt
    markdown.ts           PR comment / Slack
    json.ts               versioned schema
  hook/
    install.ts            write the Stop hook
```

## The core type

Everything the tool knows is a **Fact**. A snapshot is a sorted list of facts; a
diff is a set operation on their ids. This is the whole reason cutting the stored
model made v0 tractable — there are no anchors to keep alive, only facts to
compare.

```ts
type Fact =
  | { kind: 'route';    method: string; path: string; middleware: string[] | 'unresolved'; framework: string }
  | { kind: 'library';  name: string; version: string; direct: boolean; importers: string[] }
  | { kind: 'external'; host: string; via: string }
  | { kind: 'write';    table: string; module: string }
  | { kind: 'read';     table: string; module: string }
  | { kind: 'export';   symbol: string; module: string }
  | { kind: 'gap';      reason: GapReason; subject: string; detail: string }

type GapReason =
  | 'parse-error' | 'unresolved-import' | 'dynamic-dispatch'
  | 'computed-route-path' | 'raw-sql' | 'unsupported-framework'
```

Every fact also carries `file`, `line`, and an `id` derived only from its
identity fields — never from position, or every reformat becomes a diff.

---

# Phase 1 — walking skeleton

One signal, end to end. Proves the pipeline before any framework detection.

### 1. Scaffold
`pnpm init`, TypeScript strict, `tsup`, `vitest`, `bin` entry, `.gitignore`
additions for `.appguide/`. Claim `appguide` on npm with a placeholder.
**Done when:** `pnpm build && node dist/cli.js --version` prints a version.

### 2. Fact model and identity
`model/facts.ts`, `model/ids.ts`. Id derivation per kind, order-independent and
position-independent.
**Done when:** unit tests prove the same fact reordered, reformatted, or moved
between lines yields the same id; different facts never collide.

### 3. Snapshot store
`model/snapshot.ts`. Sorted, one record per line, flat text — the `go.sum` shape,
chosen so a human can read a diff of it. Written to `.appguide/` (gitignored).
Carries a schema version and the extractor version.
**Done when:** round-trips a fact list losslessly; a re-run with no code changes
produces a byte-identical file.

### 4. Library extractor
`extract/libraries.ts`. Read `package.json`, walk imports, mark direct vs
transitive, record importers, flag unused.
**Done when:** on this repo it finds `ts-morph`, marks it direct, lists real
importers, and reports no false unused.

### 5. Diff and rank — first version
`diff/compare.ts`, `diff/rank.ts`. Added / removed / changed on ids. Ranking with
one axis (boundary before interior) until rarity exists.
**Done when:** adding a dependency and re-running reports exactly one added fact.

### 6. Terminal renderer — **we design this together**
`render/terminal.ts`. Three-column grid, dim the routine, never wrap, never red,
the all-clear line. This is the product's only real UX surface and it is a design
decision, not an implementation detail — see [v0-spec.md](v0-spec.md) §6.
**Done when:** the three states (alarming / routine / all-clear) render correctly
at 80 and 120 columns, and under `NO_COLOR`.

### 7. CLI
`cli.ts`. `appguide` (snapshot + report), `appguide since`, `--all`, `--mark`,
`--json`, `--no-color`. Exit 0 always; `--strict` deferred.
**Done when:** `npx appguide since` on this repo prints a real receipt about our
own dependencies.

> **Milestone:** end-to-end pipeline proven on one signal.

---

# Phase 2 — make it self-triggering

Deliberately before more signals, so the tool runs on itself for the rest of the
build. This is what makes G3 (dogfooding) measurable in week two instead of
month three.

### 8. Stop hook
`hook/install.ts`. `appguide init-hook` writes the Claude Code `Stop` hook entry;
idempotent; `--uninstall` removes it.
**Done when:** finishing an agent session in this repo prints a receipt without
anyone asking.

### 9. The mark
`--mark` advances; **the mark is "the last time you looked," not "the last
session"** — three sessions over lunch must all be covered. Auto-advance only
when output was shown in an interactive terminal.
**Done when:** two sessions with no `--mark` between them report the union.

---

# Phase 3 — routes, the highest-value signal

### 10. Project loading
`extract/project.ts`. tsconfig discovery, project references, path aliases,
workspaces. **Resolve the user's `typescript` from their `node_modules`**, fall
back to bundled with a warning.
**Done when:** loads this repo, a pnpm workspace, and a Next.js app; records
`parse-error` gaps rather than throwing.

### 11. Route extractor interface
`extract/routes/index.ts`. A documented plugin shape from day one — if someone
hits an empty list on their stack and cannot add forty lines, they close the tab.
**Done when:** a stub framework can be registered and appears in coverage.

### 12. Express, then Next App Router, then server actions, then tRPC
One file each, in that order — Express first because it validates the interface
cheaply, then in descending order of *how badly grep already fails*.
**Done when:** ≥90% recall against 50 hand-labelled routes per framework (**G1**).

### 13. Middleware, three states
`has` / `none` / `unresolved`. **Never blank** — blank reads as "no middleware,"
which is a lie.
**Done when:** an Express app with `app.use('/api', auth)` prefix mounting
resolves the chain in order, and a dynamically composed router reports
`unresolved`.

### 14. Rarity and denominators — **we design the wording together**
`diff/rarity.ts`. Compute `1 of 48 routes`. Enforce the rule: **no fact is
promoted to the top block without a denominator.**
**Done when:** a new unauthenticated route ranks first with a correct count, and
a fact with no available denominator cannot reach the top block.

---

# Phase 4 — the remaining signals

### 15. Outbound calls
`extract/external.ts`. Hosts from string literals and known SDK imports.
**Done when:** a `fetch('https://api.stripe.com/...')` and an `import Stripe`
both produce one external fact, deduplicated.

### 16. Data writes — Drizzle first, then Prisma
`extract/data/`. **One hop of repository-wrapper resolution** — without it the
headline case fails on any codebase with a `db/` layer, which is most of them.
**Done when:** a write through a repository wrapper is attributed to the calling
module, not the wrapper.

### 17. Exported surface
`extract/imports.ts` extension. Added and removed exports per module.
**Done when:** adding an export to this repo produces exactly one added fact.

---

# Phase 5 — honesty

### 18. Coverage, including the negative dimension
`extract/coverage.ts`. Gaps by reason, **scoped to the session**, never a
percentage. Plus the crucial part: read `package.json` and declare
unsupported frameworks explicitly — *"you depend on `hono`; I have no extractor
for it, so the route list is structurally incomplete, not empty."*
**Done when:** pointing it at a Hono app says so, rather than reporting zero
routes (**G2**). Without this, coverage can read 94% while missing 100% of the
routes.

---

# Phase 6 — outputs

### 19. `--json`, versioned schema
The deterministic primitive an agent can call is the durable half.
**Done when:** the schema is documented and versioned, and a schema change bumps
the version.

### 20. `--markdown` and a GitHub Action
Shareable output is the distribution mechanism; CI is where teams adopt.
**Done when:** the Action posts a receipt as a PR comment.

---

## Gates, restated

| | Gate | Where |
|---|---|---|
| G1 | Route recall ≥90% per framework | step 12 |
| G2 | Unsupported frameworks declared, not silently empty | step 18 |
| G3 | **Author reads the receipt unprompted for 2 weeks** | from step 8 onward |
| G4 | Across 20 real sessions, ≤3 produce a top-block entry | continuous |

**G4 is the one nobody thinks to write down:** a receipt that always has
something in the top block is a receipt nobody reads.

## Where we design together

Two points, both about how the thing reads rather than how it works:

- **Step 6** — the receipt layout: hierarchy, what gets dimmed, the all-clear.
- **Step 14** — the wording of rarity: `no middleware · 1 of 48 routes` versus
  the alternatives.

Everything else I will decide and show you.
