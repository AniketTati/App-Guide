# App Guide

**A structural diff for the code your agent just wrote.**

Your coding agent tells you what it *meant* to change. This tells you what it
structurally *did* — new HTTP routes, new dependencies, new outbound calls, new
database writes — plus an explicit list of what it could not see.

Deterministic. Local. No model, no API key, no account.

> **Status: works, installable from GitHub, not yet on npm.** The commands
> below run straight from this repository. The very first run takes 15–25
> seconds while it downloads and builds; after that each run takes about 3
> seconds, most of it a check against GitHub — so for now it needs an internet
> connection each time. Plan and reasoning: **[docs/PLAN.md](docs/PLAN.md)**.

## What it looks like

```
 appguide · session 14:02–15:47 · 31 files

 Your agent added 3 routes, one with no middleware, made billing/ write to
 users for the first time, and pulled in node-fetch.

 NEW TO THIS CODEBASE
   route   POST /api/admin/reset-usage      no middleware · 1 of 48 routes
           src/api/admin.ts:14              every other route has ≥1

   write   billing/usage.ts → users         first write to users from outside
           :112 updateSeatCount()           auth/ · 3 other files write it

 NOT COVERED
   src/handlers/registry.ts didn't parse · 1 route path is built at runtime
   → a change inside either would not appear above
```

It installs a hook once and prints itself when your agent stops. Most sessions
are boring — that is the point. The value is that the one time it isn't, you
notice.

## If you don't write code

You don't need a terminal. Paste this into your agent's chat and ask it to run it:

```
npx --yes github:AniketTati/App-Guide init-hook --plain
```

It checks that it actually works before telling you it's set up, and takes a
first look at your app straight away — so the very next time your agent
finishes, you'll see what it changed. If it can't run, it says so instead of
claiming success.

From then on, when your agent finishes working, a short summary appears in your
Claude Code session telling you what it changed — once, not after every reply.
Most of the time it just says nothing new. The value is that the one time it
isn't nothing, you notice.

It works in Claude Code. Cursor and other agents aren't supported yet.

It looks like this:

```
 appguide · 3 files

 Your agent added 1 new URL with nothing checking who can use it, let 2 new
 parts of your app change your users data, and started talking to
 api.stripe.com.

 WORTH A LOOK
  #1  URL      POST /api/admin/reset-usage   nothing checks it · 1 of 10 URLs
               src/api.ts:11                 every other URL is checked
               Anyone on the internet can reach this one.

 WHAT I COULDN'T READ
   I can't read hono yet, so anything it creates is missing from this list.
   → anything your agent changed in it is missing from the list above

   Ask your agent: "explain #1" or "fix #1"   ·   4 changes in total
```

You don't have to act on any of it yourself. Say **"explain #1"** or
**"fix #1"** to your agent — the summary is handed to it along with your next
message, so it knows what #1 means.

When you've read it, the report prints the exact command for your agent to run
so the next one starts fresh. Otherwise the same list comes back every time.

To remove it, ask your agent to run:

```
npx --yes github:AniketTati/App-Guide init-hook --uninstall
```

**It will never tell you something is dangerous.** It says *"nothing checks
it — 1 of 10 URLs"*, which is a count you can check, not an opinion you have to
trust. And it always tells you what it couldn't read, so a short list never
quietly means a clean bill of health.

## Why not just ask the agent

Two reasons, and neither closes as models improve:

- **Independence.** The agent that made the change is the wrong party to report
  on the change. That is a conflict of interest, not a capability gap.
- **Exhaustive negatives.** *"No new routes were added"* is worthless unless it
  is complete. A language model cannot make an exhaustive claim; a parser can.
  The value lives in the negative space.

## Severity without a rules engine

It never says a change is dangerous. It says `no middleware · 1 of 48 routes` —
a ratio you can verify and it cannot get wrong. **No finding is promoted without
a corroborating denominator**, which is a mechanical guarantee against false
alarms.

And firstness self-extinguishes: the second time `billing/` writes to `users`, it
is no longer first and drops out on its own. No suppression list, no rules file,
nothing to configure.

## How accurate is it

Measured against what Express *actually registers* when an app runs, across 23
of Express's own example apps — 107 routes:

| | |
|---|---|
| Routes found | 89 of 107 (83%) |
| Routes reported that were real | 55 of 55 (100%) |
| Routes written out in the code that were found | 89 of 89 (100%) |
| Missed routes it stayed silent about | **0** |

All 18 missed routes are registered dynamically — a method or path read from
data while the app runs — which no static reader can list. Every one was in an
app where the report said routes existed that it couldn't list.

These are small, idiomatic example apps, not production codebases; expect real
apps to be messier. Reproduce it with `pnpm bench:recall`.

A later hands-on review found a common pattern those apps don't use —
`router.route('/x').get(…).post(…)` chains — being missed silently. That is
fixed and tested, and it is exactly why the number is published rather than
asserted.

## What it will not do

- No codebase map, module graph or architecture diagram. Code visualization has
  never supported a standalone product; see [docs/decisions.md](docs/decisions.md) §9.
- No rules, no config file, no authoring — nothing to write before it works.
- No account, no telemetry, no network. Everything runs locally.
- No judgement calls. It reports arithmetic and lets you decide.

## Documentation

| | |
|---|---|
| **[docs/PLAN.md](docs/PLAN.md)** | Single source of truth — status, plan, doc index. **Start here.** |
| [docs/problem.md](docs/problem.md) | The problem, in plain language |
| [docs/notes/v0-spec.md](docs/notes/v0-spec.md) | What v0 actually is |
| [docs/decisions.md](docs/decisions.md) | What we concluded, and why |

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).
