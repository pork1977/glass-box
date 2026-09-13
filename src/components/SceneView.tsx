"use client";

/**
 * One graph and its caption. Used on its own for ordinary playback, and twice
 * side by side in compare mode, where both panes share a single playhead so
 * the two branches stay in step with each other.
 */

import dynamic from "next/dynamic";
import type { Branch, TraceEvent } from "@/lib/trace/schema";
import type { AgentState } from "@/lib/trace/select";

const Graph = dynamic(() => import("./Graph"), { ssr: false });

export default function SceneView({
  states,
  awaitingAgentId,
  latest,
  branch,
  showHeader,
  onSelectAgent,
  onSeek,
  children,
}: {
  states: AgentState[];
  awaitingAgentId: string | null;
  latest: TraceEvent | null;
  branch: Branch;
  /** Compare mode labels each pane. Single-pane playback does not need it. */
  showHeader: boolean;
  onSelectAgent: (agentId: string) => void;
  onSeek: (ms: number) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="scene">
      {showHeader && (
        <div
          className={`pane-head ${branch.kind === "alternate" ? "alternate" : ""}`}
        >
          <span className="mono tag">
            {branch.kind === "alternate" ? "did not happen" : "what happened"}
          </span>
          <span className="label">{branch.label}</span>
        </div>
      )}

      <Graph
        states={states}
        awaitingAgentId={awaitingAgentId}
        onSelectAgent={onSelectAgent}
        onSeek={onSeek}
      />

      <div className="now-label">
        <div className="kind mono">
          {latest ? latest.kind.replace("_", " ") : "ready"}
        </div>
        <div className="text">
          {latest
            ? latest.label
            : "Press play to run the flight. Click an agent to read its instructions."}
        </div>
      </div>

      {children}
    </div>
  );
}
