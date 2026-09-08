# App Guide

Keep an AI-written codebase honest — so the model doesn't drift, and you don't
lose track of what's in your own project.

> **Status: design in progress. There is no working code here yet.**
> This repository currently holds the problem statement and the design thinking
> behind it.

## The idea

Two things sit side by side:

1. **What the app is supposed to be** — a blueprint committed to `.appguide/`
   inside your repository.
2. **What the code actually does** — read automatically out of the source.

A third thing continuously compares them and shows you where they disagree.

Neither side generates the other. The blueprint does not produce the code, and
the code does not rewrite the blueprint. They both exist, and the gaps between
them are the product.

Every gap is a decision with two possible answers — *the code is wrong* (which
becomes a task for the agent) or *I changed my mind* (which updates the
blueprint). Designing up front and catching drift afterwards turn out to be the
same mechanism viewed from opposite sides.

## Why a folder, not a document

`.github/workflows` is the closest existing thing in shape: a directory with a
known name, a known schema, and tooling that maintains it. Nobody calls it
documentation. It stays correct because it is load-bearing — things break when
it is wrong.

Plain documentation rots precisely because nothing breaks when it lies. And a
blueprint that lies is worse than none at all, because now the agent confidently
trusts something false. So every box in every picture points at a real symbol in
a real file. If that symbol is renamed or removed, we know immediately. If code
appears that no box points at, we know that too.

## What's here

- **[problem.md](problem.md)** — the plain-language statement of the problem and
  the shape of the solution. Start here.

## Non-goals

- **Not a documentation product**, and not a collaboration tool. That a
  committed folder happens to be shareable is a consequence, not a goal.
- **Not a code generator.** Nothing here regenerates your application from a
  specification.
- **Not another model provider.** The intent is to drive whichever coding agent
  you already run and pay for, rather than to broker API access.

## Prior art

Pieces of this exist separately: tools that index code into a graph, tools that
enforce import boundaries, tools that feed a written spec to an agent before it
starts, and canvases you can draw on beside an agent. The academic lineage is
software reflexion models (Murphy, Notkin & Sullivan, 1995).

The missing middle is a drawing that points at real code, and a check that runs
*after* the agent is done rather than only before it starts.

## License

Not yet chosen. Until one is added, default copyright applies.
