/**
 * Reading a trace: which events are on the path you are watching, and what
 * the world looked like at a given moment on it.
 *
 * All of it is pure. The player holds a playhead in milliseconds and asks
 * these functions what to draw, so scrubbing backwards costs the same as
 * playing forwards and never replays a side effect.
 */

import type {
  Agent,
  Branch,
  BranchId,
  Decision,
  Trace,
  TraceEvent,
} from "./schema";

export interface BranchPath {
  /** Root first, active branch last. */
  branches: Branch[];
  /** Every event on this path, sorted by time. */
  events: TraceEvent[];
  durationMs: number;
}

export function rootBranch(trace: Trace): Branch {
  const root = trace.branches.find((b) => b.parentId === null);
  if (!root) throw new Error(`trace ${trace.id} has no root branch`);
  return root;
}

function chainTo(trace: Trace, branchId: BranchId): Branch[] {
  const byId = new Map(trace.branches.map((b) => [b.id, b]));
  const chain: Branch[] = [];
  const seen = new Set<BranchId>();
  let cursor = byId.get(branchId);
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error(`branch cycle at ${cursor.id}`);
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}

/**
 * Walk the branch chain and keep, from each branch, only the slice of time it
 * owns: everything from where it forked until the next fork down the chain.
 */
export function resolvePath(trace: Trace, branchId: BranchId): BranchPath {
  const branches = chainTo(trace, branchId);
  const events: TraceEvent[] = [];

  branches.forEach((branch, i) => {
    const from = branch.forkFromMs ?? 0;
    const next = branches[i + 1];
    const until = next?.forkFromMs ?? Number.POSITIVE_INFINITY;
    for (const event of trace.events) {
      if (event.branchId !== branch.id) continue;
      if (event.tMs < from || event.tMs >= until) continue;
      events.push(event);
    }
  });

  events.sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  const durationMs = events.length ? events[events.length - 1].tMs : 0;
  return { branches, events, durationMs };
}

/** The decisions that actually sit on this path, in time order. */
export function decisionsOnPath(trace: Trace, path: BranchPath): Decision[] {
  const ids = new Set(
    path.events.filter((e) => e.decisionId).map((e) => e.decisionId as string),
  );
  return trace.decisions
    .filter((d) => ids.has(d.id))
    .sort((a, b) => a.tMs - b.tMs);
}

/** The recorded answers to a decision that are not the one being watched. */
export function otherBranchesFor(
  trace: Trace,
  decision: Decision,
  activeBranchId: BranchId,
): Branch[] {
  const active = new Set(chainTo(trace, activeBranchId).map((b) => b.id));
  return trace.branches.filter(
    (b) => decision.branchIds.includes(b.id) && !active.has(b.id),
  );
}

export interface AgentState {
  agent: Agent;
  /** Not started yet, running, or finished, as of the playhead. */
  status: "pending" | "active" | "done";
  /** A tool call started within the last moment, used for the pulse. */
  firing: boolean;
  /** The steps this agent takes on this path, in order. One tick each. */
  steps: TraceEvent[];
  /** How many of those have happened by now. */
  doneCount: number;
  /** The last thing this agent did, for the line under its name. */
  latest: TraceEvent | null;
}

const PULSE_MS = 900;

/**
 * What counts as a step worth a tick. Starting and finishing are bookkeeping,
 * and a tool result belongs to the call that caused it rather than standing on
 * its own, so neither gets a mark.
 */
const STEP_KINDS = new Set(["plan", "message", "tool_call", "decision", "artifact"]);

export function agentStatesAt(
  trace: Trace,
  path: BranchPath,
  tMs: number,
): AgentState[] {
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  const lastCall = new Map<string, number>();
  const latest = new Map<string, TraceEvent>();
  const steps = new Map<string, TraceEvent[]>();
  const doneCount = new Map<string, number>();

  for (const event of path.events) {
    if (!event.agentId) continue;

    if (STEP_KINDS.has(event.kind)) {
      const list = steps.get(event.agentId);
      if (list) list.push(event);
      else steps.set(event.agentId, [event]);
      if (event.tMs <= tMs) {
        doneCount.set(event.agentId, (doneCount.get(event.agentId) ?? 0) + 1);
      }
    }

    if (event.tMs > tMs) continue;

    latest.set(event.agentId, event);
    if (event.kind === "agent_start" && !started.has(event.agentId)) {
      started.set(event.agentId, event.tMs);
    }
    if (event.kind === "agent_end") ended.set(event.agentId, event.tMs);
    if (event.kind === "tool_call") lastCall.set(event.agentId, event.tMs);
  }

  return trace.agents.map((agent) => {
    const hasStarted = started.has(agent.id);
    const hasEnded = ended.has(agent.id);
    const since = lastCall.get(agent.id);
    const status: AgentState["status"] = hasEnded
      ? "done"
      : hasStarted
        ? "active"
        : "pending";
    return {
      agent,
      status,
      firing: since !== undefined && tMs - since < PULSE_MS,
      steps: steps.get(agent.id) ?? [],
      doneCount: doneCount.get(agent.id) ?? 0,
      latest: latest.get(agent.id) ?? null,
    };
  });
}

/** Everything already played, newest last. */
export function eventsUpTo(path: BranchPath, tMs: number): TraceEvent[] {
  return path.events.filter((e) => e.tMs <= tMs);
}

export function eventAt(path: BranchPath, tMs: number): TraceEvent | null {
  const played = eventsUpTo(path, tMs);
  return played.length ? played[played.length - 1] : null;
}

/**
 * The next decision strictly after fromMs, used to stop playback on a gate the
 * same way the real run stopped on it.
 */
export function nextDecisionAfter(
  decisions: Decision[],
  fromMs: number,
): Decision | null {
  return decisions.find((d) => d.tMs > fromMs) ?? null;
}

export function artifactsUpTo(trace: Trace, path: BranchPath, tMs: number) {
  const ids = new Set(
    eventsUpTo(path, tMs)
      .filter((e) => e.artifactId)
      .map((e) => e.artifactId as string),
  );
  return trace.artifacts.filter((a) => ids.has(a.id));
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
