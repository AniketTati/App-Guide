# Decisions record

Conclusions reached so far, with the reasoning attached. Written to be read by
someone who was not in the conversation.

Companion documents: [problem.md](../problem.md) (why),
[PLAN.md](PLAN.md) (how), [flow-levels.md](flow-levels.md) (one
deferred detail).

---

## 1. The problem — settled

1. **Two failures, not one.** The model drifts away from what was intended, *and*
   the human goes blind to what is in the codebase. Drift detection tells you
   what moved; it says nothing about what is there. They need different surfaces.
2. **Review happens at the wrong altitude.** What goes wrong is structural — a
   step vanishes, a boundary is crossed, a retry disappears. A text diff shows
   forty changed lines, not "this flow lost its compensating write."
3. **Documentation rots because nothing breaks when it is wrong.** Anything we
   build must be load-bearing or it will lie within weeks — and a blueprint that
   lies is worse than none, because the agent then trusts something false.

## 2. Core architecture — settled

4. **Reconcile, don't generate.** The model owns intent, the code owns
   implementation, and a third thing continuously compares them. Neither side is
   a build product of the other.
5. **Both directions are one mechanism.** Intent with no code yet = "unbuilt";
   code with no intent = "unmodelled". Design-first and drift-catching are the
   same comparison read from opposite sides.
6. **Repo-native, single-player.** A committed folder with a known name and
   schema — the `.github/workflows` shape. Not a documentation product, not a
   collaboration tool. Shareability is a consequence, not a goal.
7. **Why in-repo and not hosted:** the product's core question — *did that change
   make it worse?* — is a diff, and diffs live in version control. Branching and
   atomicity settle it; the "non-engineers can browse it" argument was answering
   the wrong question.

## 3. What the research settled

8. **This has a name and a literature.** Software reflexion models (Murphy,
   Notkin & Sullivan, 1995): high-level model, extracted source model, declared
   mapping, computed divergences. Reassuring about the shape.
9. **And a warning.** They never went mainstream, because maintaining the model
   and mapping by hand cost more than it returned. The bet is that an agent can
   now maintain the map, and that agent-written code raised the drift rate enough
   to clear the cost. **Both halves are plausible; neither is proven.**
10. **Every quarter of the idea already exists.** Code-graph indexers, import-
    boundary linters, spec-to-prompt tools, canvases beside agents. The missing
    middle is consistently the unglamorous part: **an authored model with anchors
    into real symbols, and verification that runs after the agent is done.**
11. **SCIP cannot be the anchor identity.** Its symbol grammar embeds the package
    version and the file path, so `git mv` breaks every anchor in a file and
    `npm version patch` breaks every anchor in the package. It is a cache hint on
    a resolution ladder, not an identity.
12. **The TypeScript and Python SCIP indexers are unmaintained** (last shipped
    Oct/Sep 2025), pin TypeScript 5.6 against a current TS 7, and do not emit
    symbol `kind` — which nearly every check needs. So we own the TypeScript
    extractor. "Borrow the extractor" was false for our chosen language.
13. **Terraform is the mature version of this problem.** Three-way state (config
    / last-known / actual) and three verbs (plan / apply / import). The third leg
    is what makes "which side moved?" answerable — but its state deliberately
    does *not* live in version control, and neither does ours.
14. **Structurizr solved the authoring burden with a tier split:** high-level
    elements authored, low-level components extracted. Nobody hand-maintains the
    layer that churns.
15. **dependency-cruiser is the adoption model** (7.1k stars, 3.4M installs/week):
    a useful graph with zero rules authored, and an `init` that writes eleven
    rules for you.
16. **ArchUnit is the anti-pattern** — and it is the profile our first draft had.
    Nothing happens until you author a rule; no visualization in nine years. Its
    documented failure is the **adoption trap**: a sensible rule on an old
    codebase yields 200 violations on day one and the team deletes the rule by
    Friday.
17. **The spec-driven category is retreating.** Spec Kit has 134k stars against
    roughly 1/229th of dependency-cruiser's installs, measures ~10× slower than
    plain prompting in a controlled write-up, and carries an ~18.6k-token context
    tax. Tessl — the best-funded pure play at $125M — **left the category
    entirely in January 2026.** Spec-driven development has never reached Trial
    on the Thoughtworks Radar.
18. **Conclusion drawn from 15–17:** lead with the post-hoc tripwire, make the
    map an adoption path rather than a demo, and let authored intent arrive later
    — or never.

## 4. Reversals from the critique loop

Ten things that changed between the first and final build plan. Each was a defect
found by review, not a refinement.

19. **The model is generated, never authored.** The first draft asked a user who
    by definition cannot describe their codebase to hand-write a formal
    description of it. The precondition for using the product was the absence of
    the problem it solves.
20. **Anchors are kind-specific.** An inline route handler is an anonymous local
    with no name to anchor on, and its body is the one thing an agent reliably
    rewrites. Routes anchor on `(method, path-literal, registration site)`.
21. **Freeze on first run.** `init` records what exists as frozen; `plan` reports
    only what is new. Without this, item 16 kills the tool in a week.
22. **Two baselines, not one.** A local *session mark* answers "what changed since
    I last looked" (the tripwire); *merge-base* answers "what did this branch do"
    (the PR view). Collapsing them destroys the tripwire.
23. **The baseline is not committed.** Committing it guarantees conflicts on
    concurrent PRs and corrupts on squash merges.
24. **The success case was misclassified.** An agent that correctly implements
    updated intent moves both sides — the original table called that a conflict,
    and it is the most common path in the target workflow.
25. **`unanalysed` is a first-class state.** A repo that does not typecheck is the
    normal state immediately after an agent session, which is exactly when the
    tool runs. Without this, one failed file load reports every anchor as drift.
26. **Human decisions live apart from the generated model.** Otherwise
    regeneration destroys confirmed boundaries and silently switches checks off.
27. **The MCP surface is read-only.** An agent holding both `plan()` and
    model-edit rights can resolve any divergence by moving the model — violating
    the one invariant, from inside.
28. **The wedge is the tripwire, not the reconciler.** *"Your agent worked for two
    hours — here is what it added that you didn't ask for"* needs zero
    configuration and answers the stated pain directly.

## 5. The recut — solo, agent-driven, comprehension-first

Two facts arrived late and changed the plan more than any review did: the primary
goal is **comprehension** (a complete standing picture of logic, libraries and
flows), and it will be built by **one developer working with Claude Opus 5**.

29. ~~**The goal is a standing picture, not a delta.**~~ **[SUPERSEDED BY #49]** Earlier drafts optimised for
    "what changed since you last looked." That is a delta. The stated P0 is
    "at any point in time I know what is in here." Drift detection is second.
30. **Therefore nothing is stored, and the expensive machinery disappears.** The
    seven-rung anchor ladder, two baselines, three-way differ, and freeze/thaw
    all existed to make a *stored* model survive a changing codebase. A tool that
    re-derives the picture every run has no anchor to break.
31. **Anchor durability leaves the critical path.** It was called the fatal risk
    and had a three-week spike built around it. Identity is still needed to diff
    two snapshots hours apart — but that is a far weaker requirement than
    tracking an authored node across two hundred commits. Durable anchors return
    in v2, by which time v1's snapshot history will have measured how well simple
    identity holds, on real code, for free.
32. **Libraries are a first-class node type.** Named in the P0 and absent from
    every prior draft. Cheap — `package.json` plus the import graph — and "the
    agent quietly added a dependency" is one of the better change signals.
33. **Flows return, at show-not-verify fidelity.** The earlier cut conflated two
    bars. *Verifying* a flow is interprocedural analysis nobody ships for
    TypeScript; *showing* one is a call-graph walk. Flows are drawn, marked
    approximate, and async seams render as explicit breaks labelled "cannot
    follow past here" rather than being silently omitted.
34. **Coverage is a feature, not a caveat.** "Nothing hidden" is not literally
    achievable; dynamic dispatch and runtime configuration are not statically
    knowable. So the map ships a coverage panel naming exactly where it is blind.
    A map that admits what it cannot see is trustworthy in a way a seamless one
    is not — and the alternative is the lying blueprint again.
35. **Build it in TypeScript so it indexes itself.** This project is written the
    way the target user writes: one person, agent-driven. It is both the first
    test repository and the first real user.

## 6. Scope

36. **v0 — the map.** One command, no configuration, no authored file, no stored
    state. Modules, libraries, routes, data access, flows, coverage. Emits a
    self-contained `map.html`. **8–12 weeks.**
37. **v0.5 — read-only MCP server.** For an agent-built project this is the
    highest-value stage: the agent writing the code gets the same picture the
    human has, which attacks drift at its cause rather than detecting it after.
    **2–3 weeks.**
38. **v1 — the tripwire.** Now a diff of two local snapshots rather than a stored
    model, so the committed-baseline problems disappear entirely. **3–4 weeks.**
39. **v2 — rules at the point of pain**, with existing violations frozen on first
    run. Only if v1 produced findings anyone wanted to act on.
40. **Cut:** Python, `appguide serve` and any hosted app, the ACP shell decision,
    schema migration tooling, "component fetches its own data" (wrong-by-default
    under React Server Components), and the sketchbook — the last recorded as a
    conscious narrowing, since it is most of what `problem.md` describes as the
    experience.
41. **Ordering, and why:** see it → let the agent see it → notice when it changes
    → constrain it. Each stage is useful alone, needs no authoring, and works for
    one person with no team.

## 7. Execution

42. **Stage 0 is one week**, down from three: the two cut spikes tested
    stored-model machinery that no longer exists in v0.
43. **Recall is the binding threshold, not precision.** A missed route is
    invisible; a false one is noise you can see and delete. Silence is the
    failure mode this product exists to prevent.
44. **13–19 weeks solo to a genuinely useful tool.** The previous draft's v0
    alone was 45–67 person-weeks and would not have shipped the thing that was
    asked for.
45. **The real gate is dogfooding** — the author running it on this repo weekly,
    unprompted, for four consecutive weeks. A solo project its own author stops
    opening is finished regardless of what the other numbers say. Kill decision:
    end of month three.

## 8. Open — needs a decision

46. **Licence.** The repository is public with default copyright, which
    contradicts the open-source intent and blocks release.
47. **The TypeScript-only cut** rests on an untested assumption that agent-written
    apps are overwhelmingly TS/JS.
48. **Whether `map.html` regenerates on file save or only on command.**

## 9. The five-lens review — and the reversal of #29

Five critiques were run against the v0 spec: hands-on developer, non-technical
vibe coder, product manager, designer, go-to-market. **All five independently
reached the same conclusion**, which no previous round had done.

49. **The delta ships first; the map does not ship at all in v0.** This reverses
    #29 and restores #18 and #28, which said the same thing twice before I
    talked myself out of them. Note honestly what happened: #29's justification
    was a restatement of a stated preference plus a fact about *build capacity*
    (solo dev) — never evidence about *demand*. That is a preference reversal
    wearing the costume of a discovery, and the append-only rule is what made it
    visible.
50. **A standing picture is a question asked 2–4 times a year; "what did the
    agent just change" is asked several times a day.** Frequency beats intensity
    for a solo open-source tool, because the only thing that produces adoption is
    habit, and habit needs daily contact. The map has no recurring trigger, so
    G3 (weekly unprompted use) would have failed by construction at month three.
51. **Code visualization has never once supported a standalone business** — in
    thirty-five years. Sourcetrail: 16.5k stars, archived. CodeSee: $10M raised,
    codesee.io returns 404, acqui-hired. Structure101: 25 years, now a free
    SonarQube feature. Softagram: pivoted to ERP consulting. The best outcome in
    the category is SciTools Understand at 11–50 people, and it survives by
    selling DO-178C compliance evidence, not comprehension.
52. **Stars are not usage, and npx is the reason.** Tools that live in
    `package.json` and CI get 260–820 downloads per star; tools you `npx` once
    get 1–2. Design for a line in someone's CI config, not a one-time
    invocation.
53. **The output must arrive on its own.** A tool you have to remember to run,
    answering a question you did not know you had, gets run three times and
    abandoned. It fires from a `Stop` hook when the agent finishes. This is the
    single decision that determines whether the product is essential or
    forgettable, and it is also the smallest artifact in the plan.
54. **Severity is arithmetic, never adjective.** The tool never says a change is
    dangerous. It says `no middleware · 1 of 48 routes` — a ratio the reader can
    verify and the tool cannot get wrong. **No line is promoted without a
    corroborating denominator**, which is a mechanically enforceable guarantee
    against false alarms. And firstness self-extinguishes: the second time
    `billing/` writes to `users`, it is no longer first and drops out by itself.
    No suppression list, no rules file.
55. **Never print red.** Red means broken and this tool never claims that. An
    absolute rule means it structurally cannot cry wolf.
56. **Coverage is scoped to the session and never a percentage.** A global "87%"
    reads as a report card on the user's own code, collides with test coverage,
    and can only drift downward. Per-claim instead: *"there are 2 more routes
    whose address I couldn't read — here they are."*
57. **Two structural advantages survive better models**, and neither is a
    capability gap that closes: **independence** (the agent that made the change
    is the wrong party to report it — that is a conflict of interest, not a
    capability limit) and **exhaustive negatives** (*"no new routes were added"*
    is worthless unless complete; an LLM cannot make that claim, a parser can).
58. **Do not build for the vibe coder.** They are unreachable — they live inside
    Lovable/Replit/Bolt and will get this free from the platform they already pay
    — and every panel of the spec presumes structural literacy they do not have.
    The reachable user is the developer who is *epistemically* in the vibe
    coder's position: technically fluent, but did not write the code because an
    agent ran for two hours.
59. **Verify the competitors before writing any code.** Two MIT-licensed tools
    reportedly ship most of the reshaped product already. This is the cheapest
    and most decisive action available and it precedes everything else.
    ⚠️ Reported by a research agent, not independently confirmed — verify by
    installing them.

## 10. The compliance path is closed

The GTM review ranked "prove what the AI wrote" as the strongest buyer, on the
theory that regulation would force it. Dedicated research says it will not.

60. **No regulation, standard, certification scheme, or procurement questionnaire
    anywhere requires knowing which lines of code an AI wrote.** Checked against
    primary text, not marketing: the EU AI Act does not reach ordinary software
    development on three independent grounds; the Cyber Resilience Act's SBOM
    covers *components and supply-chain relationships*, never authorship, and
    pure SaaS is largely outside it; US EO 14306 stripped the software
    attestation and SBOM provisions out entirely, and America's AI Action Plan
    contains zero occurrences of "SBOM", "provenance", "source code" or "SSDF".
61. **The frameworks are empty too.** SOC 2 has no AI criteria. ISO 42001's 929
    certificates all scope *AI you sell*, not AI that wrote your code. The CSA AI
    Controls Matrix — 247 controls, the most credible AI control set in
    enterprise procurement — has **zero** hits for "source code", "AI-generated
    code", "coding assistant" or "SDLC"; its six provenance references are all
    about models and training data. OpenSSF's `Provenance_and_Legal_Issues.md` is
    a 28-byte stub, created 2023, never written.
62. **The clearest signals are two negatives.** **Sonar built automatic
    AI-code detection, shipped it, and is removing it** in favour of a manual
    project checkbox. And when VS Code turned on `Co-authored-by: Copilot` by
    default in April 2026, the backlash hit 1,513 points on Hacker News and
    Microsoft reverted within a week, committing that users must explicitly
    consent before any commit trailer is added. **The market's revealed
    preference on mandatory AI attribution is strongly negative** — which is a
    caution about the session ledger's framing, not just about compliance.

Practical consequence: keep the ledger (it stays cheap and it is the only
unrecoverable decision), attribute to the *session* and never to a developer, and
**stop counting compliance as a reason to build.** The commercial ceiling in
§6 stands as written, minus its best-ranked buyer.

## 11. The base rates, measured

Computed from primary APIs (Open Collective GraphQL, GitHub, HN Algolia), not
from secondary claims. These replace the GTM review's ceiling estimate with
something harder.

63. **Donation income is a power law with almost nothing in the body.** Across
    all 2,652 collectives hosted by Open Source Collective: **median $6/year**,
    48% receive exactly $0, only 5.9% clear $1,000/mo. The top 1% take 54% of all
    money. Household names are small too — ESLint $141k/yr, Biome $32k,
    Storybook $20k, split across whole teams. In a 703-owner sample of devtool
    maintainers, **82% have zero public sponsors and 0.4% clear an estimated
    $1,000/mo.**
64. **The canonical case is jdx / mise**: 27k stars, the 10th most-downloaded
    Homebrew formula — roughly 1% of all `brew install` invocations — earning
    **$600/mo**. He went full-time, quadrupled it to ~$2,400/mo, and **took a
    full-time job in June 2026.** That is what near-best-case adoption pays.
65. **The 2026 outcome is acqui-hire, not a paid tier.** Astral (Ruff, uv) →
    OpenAI. Bun → Anthropic, with **$0 revenue ever**. VoidZero → Cloudflare,
    after reversing its planned paid licence back to MIT. Fig → AWS. Every price
    undisclosed. Meanwhile **Tailwind's revenue is down ~60% from peak**, which
    Adam Wathan attributes to AI and open-source alternatives.
66. **Nobody publishes free-CLI-to-paid conversion.** The only hard disclosure is
    HashiCorp's 2021 S-1: ~100M annual downloads → 2,101 paying customers.

**Consequence:** the GTM ceiling of "sustainable indie" was optimistic. Treat
revenue as approximately zero and build accordingly — which is what the plan
already does, but now for a measured reason rather than a cautious one.

## 12. Launch mechanics

Also measured, and more actionable than anything else in the research.

67. **Show HN is a lottery with a fixed ceiling.** 44,320 Show HN posts in a
    year: median **2 points**; only 1.7% reach 100. Submissions rose from 2,208
    to 6,218 a month while the number clearing 100 stayed flat — **more
    submissions purely lower the odds.**
68. **Do not put "AI" in the title.** P(≥100 points) is **1.01% for AI-titled
    posts versus 2.04% for everything else.** A tool about AI agents does
    measurably worse on Hacker News for saying so. Lead with the mechanism —
    *"a structural diff for code you didn't write"* — not the acronym.
69. **r/programming is closed to us.** It ratified an AI policy in May 2026
    making AI/LLM content off-topic except for deeply technical implementation.
    **r/ClaudeAI** (1.1M, a "Built with Claude" flair, real posts at 7–15k
    upvotes) is the permissive venue with the highest ceiling. r/webdev is
    Showoff-Saturday only; r/commandline gates posting behind a rules agreement
    you must complete *before* launch day.
70. **Console.dev is the single best-fit newsletter** — 30k subscribers, reviews
    2–3 developer tools a week, has a betas slot that explicitly requires
    pre-1.0, no sponsored reviews. Submit to `hello@console.dev`.
71. **GitHub Trending rewards same-day concentration**, and the per-language
    board is a far smaller field than all-languages. 100 stars over a month does
    nothing; 100 in an afternoon can place you. **Fire every channel on one
    day.**
72. **npm has no discovery surface at all** — no trending, no browse; search is
    dominated by exact name match. Installs come from being a dependency of
    something else, which is another argument for the CI path over `npx`.
73. **Plugin directories are not distribution.** The Claude Code community
    marketplace has 2,282 plugins; **rank 300 has six installs**, and only 335 of
    the 2,282 appear on the website at all. List, but do not count on it.

## 13. Licence

74. **Apache-2.0.** Not MIT — the explicit patent grant and the enterprise legal
    comfort are worth more than the extra file length, and this is a category
    where the eventual buyers, if any, are companies. Not AGPL — it would block
    the adoption that is the only realistic path to anything, and it protects
    nothing that could actually threaten us. Permissive costs us nothing because
    there is no moat in the extractor: the durable asset, if one ever exists, is
    the session ledger, and copyleft would not protect that either.

## 14. Doc reconciliation

75. **`problem.md` rewritten.** Its "what using it feels like" section still
    described the sketchbook, and its solution section still described the
    blueprint folder — both deleted by #49. The *problem* framing survived
    unchanged because it was always right; only the answer moved. The new middle
    section names the real question — *"do I need to actually read this?"* —
    which the original never did.
76. **`README.md` rewritten.** It was still selling a committed `.appguide/`
    blueprint directory, a product that no longer exists, on the public face of
    a public repository.

Both were caught by reviewers rather than by us, in a project whose thesis is
that stale documents get trusted while wrong. That is worth remembering the next
time the plan changes: **the docs drift the same way code does, and for the same
reason — nothing broke when they were wrong.**

## 15. Step 0 result — the gate passed

Ran 2026-09-09 against the live registries and both READMEs.

77. **`fallow` (npm, v3.23.0) does not produce the inventory signals.** It is a
    code-*quality* tool: dead code, duplication, complexity, boundary rules,
    design-system drift. Checked directly — no new-route detection, no
    new-dependency detection (it does *unused* and *circular*, not *newly
    introduced*), no outbound-call detection, no table-write attribution.
78. **But it already owns the delivery surface we designed.**
    `fallow hooks install --target agent` installs an agent-completion hook;
    `fallow audit --baseline` does changed-file gating against a saved snapshot.
    The mechanism we specced is built; the signals are not. **Building standalone
    means rebuilding a foundation someone else has, to deliver four facts.** That
    is the honest cost, and it is accepted knowingly rather than by omission.
79. **`code-review-graph` (PyPI, v2.3.8) is an agent-context tool** — a
    tree-sitter knowledge graph sold on token savings, with `detect-changes`
    scoring structural impact on callers and tests. Not inventory, not a delta of
    facts.
80. **`appguide` is available on npm.** Claim it early.

**Gate passed: build.** The narrowness is the finding — this is a feature-sized
gap, not a company-sized one, which is consistent with §11's ceiling of
approximately zero revenue. Build it because it is useful and cheap, not because
it is defensible.

## 16. What building it taught us

81. **Two adversarial reviews found ten paths to a confident, unfounded
    all-clear.** Every one lived in code that touches the filesystem or the
    parser, and none had a test. The worst: `npm` installs `bin` entries as
    symlinks, so the entrypoint guard never matched and **the published binary
    exited 0 with no output** — inside a Stop hook, indistinguishable from
    "nothing new to the shape". No unit test can catch that; it needs a test
    that invokes the built file through a symlink.
82. **`JSON.stringify`'s array replacer is a recursive property allow-list**,
    not a key-order hint. Passing `Object.keys(obj)` silently deleted every
    nested object, so `where` vanished from every serialised fact.
83. **The false positives were worse than the false negatives.** `req.get(
    'Authorization')` — Express's own header API — became a route with no
    middleware and went straight to the top block. So did `<svg xmlns=…>` as an
    outbound call, and `Array.from(nodes)` as a database read. A tool that cries
    wolf three times per session is deleted faster than one that misses things.
    Every detector now requires a resolved binding: an actual `express()` or
    `Router()` value, a URL in call-argument position, a table declared with
    `pgTable`.
84. **Denominators must compare like with like.** Next routes are always
    `middleware: 'unresolved'`, and counting them in the denominator of a
    *middleware* claim both understated the ratio and silently disabled the
    "this is the codebase's norm" suppression. Ten server actions were enough to
    turn a correctly-suppressed finding into a false alarm.
85. **Parse once.** Five passes over the same bytes was roughly half the
    runtime, on a tool that runs after every agent session.
86. **Known limits, recorded rather than discovered:** tRPC, NestJS, Hono and
    Fastify routes are not read (declared as blind spots); Next middleware
    matchers are not resolved; workspace member manifests are not walked, only
    imports; `export * from` is invisible; exports churn when a file is renamed.

## 17. Measuring recall, and getting it to non-developers

87. **Route recall was measured against a runtime oracle, not hand labels.**
    Express's own 25 example apps were loaded with registration instrumented, so
    the ground truth is every route Express actually registered — 107 routes in
    the 23 apps that load (2 need Redis or an uninstalled module). Result: 89 of
    107 found exactly (83.2%), 55 of 55 reported routes real (100%), every route
    written out literally in the code found, and **0 routes missed silently**.
88. **G1 is recorded as failed and left failed.** 83.2% is below its 90% bar.
    All 18 misses are routes registered dynamically — a method or path read from
    data while the app runs — which no static reader can list, and every one was
    in an app where a gap said so. That is the product's real promise holding.
    But a gate rewritten to pass after the data is in is not a gate, so the
    number stands as a failure with the breakdown beside it.
89. **The first measurement read 45.5% and was mostly the harness.** macOS ships
    no GNU `timeout`, so the oracle loaded 0 of 25 apps behind a suppressed
    error. Express 5 expands `app.all` into 35 per-method routes at runtime,
    turning one route into 35 misses. And `vhost()` and prefix-less `use()` hid
    real routes from an oracle that walked only the exported app. Two of the
    misses were genuine extractor defects: one-argument `app.get('env')` read as
    a route, and routes registered through `app[method](…)` or a helper using
    `this` produced no gap at all — silence with no basis. Telling measurement
    bugs from product bugs meant reading every miss.
90. **It is installable today without claiming an npm name.** npx runs a package
    straight from a public GitHub repo, which is reversible where publishing is
    not. The non-developer install was run end to end through it: verified the
    install, took the first look, and the next agent session produced a real
    receipt. About 15s the first time, 2.5s per hook run after — most of that
    is the network check against GitHub, not the tool.
91. **The first session now produces a real receipt.** Installing previously
    took no snapshot, so the first session said "nothing to compare yet" and
    only the second was useful. `init-hook` takes the first look itself.

