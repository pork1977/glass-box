/**
 * Glass Box trace format, version 1.
 *
 * One JSON file describes one recorded flight: the agents that ran, every
 * event on the timeline, the points where a human had to decide something,
 * and the alternate branches that were recorded by re-running from a saved
 * conversation state.
 *
 * The recorder writes this shape. The player reads it. Nothing else is
 * allowed to become a second source of truth about what a flight is.
 */

export const TRACE_SCHEMA_ID = "glassbox.trace/1";

export type AgentId = string;
export type BranchId = string;

/**
 * What an agent was actually given before it ran: its instructions, the tools
 * it was allowed to touch, and the model behind it.
 *
 * The definitions live in their own config file that the recorder reads. This
 * is the copy stamped into the trace at the moment the agent started, so a
 * viewer sees the version that really ran rather than whatever the config says
 * today. Safety comes from `tools`, not from the prompt: an agent cannot call
 * something that is not on this list, however it is talked to.
 */
export interface AgentDefinition {
  /** The system prompt, verbatim. */
  systemPrompt: string;
  /** Every tool this agent was allowed to call. */
  tools: string[];
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * How many times this agent may come back for another turn. A planner that
   * delegates four times and reads four reports needs far more than a worker
   * that searches and writes once.
   */
  maxTurns?: number;
  /** Hash or version of the config the definition came from. */
  version?: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  /** One line on what this agent was asked to do. */
  role: string;
  /** The agent that spawned it, or null for the planner at the root. */
  parentId: AgentId | null;
  /** Absent only on hand-written sample data. Recorded flights always have it. */
  definition?: AgentDefinition;
}

/**
 * A branch is one recorded answer to one decision. The root branch holds the
 * whole run as it really happened, including the answer that was actually
 * given. An alternate branch shares history with its parent up to forkFromMs
 * and diverges after it, the same way a git branch shares history up to the
 * commit it split from.
 */
export interface Branch {
  id: BranchId;
  /** Shown on the branch toggle, e.g. "Approved, opened the PR". */
  label: string;
  kind: "primary" | "alternate";
  parentId: BranchId | null;
  /** Time on the parent branch's clock where this diverges. Null on the root. */
  forkFromMs: number | null;
  /** The decision this branch is an answer to. Null on the root. */
  decisionId: string | null;
  /** The answer this branch represents, e.g. "approve", "deny", "edit". */
  answer: string | null;
}

export type EventKind =
  | "plan"
  | "agent_start"
  | "agent_end"
  | "message"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "artifact";

export interface ToolPayload {
  name: string;
  /** The real request that was sent. */
  request: unknown;
  /** The real response that came back. Absent on a tool_call event. */
  response?: unknown;
  ok?: boolean;
  durationMs?: number;
  /**
   * True when Anthropic ran this rather than us. Web search is the obvious
   * case, and it runs code execution of its own under the hood, so these are
   * not calls the agent chose to make and the allowlist does not govern them.
   */
  server?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface TraceEvent {
  id: string;
  branchId: BranchId;
  /** Milliseconds from the start of the run, on the run's own clock. */
  tMs: number;
  kind: EventKind;
  agentId: AgentId | null;
  /** Short label, the one thing shown on the timeline. */
  label: string;
  detail?: string;
  tool?: ToolPayload;
  decisionId?: string;
  artifactId?: string;
  usage?: Usage;
}

export interface Decision {
  id: string;
  tMs: number;
  agentId: AgentId;
  /** What the agent wanted to do, in plain words. */
  title: string;
  /** Why it wanted to, and what it had already checked. */
  reason: string;
  /** What happens if the answer is no. */
  ifDenied: string;
  risk: "low" | "medium" | "high";
  proposedAction: { tool: string; input: unknown };
  /** The branch holding the answer that was really given at record time. */
  takenBranchId: BranchId;
  /** Every recorded answer, including the one above. */
  branchIds: BranchId[];
}

export interface Artifact {
  id: string;
  kind: "pull_request" | "deployment" | "issue" | "document";
  title: string;
  /** Where the real thing lives, when it is public. */
  url?: string;
  /** Short description of what was produced. */
  summary?: string;
  branchId: BranchId;
}

export interface Trace {
  schema: typeof TRACE_SCHEMA_ID;
  id: string;
  title: string;
  /** The task the run was given, verbatim. */
  prompt: string;
  /** ISO timestamp of when this was recorded. */
  recordedAt: string;
  model: string;
  /**
   * True while this file is hand-written sample data rather than a real
   * capture. The player shows it loudly. Recorded flights set it false.
   */
  placeholder: boolean;
  agents: Agent[];
  branches: Branch[];
  events: TraceEvent[];
  decisions: Decision[];
  artifacts: Artifact[];
  usage?: Usage;
}

/** One row in public/flights/index.json, for the flight picker. */
export interface FlightSummary {
  id: string;
  title: string;
  prompt: string;
  file: string;
  placeholder: boolean;
  agentCount: number;
  decisionCount: number;
  durationMs: number;
}
