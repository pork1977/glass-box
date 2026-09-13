"use client";

/**
 * The whole site: a list of recorded flights, and the player for whichever one
 * you pick. Both the index and the traces are static JSON fetched from the
 * browser, so a visitor's page never talks to anything but a file. That is the
 * property the rest of the design depends on.
 */

import { useCallback, useEffect, useState } from "react";
import FlightPicker from "@/components/FlightPicker";
import Player from "@/components/Player";
import type { FlightSummary, Trace } from "@/lib/trace/schema";
import { assertTrace } from "@/lib/trace/validate";

export default function Home() {
  const [flights, setFlights] = useState<FlightSummary[] | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadIndex() {
      try {
        const res = await fetch("/flights/index.json");
        if (!res.ok) throw new Error(`flight index: ${res.status}`);
        const parsed = (await res.json()) as { flights?: FlightSummary[] };
        if (!parsed.flights?.length) throw new Error("no flights in the index");
        if (!cancelled) setFlights(parsed.flights);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    loadIndex();
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = useCallback(async (flight: FlightSummary) => {
    setLoading(flight.title);
    setError(null);
    try {
      const res = await fetch(flight.file);
      if (!res.ok) throw new Error(`${flight.file}: ${res.status}`);
      setTrace(assertTrace(await res.json(), flight.file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }, []);

  const backToFlights = useCallback(() => {
    setTrace(null);
    setError(null);
  }, []);

  if (error) {
    return (
      <div className="centred">
        <div>
          <p>That flight could not be loaded.</p>
          <p className="mono">{error}</p>
          {flights && (
            <button className="btn" onClick={backToFlights}>
              Back to the flights
            </button>
          )}
        </div>
      </div>
    );
  }

  if (trace) {
    return <Player trace={trace} onBack={backToFlights} />;
  }

  if (loading) {
    return (
      <div className="centred">
        <p className="mono">Loading {loading}...</p>
      </div>
    );
  }

  if (!flights) {
    return (
      <div className="centred">
        <p className="mono">Loading flights...</p>
      </div>
    );
  }

  return <FlightPicker flights={flights} onPick={pick} />;
}
