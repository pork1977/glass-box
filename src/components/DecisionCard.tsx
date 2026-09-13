"use client";

/**
 * Playback stops here because the real run stopped here. The card says who was
 * asking, what for, and what happens if the answer is no, then offers the
 * branch that was not taken.
 */

import type { Branch, Decision } from "@/lib/trace/schema";

export default function DecisionCard({
  decision,
  agentName,
  watching,
  alternates,
  onContinue,
  onSwitch,
}: {
  decision: Decision;
  agentName: string;
  /** The branch whose answer this path is following. */
  watching: Branch;
  alternates: Branch[];
  onContinue: () => void;
  onSwitch: (branchId: string) => void;
}) {
  const wasReal = watching.id === decision.takenBranchId;

  return (
    <div className="gate">
      <div className="card">
        <div className="who">
          <span>{agentName} asked a person</span>
          <span className="state">paused, {decision.risk} risk</span>
        </div>
        <div className="action">{decision.title}</div>
        <p className="reason">{decision.reason}</p>
        <p className="if-denied">If the answer is no: {decision.ifDenied}</p>
        <div className="outcome">
          {wasReal
            ? `Answered at record time: ${watching.label.toLowerCase()}.`
            : `You are watching the branch that did not happen: ${watching.label.toLowerCase()}. It was recorded by re-running from this exact point.`}
        </div>
        <div className="buttons">
          <button className="btn primary" onClick={onContinue}>
            Carry on
          </button>
          {alternates.map((branch) => (
            <button
              key={branch.id}
              className="btn"
              onClick={() => onSwitch(branch.id)}
            >
              {branch.kind === "primary"
                ? "Back to what really happened"
                : `See instead: ${branch.label.toLowerCase()}`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
