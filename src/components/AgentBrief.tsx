"use client";

/**
 * What this agent was told, the version it really ran with. Most agent demos
 * keep the prompts out of sight, which is exactly why showing them is worth
 * the panel.
 */

import type { Agent } from "@/lib/trace/schema";

export default function AgentBrief({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const definition = agent.definition;

  return (
    <div className="brief">
      <div className="brief-head">
        <div>
          <div className="heading">Agent brief</div>
          <div className="brief-name">{agent.name}</div>
        </div>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="brief-role">{agent.role}</p>

      {definition ? (
        <>
          <div className="brief-meta mono">
            <span>{definition.model}</span>
            {definition.effort && <span>effort: {definition.effort}</span>}
            {definition.version && <span>{definition.version}</span>}
          </div>

          <div className="heading">Tools it was allowed</div>
          {definition.tools.length ? (
            <ul className="tool-list mono">
              {definition.tools.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          ) : (
            <p className="brief-role">
              None. It can only plan and hand work to others.
            </p>
          )}

          <div className="heading">System prompt</div>
          <pre className="brief-prompt">{definition.systemPrompt}</pre>
        </>
      ) : (
        <p className="brief-role">
          This flight was recorded before agent briefs were captured.
        </p>
      )}
    </div>
  );
}
