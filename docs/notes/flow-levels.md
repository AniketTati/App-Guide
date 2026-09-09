# Flow verification levels

`flow` is cut from v0. This file exists so v2 does not relearn why, and so that
when flows return, `plan` can state which level it actually checked rather than
implying more.

A flow is an ordered list of anchored steps with declared effects. "Verifying" it
spans four wildly different difficulty levels.

| Level | Claim | Difficulty | Information value |
|---|---|---|---|
| **L0** | every step's anchor resolves | cheap | near zero — asserts five symbols exist, not that they connect |
| **L1** | consecutive steps are connected in the static call graph | approximable | real, but fails at every indirection |
| **L2** | the declared *order* matches | very hard | static analysis yields "A references B and C", not a total order |
| **L3** | declared effects are the actual effects | not shipped by anyone for TS/Python | interprocedural effect analysis with aliasing |

**L1 fails at:** DI containers (NestJS providers, FastAPI `Depends`), event
emitters, queues, cross-service HTTP, callbacks, interface dispatch, dynamic
`await import()`. It also *over*-attributes: a reference inside a nested closure
belongs to the outer function, and a type-position reference looks like a call.

**L2 is not even well-defined** in the presence of branches, loops and early
returns.

Draft 1 of the build plan wrote "an ordered list of anchored steps with declared
effects" as a single bullet — that is L2 + L3, stated as though it were L0.

**When flows return in v2:** ship at L0 or L1 only, mark every flow with the
level it was checked at, and mark async seams as `unverifiable_by_construction`
rather than pretending coverage.
