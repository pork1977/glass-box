# Glass Box

An auditable replay of real AI agent runs.

Real multi-agent runs are recorded once, with every plan, tool call and human
decision captured as it happens. The site then replays one: you scrub along the
timeline, open any tool call to see the real request and response, and at each
point where a person had to decide something you can flip to the branch that
did not happen.

Nothing calls a model when you load the page. The intelligence already
happened, once, for real, and got captured. What runs live is the interaction
design around the recording.

## Where this is up to

Phase 00 of six: the scaffold. The player is real and plays a flight end to
end, but the flight itself is hand-written sample data, not a recording. The
app says so in the top right until a real capture replaces it.

| Phase | What it is | State |
| --- | --- | --- |
| 00 | Scaffold: schema, timeline, scrubber, graph, branch toggle | done |
| 01 | Recording pipeline: run a scenario for real and capture the trace | done |
| 02 | Record the four flights, including every branch | next, needs a key |
| 03 | Playback polish against real trace data | flight picker and resizable panels done |
| 04 | Live mode on the visitor's own API key | |
| 05 | Ship: README, diagram, clip, public repo | |

## Running it

```bash
npm install
npm run dev
```

To record a flight, or to exercise the whole pipeline for free:

```bash
npm run record -- --dry-run   # scripted, costs nothing
npm run record                # the real thing, needs ANTHROPIC_API_KEY
npm test                      # the redaction tests
```

Then open http://localhost:3300. The port is set in the `dev` script because
port 3000 is already taken by another project on this machine. `npm run typecheck` and `npm run build` both
need to pass before anything is committed.

## How it is put together

```
src/lib/trace/schema.ts    the trace format, v1
src/lib/trace/select.ts    pure reads: what is true at time t on branch b
src/lib/trace/validate.ts  a trace is untrusted until it passes this
src/components/Player.tsx  owns the playhead and the active branch
src/components/Graph.tsx   the scene: agents as light, tool calls as trails
src/components/Timeline.tsx the scrubber
src/components/AgentBrief.tsx what an agent was told, and what it could touch
src/components/FlightPicker.tsx the list of flights, and the first thing on screen
src/components/SceneView.tsx  one graph pane, used twice in compare mode
src/components/Splitter.tsx   draggable divider between the log and the detail
recorder/                     the private pipeline that records a flight
public/flights/*.json      one file per flight, served as a static asset
```

Two rules hold the design together.

**One source of truth for time.** The player holds a playhead in milliseconds
and an active branch id. Everything on screen is derived from those two values
by pure functions, so scrubbing backwards costs the same as playing forwards
and never replays a side effect.

**Branches share history.** An alternate branch records where it forked from
its parent and only stores the events after that point, the same way a git
branch shares history up to the commit it split from. Playing a path means
walking the chain and taking, from each branch, the slice of time it owns.

## The trace format

One JSON file per flight. `agents` and `branches` describe the shape of the
run, `events` is the timeline, `decisions` are the points where a person was
asked, and `artifacts` are the real things the run produced. Every event
carries a branch id and a time in milliseconds from the start of the run.

Each agent also carries the brief it ran with: its system prompt, the tools it
was allowed to call, and the model behind it. The definitions live in their own
config file; the recorder stamps a copy into the trace when the agent starts, so
a viewer sees the version that really ran rather than whatever the config says
today. Click any agent in the scene to read it.

Safety comes from the tool list, not the prompt. The validator rejects a trace
containing a call an agent was never allowed to make, because that means either
the recorder or the allowlist is wrong.

The recorder in phase 01 writes this shape and runs the same validator the
player uses, so a broken flight fails at record time rather than in front of a
visitor.

## Before real recordings go in

A trace holds real request and response payloads. Those can carry auth
headers, tokens in URLs, internal paths and whole scraped pages. The recorder
needs a redaction pass, and a test that fails if anything key-shaped reaches a
trace file, before any capture is committed.

## Licence

MIT.
