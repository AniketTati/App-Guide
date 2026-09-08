# The problem

Plain-language statement of what we're building and why. Written to be readable
by someone who wasn't in the conversation — no jargon, no diagrams.

The full design spec lives separately; this file is the anchor for *why*.

---

## The problem

You let an AI write your app. It writes a lot, fast. A few weeks in, nobody can
say what's actually in there. Not you, because reading code is slow and all
anyone ever shows you is "here are 40 lines that changed." Not the AI, because
every session it starts cold, reads the code, and guesses at why things are the
way they are — and guesses a little differently each time. So the thing slowly
gets worse and nobody notices until it's bad.

## What we'd build

A folder inside your project that holds a plain description of what the app is
*supposed* to be. Not documentation — documentation rots because nothing breaks
when it's wrong. More like a blueprint that the tooling actually checks. Plus an
app that shows you that blueprint as pictures: screens as wireframes, backend
logic as flow diagrams, both editable.

## The one idea underneath it

Two things sit side by side. What you said the app should be, and what the code
actually does — the second one read automatically out of the code. Then a third
thing constantly compares the two and shows you where they disagree.

That's the whole design. Neither side generates the other. The blueprint doesn't
produce the code, the code doesn't rewrite the blueprint. They both just exist,
and we keep pointing at the gaps.

## Why that gets you both directions for free

Every disagreement is a decision, and there are only two answers: *the code is
wrong* (which becomes a job for Claude) or *I changed my mind* (which updates the
blueprint).

Draw a screen that doesn't exist yet — that's a disagreement, and resolving it
means Claude builds it. Claude adds an endpoint you never drew — also a
disagreement, and resolving it means the picture gets updated.

Designing up front and catching drift afterwards turn out to be the same machine,
looked at from two sides.

## What using it feels like

Open your project, see a map of it — screens, flows, what connects to what.
Sketch a new screen like it's paper, talk about it, hand it to Claude. Claude
builds. You come back to a short list: six things changed, four match what you
drew, two don't. You fix or accept each one.

And the conversation about *why* stays stuck to the thing you were discussing, so
next time Claude reads the reasoning instead of re-inventing it.

## The hard part

Making sure the blueprint never lies — an out-of-date blueprint is worse than
none, because now the AI confidently trusts something wrong.

The answer is that every box in every picture points at a real function in a real
file. If that function vanishes or gets renamed, we know instantly. And if code
turns up that no box points at, we know that too — that's the AI growing a limb
nobody asked for.

## Where it stands

Pieces of this exist separately. Tools that read code into a map. Tools that
check "this folder may not import that one." Tools that feed a written spec to an
agent before it starts. Canvases you can draw on next to an agent.

What nobody has built is the middle: a drawing that points at real code, and a
check that runs *after* the AI is done rather than only before it starts.

---

Two audiences, one file: it keeps you from being clueless, and it keeps the model
from drifting.
