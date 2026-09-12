# PLAN — single source of truth

**This file is authoritative.** Status, sequencing and the document index live
here and nowhere else. Every other document is a detail this one points at.

If this file and another document disagree, **this file is right and the other
one is a bug.** Fix it in the same commit that you noticed it.

Last updated: 2026-09-12 (receipt delivery rebuilt for Claude Code; not yet seen live)

---

## 1. Status

v0 is built and installable from GitHub. What is unproven is no longer whether
it can be built, but whether a person sees the receipt and reads it — first the
in-session display below, then G3 and the Step 1 evidence test.

| Stage | State | Gate to leave it |
|---|---|---|
| Documentation | ✅ done | plan, problem, decisions, spec written and linked |
| **Step 0** — verify competitors | ✅ **passed** | neither produces the inventory signals ([decisions.md](decisions.md) §15) |
| **v0 — the receipt** | 🟡 **built, G1 measured and failing** | G1–G4 · steps in [notes/build-steps.md](notes/build-steps.md) |
| v0.5 — GitHub Action + markdown | 🟡 written, never run in CI | in someone else's CI |
| v1 — MCP server | ⬜ not started | someone asks for it |
| v2 — rules, frozen on first run | ⬜ not started | findings people act on |

**Resolved**

- **Licence: Apache-2.0.** Patent grant, enterprise comfort, and permissive costs
  us nothing since there is no moat in the extractor.

**Still open**

- **Step 1, the 4-day evidence test, was never run.** Building came first. It is
  still the cheapest thing that could kill this, and it is now cheaper than
  before because the tool can generate the deltas itself.
- **G1 fails as written: 83.2% route recall against a ≥90% gate.** Measured
  against what Express registers at runtime across 23 of its own example apps,
  not hand-labelled samples. Precision is 100% and **0 misses were silent** —
  all 18 misses are dynamically registered routes, each disclosed by a gap.
  The promise holds where the gate does not; the gate stays failed rather than
  being redefined after the data came in. Reproduce: `pnpm bench:recall`.
  Caveat: small idiomatic apps, not production code.
- **Installable from GitHub, not published to npm.** `npx --yes
  github:AniketTati/App-Guide` installs, including the non-developer install;
  about 15s the first time and 2.5s per hook run after. npm publish needs the
  owner's login and is a deliberate, irreversible step.
- **Until 2026-09-12 no one inside Claude Code could see a receipt.** A Stop
  hook's plain output goes to a debug log. The receipt now arrives as a
  `systemMessage` for the person and, with their next message, as context for
  Claude ([decisions.md](decisions.md) §18). The contract is tested and Claude
  Code was seen loading the hooks, but **no one has yet seen the receipt
  appear in a live session**. That is the next check.

## 2. Document map

Every document, its single job, and what it is the source of truth *for*. **A
document not listed here does not exist** — see §5.

| Document | Job | Source of truth for |
|---|---|---|
| **PLAN.md** (this file) | where we are, what's next, what exists | status, sequencing, the index, doc rules |
| [problem.md](problem.md) | why this exists, in plain language | the problem statement |
| [decisions.md](decisions.md) | what we concluded and why | reasoning behind every choice |
| [notes/v0-spec.md](notes/v0-spec.md) | what v0 actually is — the receipt, signals, ranking | the v0 product surface |
| [notes/build-steps.md](notes/build-steps.md) | numbered implementation steps with definitions of done | how v0 gets built |
| [notes/flow-levels.md](notes/flow-levels.md) | the four flow-verification levels | what "verified flow" may claim |
| [../README.md](../README.md) | public face of the repository | the one-paragraph pitch |
| [../CLAUDE.md](../CLAUDE.md) | agent entry point | where an agent starts reading |
| [../LICENSE](../LICENSE) | Apache-2.0 | the licence terms |

**Directories**

```
README.md              public face — short, links here
CLAUDE.md              agent entry point — links here
LICENSE                Apache-2.0
docs/
  PLAN.md              ← you are here. Authoritative.
  problem.md           why. Stable; rarely changes.
  decisions.md         decision log. Append-only.
  notes/               one topic per file. Created as needed, linked from §2.
  research/            findings from investigations. Dated. Created when needed.
```

---

## 3. The plan

**Constraints:** one developer with Claude Opus 5. The product is a
**deterministic structural diff of what your coding agent just changed**,
printed automatically when the agent stops. Full product detail in
[notes/v0-spec.md](notes/v0-spec.md).

**The reshape.** Five independent critiques — developer, vibe coder, PM,
designer, GTM — all reached the same conclusion: a standing picture of a codebase
answers a question asked 2–4 times a year; *"what did the agent just change"* is
asked several times a day. Frequency beats intensity, because the only thing that
produces adoption is habit. See [decisions.md](decisions.md) §9.

### Step 0 — verify the competitors · this week

Two MIT-licensed tools reportedly ship most of this already: **`fallow`**
(~3.7M npm downloads/month, viz + changed-file audit + MCP + a Claude Code hook)
and **`code-review-graph`** (`detect-changes --base <ref>`, 30 MCP tools, GitHub
Action). ⚠️ Reported by a research agent, not independently confirmed.

**Install both. Run them on this repo.** If either already answers the P0, the
correct move is to contribute the inventory-delta command to it rather than
spend two months rebuilding its foundation. That is not a defeat — it is the
fastest route to the only asset that matters.

**Gate:** neither produces the six signals in §3 of the spec.

### Step 1 — the evidence test · 4 days, no code

The riskiest assumption is **not** "can ts-morph load a monorepo" — ts-morph has
18.5M downloads a week; it loads monorepos. The riskiest assumption is:

> **that the structural delta after an agent session contains something the
> developer did not already get from the agent's own summary plus `git diff`.**

The bet is that agent summaries are systematically incomplete in one direction:
they narrate *intent* and omit *consequence*. They say "added a search endpoint."
They don't say "…and pulled two transitive deps, and it bypasses your auth
middleware, and it's the first thing in `search/` that writes to `users`."

**Method:** 5 TypeScript repos, 20 realistic tasks. Run the agent. Save its
summary and the diff. Compute the six signals **by hand or with grep** —
deliberately no parser. Score: does the delta contain ≥1 fact that was absent
from the summary, not obvious from skimming the diff, and worth knowing?

**Gate: ≥40% of sessions.** Under 20%: stop, and publish the write-up instead —
it will be worth more than the tool. In between: the signals that actually fired
*are* v0, and the ones that never fired are cut.

This tests the **product** before the **technology**, which is the right order.

### v0 — the receipt · 6–8 weeks

| Week | Work |
|---|---|
| 1 | ts-morph load, import graph, `package.json` inventory. Record unresolved reasons from day one. |
| 2 | Routes: server actions, tRPC, NestJS, Express. Middleware as three states — *has / none / unresolved*. External-host detection. |
| 3 | Snapshot to a gitignored ledger; diff two snapshots; terminal renderer; the ranking function. |
| 4 | `init-hook`, coverage lines including the negative dimension, README, npm publish. |
| 5–6 | Table writes (Drizzle, then Prisma), `--markdown`, GitHub Action. |

**Hard latency requirement: incremental re-index under ~2 seconds.** A hook that
takes 60 seconds gets uninstalled on day one. This replaces "cold index 200k LOC
under 60s," which is the wrong number for something that runs after every
session.

**Gates**

| | Gate | Threshold |
|---|---|---|
| G1 | Route recall | ≥90% against 50 hand-labelled, per framework |
| G2 | Coverage honesty | a repo using an unsupported framework is told so explicitly, not shown an empty list |
| G3 | **Dogfood** | the author reads the receipt after their own agent sessions, unprompted, for 2 weeks |
| G4 | Quiet by default | across 20 real sessions, ≤3 produce a top-block entry |

G4 is the one nobody would think to write down: **a receipt that always has
something in the top block is a receipt nobody reads.** G3 is measurable in week
two rather than month three, because the hook makes it self-triggering.

### v0.5 — CI · with v0, not after

GitHub Action plus markdown output. The CLI is where people try it; CI is where a
team adopts it. It also forces the shareable artifact, which is the distribution
mechanism.

### v1 — MCP server

Only when asked. It is the most-competed thing in the space, and `--json` with a
versioned schema covers the agent case from day one.

### v2 — rules, frozen on first run

Only if v1 produced findings someone acted on. Existing violations frozen, or the
tool is deleted within a week.

### Launch: publish the measurement, not the tool

In this exact niche, Show HN posts for tools score **1–37 points**, uniformly,
including ones from YC companies. Posts that lead with a *number* score 300–700.

Mechanics, measured ([decisions.md](decisions.md) §12): **fire every channel on
one day** — GitHub Trending ranks on same-day velocity, and the per-language
board is a much smaller field. **Keep "AI" out of the title** (1.01% vs 2.04%
chance of clearing 100 points on HN). r/programming is closed to AI tooling;
**r/ClaudeAI** is the permissive venue. **Console.dev** is the best newsletter
fit and takes pre-1.0 submissions at `hello@console.dev`.

So the launch is the Step 1 study, scaled: *"we measured N agent sessions: X%
added a dependency the agent never mentioned; Y% of new routes shipped with no
auth."* The tool is the reproduction instructions at the bottom. An engineering
leader who reads that immediately asks "what's **our** number?" — which is a
question only this tool answers.

### Commercial ceiling, honestly

**Assume zero.** Measured base rates ([decisions.md](decisions.md) §11): across
all 2,652 Open Source Collective projects the median is **$6/year** and 48%
receive exactly nothing; in a 703-owner devtool sample, **82% have no public
sponsors and 0.4% clear $1,000/mo.** The canonical case — mise, 27k stars and
~1% of all `brew install` invocations — earned $600/mo, and its author took a
full-time job in June 2026. The 2026 success pattern is acqui-hire, not revenue:
Bun reached Anthropic with $0 revenue ever.

If money is the goal, **the study is worth more than the software.**

Do not build billing. Do write the append-only session ledger from commit one —
it is the only unrecoverable decision — but **attribute it to the session, never
to a developer.** When VS Code enabled `Co-authored-by: Copilot` by default, the
backlash reached 1,513 points on Hacker News and Microsoft reverted in a week.

**The compliance path is closed** ([decisions.md](decisions.md) §10): no
regulation or framework requires knowing which lines an AI wrote, and Sonar is
*removing* its automatic AI-code detection. Do not count audit demand as a reason
to build.

### Off the roadmap

`map.html`, the module graph, the data matrix, flows, Python, any hosted app, the
ACP shell, schema migrations, and the sketchbook. Code visualization has never
supported a standalone product in thirty-five years — Sourcetrail is archived,
CodeSee returns 404, Structure101 is now a free SonarQube feature.

## 4. Doc principles

Borrowed from the product's own thesis, because they are the same problem.

1. **One source of truth per fact.** If two documents state the same thing, one
   is wrong. PLAN owns status and sequencing; decisions owns *why*; notes own
   detail. Never restate — link.
2. **PLAN points at everything.** A document not in §2 is invisible and will rot.
3. **Load-bearing or delete it.** A document nobody reads is worse than none,
   because it will be trusted while wrong. This is the whole product thesis
   applied to ourselves.
4. **Update on completion, not intention.** Status changes when a thing is done.
5. **Docs change in the same commit as what they describe.** A follow-up commit
   is a commit that does not happen.
6. **Every document states its job in the first two lines**, so a reader knows in
   one glance whether to keep going.
7. **Keep them short.** Markdown explosion is a documented failure mode — Spec
   Kit produced 2,577 lines of it for 689 lines of code. If a note passes ~300
   lines it is probably two notes. PLAN is the one file allowed to be long,
   because it is the index.

## 5. How to create, update and delete

### Create

1. Pick the home: **notes/** for a single technical topic, **research/** for
   dated findings from an investigation, **docs/** root only for something with a
   permanent, distinct job.
2. Open with a one-line statement of the document's job.
3. **Add a row to §2 in the same commit.** A document not listed does not exist.

### Update

- **PLAN.md** — edit in place, and bump *Last updated*. Update §1 whenever a
  stage changes state, a gate passes or fails, or a blocking decision resolves.
- **notes/**, **research/** — edit in place.
- **decisions.md** — **append-only.** Never edit a past decision. Supersede it
  with a new numbered entry and mark the old one
  `~~superseded by #N~~`, so the reasoning trail survives. Reversals are the most
  valuable thing in that file.
- **problem.md** — should almost never change. If the problem statement is
  moving, that is a signal worth a decision entry rather than a quiet edit.

### Delete

Preferred over letting something go stale.

1. Delete the file.
2. Remove its row from §2.
3. Add a decisions entry saying what was deleted and why.

All three in one commit. A document removed from disk but left in §2 is worse
than either state alone.

### When finishing a piece of work

1. Update §1 — state, and any gate result.
2. Add a decisions entry if a *choice* was made, not merely work done.
3. Add or remove notes, updating §2 to match.
4. Bump *Last updated*.

One commit.
