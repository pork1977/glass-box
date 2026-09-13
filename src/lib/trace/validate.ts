/**
 * A loaded trace is untrusted until it passes this. The recorder runs the same
 * check before it writes a file, so a broken flight fails at record time
 * rather than in front of a visitor.
 */

import { TRACE_SCHEMA_ID, type Trace } from "./schema";

export class TraceError extends Error {}

export function assertTrace(value: unknown, source: string): Trace {
  const problems = traceProblems(value);
  if (problems.length) {
    throw new TraceError(`${source}: ${problems.join("; ")}`);
  }
  return value as Trace;
}

export function traceProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["not an object"];
  const trace = value as Partial<Trace>;

  if (trace.schema !== TRACE_SCHEMA_ID) {
    problems.push(
      `expected schema ${TRACE_SCHEMA_ID}, got ${String(trace.schema)}`,
    );
    return problems;
  }
  for (const key of ["id", "title", "prompt", "recordedAt", "model"] as const) {
    if (typeof trace[key] !== "string" || !trace[key]) {
      problems.push(`missing ${key}`);
    }
  }
  for (const key of [
    "agents",
    "branches",
    "events",
    "decisions",
    "artifacts",
  ] as const) {
    if (!Array.isArray(trace[key])) problems.push(`${key} must be an array`);
  }
  if (problems.length) return problems;

  const agents = trace.agents!;
  const branches = trace.branches!;
  const events = trace.events!;
  const decisions = trace.decisions!;

  const agentIds = new Set(agents.map((a) => a.id));
  const branchIds = new Set(branches.map((b) => b.id));
  const decisionIds = new Set(decisions.map((d) => d.id));
  const artifactIds = new Set(trace.artifacts!.map((a) => a.id));

  for (const agent of agents) {
    const def = agent.definition;
    if (!def) continue;
    if (typeof def.systemPrompt !== "string" || !def.systemPrompt.trim()) {
      problems.push(`agent ${agent.id} has a definition with no system prompt`);
    }
    if (!Array.isArray(def.tools)) {
      problems.push(`agent ${agent.id} must list the tools it was allowed`);
    }
    if (typeof def.model !== "string" || !def.model) {
      problems.push(`agent ${agent.id} has a definition with no model`);
    }
  }

  const roots = branches.filter((b) => b.parentId === null);
  if (roots.length !== 1) {
    problems.push(`expected exactly 1 root branch, found ${roots.length}`);
  }

  for (const branch of branches) {
    if (branch.parentId !== null && !branchIds.has(branch.parentId)) {
      problems.push(`branch ${branch.id} has unknown parent ${branch.parentId}`);
    }
    if (branch.parentId !== null && typeof branch.forkFromMs !== "number") {
      problems.push(`branch ${branch.id} must say where it forks from`);
    }
    if (branch.decisionId && !decisionIds.has(branch.decisionId)) {
      problems.push(
        `branch ${branch.id} points at unknown decision ${branch.decisionId}`,
      );
    }
  }

  for (const event of events) {
    if (!branchIds.has(event.branchId)) {
      problems.push(`event ${event.id} is on unknown branch ${event.branchId}`);
    }
    if (event.agentId && !agentIds.has(event.agentId)) {
      problems.push(`event ${event.id} names unknown agent ${event.agentId}`);
    }
    if (event.decisionId && !decisionIds.has(event.decisionId)) {
      problems.push(
        `event ${event.id} names unknown decision ${event.decisionId}`,
      );
    }
    if (event.artifactId && !artifactIds.has(event.artifactId)) {
      problems.push(
        `event ${event.id} names unknown artifact ${event.artifactId}`,
      );
    }
    if (typeof event.tMs !== "number" || event.tMs < 0) {
      problems.push(`event ${event.id} has a bad timestamp`);
    }
  }

  // A trace claiming a call the agent was never allowed to make means either
  // the recorder or the allowlist is wrong, and both matter.
  const allowedBy = new Map(
    agents
      .filter((a) => a.definition)
      .map((a) => [a.id, new Set(a.definition!.tools)]),
  );
  for (const event of events) {
    if (event.kind !== "tool_call" || !event.tool || !event.agentId) continue;
    // Server-side work is Anthropic's, not the agent's choice: web search
    // runs its own code execution, and an allowlist cannot speak to that.
    if (event.tool.server) continue;
    const allowed = allowedBy.get(event.agentId);
    if (allowed && !allowed.has(event.tool.name)) {
      problems.push(
        `event ${event.id}: ${event.agentId} called ${event.tool.name}, which is not on its allowlist`,
      );
    }
  }

  for (const decision of decisions) {
    if (!decision.branchIds.includes(decision.takenBranchId)) {
      problems.push(
        `decision ${decision.id} does not list the branch that was taken`,
      );
    }
    for (const id of decision.branchIds) {
      if (!branchIds.has(id)) {
        problems.push(`decision ${decision.id} names unknown branch ${id}`);
      }
    }
  }

  return problems;
}
