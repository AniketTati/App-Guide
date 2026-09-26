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
90. **It is installable today without claiming an npm name.** **[CORRECTED BY #92]**
    npx runs a package
    straight from a public GitHub repo, which is reversible where publishing is
    not. The non-developer install was run end to end through it: verified the
    install, took the first look, and the next agent session produced a real
    receipt. About 15s the first time, 2.5s per hook run after — most of that
    is the network check against GitHub, not the tool.
91. **The first session now produces a real receipt.** **[CORRECTED BY #92]**
    Installing previously
    took no snapshot, so the first session said "nothing to compare yet" and
    only the second was useful. `init-hook` takes the first look itself.

## 18. Getting the receipt in front of a person

92. **Every receipt before this was invisible inside Claude Code.** Claude Code
    sends a Stop hook's plain stdout to its debug log; only a handful of events
    turn plain stdout into context or display, and Stop is not one of them. The
    hook printed the receipt that way, and every test passed because the tests
    ran the command directly, never through Claude Code. #90 and #91 measured
    the command, not what a person sees. This repository's own session shows
    it: the old hook ran after 22 replies, and its output went into the
    transcript and nowhere a reader looks.
93. **Two hooks, each on the one channel documented to reach its reader.** The
    Stop hook prints JSON whose `systemMessage` is shown to the user, and leaves
    the same report in `.appguide/pending`. A UserPromptSubmit hook, whose plain
    stdout is injected into Claude's context, hands that copy over with the
    person's next message and deletes it. That is what makes "explain #1" mean
    something. Stop's `decision: "block"` and its `additionalContext` were
    rejected: both keep the conversation going, which would put Claude back to
    work after every reply. The prompt hook is a `cat`, never `npx`, because it
    blocks the person's prompt while it runs.
94. **It speaks once per distinct receipt.** A Stop hook fires after every
    reply, and the same unreviewed list after each one is wallpaper. A digest
    of the last receipt shown is kept; the mark does not move, so nothing is
    lost, only not repeated. `seen` clears it, so the next report speaks even
    when it is an all-clear.
95. **Commands find their project instead of trusting the current folder.**
    Claude Code runs hooks in whatever folder Claude last moved into, and the
    commands Claude runs start there too — without `CLAUDE_PROJECT_DIR`, which
    only hooks receive. After `cd web && npm install`, the next receipt would
    have been a first look at `web/`, with Claude's copy left where the prompt
    hook never reads. Inside a session the root is now the nearest folder with
    notes or a repository, never above the session's project; elsewhere, the
    nearest folder with notes, never climbing out of a repository — so a
    git-tracked home folder is never scanned. Known limits: a worktree Claude
    enters mid-session gets its receipt, but Claude's copy lands where the
    prompt hook does not read; a worktree's first session is absorbed into its
    first look; the prompt hook needs `sh`, so not Windows.
96. **What was verified, and what was not.** **[UPDATED BY #97]** A simulation fed the hooks Claude
    Code's documented stdin payloads and applied its documented stdout parsing:
    shown once, handed to Claude once, silent on repeat, cleared by `seen`.
    Claude Code 2.1.266, run headless on a test project, loaded the project's
    hooks and ran the prompt hook, then stopped at "Not logged in" before any
    reply. The desktop app starts Claude Code with project settings enabled, so
    the hooks run there. **Not yet seen: the receipt rendered in a live session,
    and Claude answering "explain #1" from the copy.** This repository's own
    hooks now use the new form, so its next session is that test.
97. **Seen live — Claude's half confirmed, the person's half recorded.** In
    this repository's own session, the message after a receipt arrived with
    Claude's copy attached, and Claude Code recorded the receipt as a
    `hook_system_message`, the entry it makes for a message shown to the user.
    Whether the desktop app draws that entry has not been confirmed by eye.
98. **Nothing promoted means a glance, not a list.** The first live receipt
    spent its whole 26-line budget listing 17 new exports that needed no one.
    That is G4's failure seen from the other side: a receipt that is always
    full-length is read like one that always has a top-block entry — not at
    all. When nothing is promoted it is now the heading ("nothing worth a
    look"), the sentence, every blind spot, and the two commands: 8 lines
    instead of 26. The spec's all-clear had asked for this; the build drifted
    into listing everything. `--all` lists everything with no line budget —
    it used to end "+1 more: run --all", printed by `--all`. A session like
    this sends no desktop notification, and Claude's copy mentions `#1` only
    when the receipt prints numbers.
99. **The sentence must add up to the count.** Once the sentence is the only
    description, anything it omits is hidden behind a number. The plain one
    named URLs, data, services and packages and dropped exports and edits
    beside a count of 3 that included them. Both voices now end with "and
    made N other changes" for whatever the clauses did not name.

## 19. Building for a PM who maintains draft-legal

100. **The reader was silent about most of a real monorepo.** On draft-legal —
     907 JS/TS files, a Fastify API with ~290 routes, a Python agents service —
     it listed none of those routes and said nothing about why. It read only
     the root `package.json`, which in a workspace declares nothing real, so
     Fastify (declared in `apps/api`) was never flagged, and every member's
     dependency was reported as "imported but not in package.json" — 84 false
     alarms on one copy. Python was not counted at all. Now every manifest in
     the workspace is read and each dependency is credited to the one that
     declares it; languages present but unread are declared
     (`unsupported-language`); virtual environments are skipped by their
     `pyvenv.cfg`; and path aliases (`@/components`, tsconfig `paths`) and
     Node built-ins are no longer mistaken for packages. draft-legal's blind
     spots went from 84 false ones to exactly two true ones: Fastify and
     Python.
101. **Fastify is read, and measured against the app's own route table.**
     draft-legal generates a table of every route under `/api/v1` and the
     permission each needs from Fastify's `onRoute` hook, and one of its tests
     keeps that table equal to what Fastify registers: a runtime oracle the
     project maintains itself. Against it: **252 of 252 routes at their full
     paths, 252 of 252 permissions right**, the whole repository read in about
     two seconds. Two things got it there: following
     `register(plugin, { prefix })` through named imports across files, and
     following a check given a short name
     (`const adminGuard = requirePermission('configure', 'user')`) to what it
     stands for. The app's own hooks are left out of each route's checks, as
     Express's app-wide middleware is. Test files are skipped, because they
     register the same routes again at other prefixes.
102. **An app for a named PM, by the owner's choice.** The owner asked for an
     app a product manager uses to see, define and maintain draft-legal without
     a terminal. That brings back what §9 took off the roadmap — a GUI, a view
     of the product, flows (at L0/L1 only), Python — and makes an exception to
     #58 for this surface. It is recorded as the owner's choice for a named
     user, **not** as evidence of demand, with a reversal trigger: if, in the
     four weeks after the app is usable, the PM does not open it unprompted in
     three of them, open most merged branches in it first, and turn at least
     one finding into a task, it shrinks back to the receipt. The plan is
     [notes/pm-app.md](notes/pm-app.md).
103. **Home is what needs the PM; the map is context.** All five critiques said
     it. The recurring trigger is checking a branch before it merges and what
     is waiting on them; "what does the product do" is asked about monthly
     (#50). So Home is *waiting on you · in flight · changed on main*, Check is
     the main screen, and the product view is an outline in the product's own
     sidebar sections with a trace for the selected row — not a node graph,
     whose hubs (organization, user, audit log) would link everything to
     everything.
104. **Around their tools, in their words.** Tasks stay in their tracker (read
     in both of its formats), Claude stays in the Claude app and its worktrees,
     commits already name their tasks. The first draft's words collided with
     the product's own features — *Requests*, *Review*, *Rules* and *Actions*
     are all things in draft-legal — so the app says *task*, *Check*, *ground
     rules*, and shows routes as `PATCH /contracts/:id`. It never edits a
     tracked file without showing the change and asking; its own notes are
     excluded through `.git/info/exclude`, never by editing `.gitignore`.
105. **The app does not run Claude, in v1.** The Claude app already gives every
     session its own worktree. A run started from a Dock-launched app has no
     shell PATH, no `.env`, no Docker, and refuses every tool it cannot ask
     about — so "done" can mean no test ran. Anthropic's terms for scripted use
     changed three times in 2026. The hand-off is *Copy for Claude* and *Open
     Claude*; the app checks the worktree that results.
106. **"No check found", never "anyone".** Read against the code, 12 of the 26
     routes the reader first called unchecked verify a secret, token or
     signature inside the handler; one hook it counted as a check only records
     output; a guard ten modules install through `onRoute` was missed. So a
     hook counts only if its code can refuse a request, in-handler checks are
     named with their line, `onRoute` guards count, and an empty list reads as
     an absence measured, not a statement about who can reach the route.
107. **The app reads by commit, off the window's thread.** Agents edit in
     `.claude/worktrees/`, which the folder reader skips, and the checkout's
     branch switches would read as product changes. So the app's notes are
     commit SHAs — main's last-looked commit; each worktree against its
     merge-base — read through `git archive` and cached. A full read is ~3s and
     ~200 MB of syntax trees, so it runs in a utility process with per-file
     results cached by blob SHA. The CLI's receipt keeps its working-tree mark.
108. **Not a launch.** The PM app is built for one person. It is not published
     as a product, draft-legal's findings are never used as marketing, and the
     name — which collides with "in-app guides", a category every PM knows — is
     settled before anything is announced. A Developer ID and notarisation wait
     until a second PM asks.
109. **Tests are not the product, and transactions are.** Two silent misses
     the developer critique measured. Writes made through a transaction client
     — `prisma.$transaction(async (tx) => tx.x.update())`, or a function handed
     a `Prisma.TransactionClient` — were not read at all; they are now, with the
     alias scoped to its callback. Hand-written SQL (`$queryRaw` and friends,
     often a tagged template the reader never looked inside) produced nothing;
     each call is now a `raw-sql` blind spot. And test files were being read as
     the product: a test that inserts a user became "writes users", a fixture
     URL became an outside service. They are now left out of routes, data,
     outside calls and exports — draft-legal's outside services went from 16 to
     9 and its raw-SQL blind spots from 54 to 22, matching an independent count
     — while their package imports still count.
110. **Checks, measured.** With #106 implemented — a hook counts only if its
     code can refuse, followed through the functions it calls; a check we
     cannot read into still counts; guards installed by `onRoute` apply to the
     routes registered after them whose URL matches their pattern, evaluated
     from the code; a 401/403 inside a handler is named — draft-legal's 297
     routes read as: **12 with no check found, and they are exactly its public
     endpoints** (health, sign-up, invites, password reset, logout, the
     marketing contact form, telemetry). 208 `requirePermission` checks (the
     developer critique's independent count), 74 ownership guards, 49 checks
     inside handlers; the output recorder that had counted as a check no
     longer does. The permission table still matches 252 of 252. The wording
     follows: *no check found*, and *I found nothing that stops…*, never
     *anyone can…*.
111. **Home and Check read git and the tracker, never write them.** The engine
     lists every worktree with work not on main — the checkout included when
     it is on another branch; a worktree nested inside a checkout is never
     counted as that checkout's change — and checks one against its
     merge-base: the structural difference, uncommitted work included; the
     tasks its commits name, from the branch's own tracker, where its worklog
     is written; the tests it touched; the files it changed that its tasks do
     not name; and the files other work in flight also changed. Main's side is
     read from `git archive` into a scratch folder and cached by commit. On
     draft-legal it found S2 waiting on the PM, three pieces of work in
     flight, and two files the checkout's branch shares with an uncommitted
     worktree — the collision the PM asked to see before merging. A first
     Check takes ~9s while main's commit is read and cached, ~3.6s after.
112. **The app is built, and checked the way it runs.** Electron, as planned:
     the window's process never reads a repository; a utility process does,
     one request at a time; the page reaches it only through named calls that
     take ids. It opens on the product's Home and a Check per piece of work;
     the first look sets the baseline, as the receipt's first run does. Two
     things only running the packaged app showed. A browser preview cannot see
     the real bridge, so the app takes a test-only snapshot of its own window —
     the packaged app, against draft-legal, rendered Home from the real
     utility process. And a folder named `cache` in the app's data is the same
     folder as Chromium's own `Cache` on a Mac, whose file names ignore case,
     so its facts now live in `facts/`.
113. **The product, as one picture — read, not drawn from names.** Screens come
     from the router (JSX routes and route objects, nested paths joined,
     redirects and catch-alls left out), grouped by the sidebar's own sections.
     A screen needs sign-in when it sits under a wrapper whose code renders a
     `<Navigate>` — read from the wrapper, never its name. Each screen's calls
     go through the app's HTTP client (its `baseURL` joined on) and are
     matched to routes by method and path; the trail stops at the client and at
     modules three or more screens share, and a layout's calls are its own.
     A `${…}` glued onto a segment is a query string, not a parameter. Each
     route's handler is read for its data, transactions included, one call
     deep. Role tables are found by shape, every one returned under the name
     the code gives it, a table keyed by an enum first; who may call a route
     comes from its own check's arguments. On draft-legal: 38 screens in the
     sidebar's sections, 30 behind sign-in; 196 of 297 routes reached from a
     screen; data found for 274; nine roles; and one call that reaches no
     route — `GET /api/v1/approvals`, from the contract page.
114. **Product and Who can do what are built on main, not the checkout.** The
     product view reads main's commit — what Home counts — into a scratch
     folder and caches the result by commit and by view version, so an
     updated app never shows a view an older one built. On draft-legal it
     answers the PM's own question from the code: who can approve a contract
     is whoever passes `POST /api/v1/approvals/:instanceId/decide`'s check —
     ADMIN, LEGAL_COUNSEL, LEGAL_OPS, FINANCE and APPROVER — and the route
     changes the approval, its steps, the contract and the audit log. A grant
     on everything shows in every row: leaving it out made ADMIN look like it
     could do nothing with clauses. Two requests for one view at once — the
     page asks from two screens — share one read, and every cache write uses
     its own temporary file; one shared name made the second writer's rename
     fail.
115. ~~**Asking for a change writes one thing, in the tracker's own shape.**~~ **[SUPERSEDED BY #123]** The
     PM says what should change, why, and when it is done, and picks where
     from Product. The app drafts a task: the next ID in the family the
     tracker used last, the tracker's field order, the picked screens and
     routes as Evidence with their files and lines — so the Check of the
     work that follows has a precise scope to compare against. It goes into
     a dated section before the log and summary a tracker keeps last. The
     exact text is on screen before anything is written, a task with no
     "done when" is refused, and writing it changes that file and nothing
     else. The brief for Claude names the task and the tracker's own cycle
     and adds what the code says about the picked items: who may call a
     route and what it changes. The development server never writes.
116. **The built app, critiqued three ways — and the facts came first.** A PM
     persona used it against draft-legal; a designer read every screen; a code
     review read the source. The worst finds were wrong facts, not looks:
     Home said one task waited on the PM when the tracker said three; a Check
     called a branch that changes the role table, the schema and Python
     "nothing that affects how your app is put together"; `git status` on
     every poll took each worktree's index lock, so Claude's own commit could
     fail; facts cached by an older build were diffed against a newer one;
     "checked" held while Claude kept editing the same files; an old
     worktree's copy of a task overrode the tracker; calls from a dialog three
     pages share were dropped; Ask could write text never shown, onto someone
     else's branch; and two saves at once could wipe what the app remembers.
     #117–#126 are the fixes, in that order of weight.
117. **The tracker, read as it is really written.** A list entry's bold can be
     followed by more of it (`— VERIFY-PENDING.** Found in the X3 review.`), a
     status can carry its reason (`BLOCKED (needs a decision)`), and a title
     can end in its severity (`(Low)`). The first shape alone dropped 56 of
     draft-legal's 126 list entries, two of them waiting on the PM. A
     tracker's closing "What's left" section is its latest word on each open
     task, so that line is shown instead of the reason written when the task
     was opened, which had gone stale. On draft-legal: 147 of 147 entries
     read, and waiting on the PM is exactly the three tasks the tracker's own
     "What's left" names.
118. ~~**"Only your own" written in a handler is a check.**~~ **[SUPERSEDED BY #130]** A 404 counts when the
     `if` that decides it hands the caller to a lookup — `mayTouch(req, id)`,
     or the caller's own identity, never their organisation, which every
     lookup is scoped by. Two routes on a feature branch checked a role's
     own scope this way, and the Check showed only their permission: the PM
     would have filed a leak that isn't there. On draft-legal's main the count
     of in-handler checks is unchanged (49), and no route with no check found
     gained one.
119. **A part three screens share is listed once, not dropped.** Crediting a
     shared module's calls to every screen made 32 pages look like they call
     `/auth`; dropping them filed `POST /contracts/upload` under "routes no
     screen calls". Each shared part — UploadModal, ContractEditor — is now
     listed once with the screens it appears on and the routes it calls, and
     a wrapper written in the routes file itself (an onboarding gate around
     the layout) is followed into the components it renders. Routes reached
     from a screen on draft-legal: 196 → 201.
120. **A Check never gives an all-clear over what it can't read.** Who may
     call a route now comes from the branch's own role table, and a change to
     that table is shown role by role ("FINANCE on renewal: was view, now
     view, approve"). The schema's tables and lists of values are compared
     before and after, and new migrations named. Routes that were there
     before but whose own lines changed are listed — "the API accepts
     `rejected`" is a change. Changed files in another language, or deploy
     settings, are named, and while any are there the headline says what it
     can't read instead of "nothing". A test repository whose branch changes
     only the role table, the schema and Python reads: "It changes what 1 role
     may do, adds 1 table and changes 1 table. It also changes Python (1
     file), which I can't read."
121. **A Check opens with a verdict, and says what to do next.** Under its
     one-sentence answer: the acceptance criteria written (or that there are
     none), whether it merges cleanly into main as it is now and with the
     other work it shares files with, whether it is pushed, and whether it
     touched tests. Then what people will notice — screens to try, role
     changes, calls to routes that don't exist — then the product changes,
     what it can't read, and last its tasks, with Claude's own words folded
     away. Mark checked, "ready — copy push and open a PR", "send back with
     notes" and the questions for Claude stay in a footer; a Check says so
     when the work moves while it is open. Merging is worked out by
     `git merge-tree`, with the objects it makes written to a scratch folder
     that reads the repository's own as an alternate — its object store is
     left as it was. (The first manual try, before that, left one
     unreferenced tree object in draft-legal's store; git's own clean-up
     removes it.)
122. **Reading never gets in Claude's way.** Every git read runs with
     `GIT_OPTIONAL_LOCKS=0`, so a status never takes a worktree's index lock,
     and with a time limit; a read stuck for five minutes restarts the
     reader instead of holding every screen, and a slow poll no longer stacks
     another behind it. A worktree deleted without `git worktree prune` is
     skipped, not read as an empty folder; one that shares no history with
     main is set aside with the reason instead of failing Home. `git archive`
     takes files in batches, and scratch copies a killed reader left are
     swept after an hour.
123. **Asking for a change writes only what was shown, only where it is safe.**
     Supersedes #115. A new ask starts a family of its own after the
     tracker's newest — FF after EE — kept for the day's section, never one
     any branch already uses; it is written the way the tracker's newest
     entries are (a list entry, on draft-legal), with a severity if the PM
     gives one. The preview is exactly the lines that would be added, section
     heading included. Copy for Claude comes first: the brief has Claude add
     the task in its own commit before any code. The app adds it itself only
     to a clean checkout of main that is up to date — otherwise it says why
     not — only if the preview the PM approved is still what it would write,
     and only if the file is unchanged just before the new version replaces
     it.
124. **"Checked" means as it was seen, and what the app remembers survives.**
     A piece of work's fingerprint is its commit and each uncommitted file's
     size and time, so an edit Claude makes after the PM checks it shows —
     not only a change in how many files. Saves run one at a time, each
     through its own temporary file, the last one kept as a backup; a file
     that can't be read is set aside and said, never saved over. Facts and
     product reads are cached in a folder named for the build of the reader
     that made them, and older builds' folders are removed.
125. **Work is named by what it is for, and found wherever it is.** A piece of
     work is named by its plan document's title, else its first task's, else
     its folder — a worktree with no commits yet is named by the plan
     document it added. Before a commit names a
     task, the tracker entries it added or changed are its tasks. Branches
     with commits not on main are listed too, local and origin's; those with
     no commit for three weeks sit apart, those whose changes are all on main
     already are left out, and overlap is counted only with work that's
     active. Finished work — committed, every task done — that the PM hasn't
     checked waits on them beside the tasks. Home says when main was last
     fetched, and starts counting again, and says so, if main's history was
     rewritten.
126. **One accent, one route line, the answer first.** The accent means "this
     needs you" and nothing else: buttons are ink, links and selection
     grey. Every route, on every screen, is one line — method, path with its
     `/api/v1` set back, who may call it in words ("all 9 roles · SALES_REP
     own only"), and where — that opens to its checks, roles and data. Home's
     headline is the answer ("3 tasks wait on you, and one piece of work is
     ready to check"). Routes with no check found can be marked "public on purpose" —
     the PM's call, kept by the app — and Home's count asks for attention
     only for the rest. Product can be viewed as one role; Who can do what
     also reads by screen ("SALES_REP isn't allowed 2 of Dashboard's 6
     calls" — not called a fault, since a screen may hide those); and a call
     that reaches no route, or any route, can become a task in one click.
127. **A second round: the PM again, and a code review of the fixes.** The PM
     found four of their five asks met or mostly met, and three facts still
     wrong: two tables counted as changed that had only gained links, a route
     called changed for two moved comment lines, and "can't tell until both
     are committed" where the files as they stood could be merged by hand. A
     review of the new code confirmed thirteen bugs — the worst, that adding
     a task from the installed app could never succeed. #128–#136 fix them.
128. **Ask adds what was shown — through the same door the app uses.** The main
     process checked Ask's input field by field and dropped the preview's
     hash and the severity, so every add was refused and every severity lost;
     the tests called the reader directly and never saw it. The check is now
     one shared function the app and the development server both use, and
     the test adds a task through it.
129. **The headline names everything the page lists.** Data a change starts or
     stops using, lists of allowed values, migrations in SQL or code, the
     schema's connection settings, screens removed, and screens that only run
     changed code all have words; "nothing changed" is said only when every
     list is empty. A field whose type is another model is a link, not a
     column: a table that only gains one hasn't changed — two, not four, on
     the branch the PM counted by hand. Lockfiles are versions, not settings.
130. **"Only your own" in a handler counts only if its lookup knows who is
     calling.** Supersedes #118. A 404 counts when the `if` deciding it hands
     a lookup the caller's own identity, or hands it the request and that
     lookup — followed up to two calls deep — reads the identity from it.
     A lookup handed the request that only reads its address is not a check:
     counting it hid an open route from "no check found". Draft-legal's
     counts are unchanged (49 on main), and the branch's ownership checks are
     still found through the shared guard they call.
131. **A route's own code is its registration and the handler it names.**
     Lines between two routes used to belong to the one above, so a comment
     moved above the next route, or a handler defined further down, blamed
     the wrong one. A change now counts for a route when it touches the call
     that registers it or the handler it names, wherever the file defines it,
     and comment-only changes count for none. What the code gained is said:
     "its own code changed · new in it: “rejected”".
132. **Uncommitted work gets a merge answer too.** Where either side isn't
     committed, each file both changed is merged with `git merge-file` on
     scratch copies — as the files are now, and said so. It found that two
     worktrees in flight would conflict in four files. `merge-tree` output is
     read strictly: an exit that isn't a conflict is "can't tell", never
     "conflicts in nothing", and a repository path with a colon is quoted
     for git. (A hand-run check of merge-tree support, not the app, wrote a
     few more unreferenced objects to draft-legal's store; git's clean-up
     removes them.)
133. **A task waiting on the PM is acted on where it is.** A VERIFY-PENDING
     task shows its remaining check as the entry writes it, and "It works" /
     "It doesn't" copy a brief that records what the PM saw in that entry and
     moves its status. A BLOCKED one shows its choice as written and "Record
     my decision" does the same. Neither drafts a new task.
134. **A plan is read the way the tracker is.** A register kept as a table —
     IDs, a status column — is a list of tasks; a releases table gives each
     release's items and what "done" means. The Check shows each release's
     progress and "done when", and the plan's notes on going live beside the
     migrations to run. On a real plan every release's count matched the
     PM's hand count but one — where a pipe inside a cell had split their row.
135. **Whether work is alive, and a verdict that doesn't overclaim.** Work
     shows whether Claude is editing now or when it last did, and warns — with
     a brief to commit — when hours of edits sit uncommitted. "Ready" needs the
     work to name its tasks; "pushed" means the branch is on GitHub under its
     own name; Home forgets where the PM was only if that commit is really
     gone; a reader restarted for taking too long doesn't fail the request
     after it; only products the PM added have state; a broken state file is
     kept aside even when its backup is read; and Home reads the forty newest
     branches from the last four months, not hundreds.
136. **Try it where it runs; brief Claude where it should work.** Screens to
     try open in that work's own running copy of the app — a server on this
     Mac, found with `lsof`, whose folder is that work's web app — and the
     task's own "Reported" line says what to try. Every brief says to work on
     a new branch from main, never the checkout's current one.
137. **The app opens on a map, not a page of lists.** The PM's verdict on the
     built app: it read like documents — they expected to see the product,
     check work on it, comment, and hand that to Claude. So the product is a
     canvas: each screen a card in its sidebar section, with where it leads
     (read from its links and `navigate()` calls), the data it changes and
     reads, parts many screens share, what runs behind the scenes, and a
     role switch that shades what that role can't use. A Check is the same
     map for the product as the work leaves it: new, changed, and only
     "touched" (it runs changed code) marked on the cards, the verdict in a
     strip across the top. Any card takes a note; the notes go to Claude as
     one brief, each with what the map knows about its card — on main as new
     tasks for the tracker, on a piece of work as changes to make there. The
     lists stay as the details of whatever is picked, and the full report is
     a click from the map. Drawn with React Flow (MIT); placement is worked out
     from the product, the same every time.
