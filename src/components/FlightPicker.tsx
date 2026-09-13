"use client";

/**
 * The short list a visitor picks from before anything plays.
 *
 * Deliberately the first thing on screen rather than auto-playing a flight:
 * choosing what to watch is what makes the rest feel like an instrument
 * instead of a video, and it is the moment to be honest that these are
 * recordings.
 */

import AboutHelp from "./AboutHelp";
import type { FlightSummary } from "@/lib/trace/schema";
import { formatClock } from "@/lib/trace/select";

export default function FlightPicker({
  flights,
  onPick,
}: {
  flights: FlightSummary[];
  onPick: (flight: FlightSummary) => void;
}) {
  return (
    <div className="picker">
      <div className="picker-inner">
        <header>
          <h1>Glass Box</h1>
          <p className="lede">
            Watch AI agents do a real piece of work: plan it, use real tools,
            and stop to ask a person before anything with real consequences.
            Every flight below already happened. Nothing here is simulated, and
            nothing calls a model while you watch.
          </p>
          <AboutHelp />
        </header>

        <span className="eyebrow mono">Recorded flights</span>

        <ul className="flight-list">
          {flights.map((flight) => (
            <li key={flight.id}>
              <button className="flight" onClick={() => onPick(flight)}>
                <span className="row-top">
                  <span className="title">{flight.title}</span>
                  {flight.placeholder && (
                    <span className="badge placeholder">Placeholder</span>
                  )}
                </span>
                <span className="prompt mono">{flight.prompt}</span>
                <span className="meta mono">
                  {flight.agentCount} agents
                  <span className="dot">·</span>
                  {flight.decisionCount === 1
                    ? "1 human decision"
                    : `${flight.decisionCount} human decisions`}
                  <span className="dot">·</span>
                  {formatClock(flight.durationMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="footnote">
          A placeholder flight is sample data written by hand, not a capture.
          It says so in the player too, and it disappears from here once the
          real recording replaces it.
        </p>
      </div>
    </div>
  );
}
