# CLAUDE.md

Entry point for coding agents working in this repository.

## Start here

**Read [docs/PLAN.md](docs/PLAN.md) first, every session.** It is the single
source of truth for status, sequencing, and every document that exists. It tells
you what is done, what is next, and what is blocked.

If PLAN.md and any other document disagree, PLAN.md is right and the other one is
a bug — fix it in the same commit you noticed it.

## Documentation rules

Full rules are in PLAN.md §4 and §5. The three that matter most:

1. **Never create a document without adding it to the index in PLAN.md §2**, in
   the same commit. A document not listed there does not exist.
2. **`docs/decisions.md` is append-only.** Never edit a past decision — supersede
   it with a new numbered entry and mark the old one superseded. The reversals
   are the most valuable content in that file.
3. **Update PLAN.md §1 whenever a stage changes state or a gate passes or fails**,
   and bump its *Last updated* line. On completion, not on intention.

Do not create planning documents, summaries, status files, or scratch notes at
the repository root. Markdown explosion is a documented failure mode for exactly
this kind of project.

## Commits

Commits are authored by the repository owner alone. **Do not add
`Co-Authored-By` trailers.**
