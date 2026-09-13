# Glass Box

An auditable replay of real AI agent runs. **[glassbox.run](https://glassbox.run)**

Agents do a real piece of work once: they plan it, call real tools, and stop to
ask a person before anything with real consequences. Every step is captured as
it happens. This site replays it, and at each point where a person had to
decide something you can watch the answers that were not given.

Nothing calls a model when you load the page. The intelligence already
happened, for real, and got captured. What runs live is the interaction design
around the recording.

The vocabulary the field is settling on for this is **delegate, monitor,
approve, interrupt, refine**. That is a better description of what this
demonstrates than "chat with an agent".

## What is recorded

| Flight | Agents | Ends in |
| --- | --- | --- |
| Research three competitors, draft a positioning brief | 5 | A brief filed into this repository |
| Redesign a landing page hero, open a pull request | 4 | Two live pull requests on [glass-box-demo](https://github.com/pork1977/glass-box-demo) |

Both are real captures. You can open
[the raw trace](public/flights/competitor-brief.json) and check it against what
you just watched.

## Three answers, not two

Approve and decline are the obvious pair, and they miss the answer people give
most often at work: yes, but change this first.

Approving with a change is a genuinely different third answer, because the
payload that runs is not the one the agent proposed and the agent has to carry
on from a decision it did not make. The trace records both versions of the
action and what moved between them.

Every answer that was not given gets its own branch: a real re-run from the
saved conversation state just before the gate, not a guess at what might have
happened. One gate with three answers is three real endings.

## What it costs

Anthropic's published September 2026 rates. Claude Sonnet 5 is $2/MTok in and
$10/MTok out, cache reads a tenth of that; Claude Opus 5, which the planner
uses, is $5 and $25.

| Item | Cost |
| --- | --- |
| Recording the competitor brief, three branches | $0.25 |
| Recording the hero redesign, three branches | $0.14 |
| Serving the replay to any number of visitors, forever | $0 |
| Hosting | $0 |

The first recording cost $1.24 before prompt caching was switched on. Caching
is not automatic: it needs a breakpoint on the system block, which covers the
tool schemas, and a rolling one on the last message. With it, a run that sends
457,000 input tokens pays for 3,000 of them.

Serving costs nothing because the site is static JSON and a client-side
player. There is no server to run up a bill and no way for a visitor to spend
anything of mine, which is the whole reason this is a recording rather than a
live agent behind a public text box.

## Running it

```bash
npm install
npm run dev          # http://localhost:3300
```

Recording needs `ANTHROPIC_API_KEY` in `.env.local`. The GitHub flight also
needs `GLASSBOX_SANDBOX_REPO` and `GLASSBOX_GITHUB_TOKEN`, where the token is
fine-grained and scoped to that one throwaway repository.

```bash
npm run record -- --dry-run              # scripted, costs nothing
npm run record                           # the real thing
npm run record -- --scenario=hero-redesign
npm test                                 # the redaction tests
```

A dry run writes to `.dry-run/flights/` and never touches the published ones. A
real capture is never overwritten by placeholder data.

## How it is put together

```
src/lib/trace/schema.ts       the trace format, v1
src/lib/trace/select.ts       pure reads: what is true at time t on branch b
src/lib/trace/validate.ts     a trace is untrusted until it passes this
src/components/Player.tsx     owns the playhead and the active branch
src/components/Graph.tsx      the scene: agents as light, tool calls as trails
src/components/Timeline.tsx   the scrubber, drawn by event density
recorder/engine.ts            the agent loop, the gates and the forks
recorder/sandbox.ts           the one checkout an agent can reach
recorder/redact.ts            scrubbing, with tests
public/flights/*.json         one file per flight, served as a static asset
```

**One source of truth for time.** The player holds a playhead in milliseconds
and an active branch id. Everything on screen is derived from those two values
by pure functions, so scrubbing backwards costs the same as playing forwards
and never replays a side effect.

**Branches share history.** An alternate branch records where it forked and
stores only the events after that point, the way a git branch shares history up
to the commit it split from.

**The loop is hand-written, over the Messages API.** Not the Claude Agent SDK,
which needs Node, a filesystem and a subprocess and so could never run in a
browser. The same loop records today and becomes live mode later, rather than
two implementations drifting apart.

## What an agent can reach

Safety comes from the tool list, not from the prompt. An agent cannot call a
tool that is not on its allowlist, however it is talked to, and the validator
rejects any trace containing a call an agent was not allowed to make.

The GitHub flight works inside one throwaway repository, cloned fresh per
recording. Every path an agent passes is resolved and checked to be inside that
checkout, so `../../../.env.local` returns an error rather than a key. The
token is fine-grained and cannot see any other repository: verified, not
assumed.

Two rules were added after a recording went wrong, and both are worth keeping:

- **The build is protected.** An early run replaced fifty lines of checks with
  `console.log("hello world, exiting 0")` and reported that the build passed. A
  build an agent can edit is not a build, so `build.js`, `package.json` and
  `.github/` refuse writes.
- **Only files an agent actually wrote are committed.** `git add -A` swept an
  earlier agent's changes into a later agent's commit, producing a pull request
  whose description honestly denied making a change that was in its own diff.

## Redaction

A trace holds real requests and responses, so it can pick up an auth header, a
token in a URL, or a whole scraped page. Everything is scrubbed before it is
written and checked again afterwards, and a trace that still contains something
key-shaped is refused rather than published. `npm test` covers the rules,
including one that plants a key and asserts the writer refuses.

## Licence

MIT.
