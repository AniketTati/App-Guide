# The problem

Plain-language statement of what we're building and why. Written to be readable
by someone who wasn't in the conversation — no jargon, no diagrams.

The plan lives in [PLAN.md](PLAN.md); the reasoning in [decisions.md](decisions.md).

---

## The problem

You let an AI write your app. It writes a lot, fast. A few weeks in, nobody can
say what's actually in there. Not you, because reading code is slow and all
anyone ever shows you is "here are 40 lines that changed." Not the AI, because
every session it starts cold, reads the code, and guesses at why things are the
way they are — and guesses a little differently each time. So the thing slowly
gets worse and nobody notices until it's bad.

## The question you actually have

It is not *"what is in my codebase."* That one gets asked a handful of times a
year, usually on day one of a project you inherited.

The question you have several times a day is: **"my agent just worked for two
hours — do I need to actually read this?"**

That is a yes-or-no trust decision, and you make it in about three seconds. Today
you make it on vibes, because the only evidence you're offered is the agent's own
summary and a wall of diff.

## What we'd build

Something that answers that question without being asked. When your agent
finishes, a few lines appear under its summary:

> Your agent added 3 routes, one with no middleware, made `billing/` write to
> `users` for the first time, and pulled in `node-fetch`.

Six things get watched: new routes, new dependencies, new outbound network calls,
first-ever writes to a table, changes to the exported surface, and — importantly
— what it couldn't see.

Most days it says nothing happened. That is most of the value.

## Why not just ask the AI

Two reasons, and neither gets better as models improve.

**Independence.** The agent that made the change is the wrong party to report on
the change. That's a conflict of interest, not a gap in ability. It'll still be
true in three years.

**Exhaustive negatives.** "No new routes were added" is worthless unless it's
complete, and a language model can't promise complete. A parser can. The value is
in the negative space — in being told, reliably, that nothing happened.

## How it avoids crying wolf

It never says a change is dangerous. It says the change is **the only one of its
kind here**, and lets that speak:

> `no middleware · 1 of 48 routes`

That's arithmetic. You can check it, and it can't be wrong. Nothing gets promoted
to the top without a number like that behind it.

And it only yells once. The second time `billing/` writes to `users`, it isn't
the first time any more, so it drops out by itself. There's no list of things to
silence, because nothing keeps shouting.

## The hard part

Being honest about what it can't see. Some code isn't readable by a parser —
things decided at runtime, dynamic lookups, calls that cross a queue. A tool that
quietly skips those and shows you a clean report is worse than no tool, because
you'd believe it.

So it says so, in the same breath, scoped to what just changed:

> `src/handlers/registry.ts didn't parse · 1 route path is built at runtime`
> `→ a change inside either would not appear above`

That last line is what makes the rest believable. "Nothing hidden" isn't
literally achievable. Nothing hidden *without telling you* is.

## Where it stands

Nobody does this. There are tools that draw maps of your codebase, tools that
enforce import rules, tools that feed a written spec to an agent before it
starts, and AI reviewers that read your diff and offer opinions.

What's missing is the boring, deterministic one: a short, complete, checkable
account of what structurally changed — delivered without being asked, by
something that didn't write the code.
