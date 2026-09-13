"use client";

/**
 * The player owns one thing: where the playhead is, and which branch it is on.
 * Everything on screen is derived from those two values, so there is no second
 * copy of "what is happening now" to drift out of step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, Trace, TraceEvent } from "@/lib/trace/schema";
import {
  agentStatesAt,
  decisionsOnPath,
  eventAt,
  formatClock,
  otherBranchesFor,
  resolvePath,
  rootBranch,
} from "@/lib/trace/select";
import SceneView from "./SceneView";
import Splitter from "./Splitter";
import Timeline from "./Timeline";
import DecisionCard from "./DecisionCard";
import AgentBrief from "./AgentBrief";
import AboutHelp from "./AboutHelp";

const SPEEDS = [1, 2, 4];
const TAIL_MS = 1200;

export default function Player({
  trace,
  onBack,
}: {
  trace: Trace;
  /** Back to the flight list. Absent when there is only one flight to show. */
  onBack?: () => void;
}) {
  const root = useMemo(() => rootBranch(trace), [trace]);
  const [branchId, setBranchId] = useState(root.id);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [briefAgentId, setBriefAgentId] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  // A manual scroll means the person is reading somewhere else, so following
  // stops until they stop scrolling. Held on a ref because it changes on every
  // wheel tick and nothing on screen depends on it.
  const scrolledAt = useRef(0);
  // A phone shows one panel at a time. On anything wider the class is inert
  // and both panels are visible, so this never has to know the screen size.
  const [phoneView, setPhoneView] = useState<"scene" | "log">("scene");

  const path = useMemo(() => resolvePath(trace, branchId), [trace, branchId]);
  const decisions = useMemo(
    () => decisionsOnPath(trace, path),
    [trace, path],
  );
  const activeBranch = path.branches[path.branches.length - 1];

  // Compare mode plays two branches against one playhead, so the clock has to
  // cover whichever runs longer.
  const comparePath = useMemo(
    () =>
      compareWith && compareWith !== branchId
        ? resolvePath(trace, compareWith)
        : null,
    [trace, compareWith, branchId],
  );
  const compareBranch = comparePath
    ? comparePath.branches[comparePath.branches.length - 1]
    : null;
  const endMs =
    Math.max(path.durationMs, comparePath?.durationMs ?? 0) + TAIL_MS;

  const agentNames = useMemo(
    () => new Map(trace.agents.map((a) => [a.id, a.name])),
    [trace],
  );

  /** The gate we are sitting on, if any. */
  const pending: Decision | null = useMemo(() => {
    if (compareWith) return null;
    const found = decisions.find(
      (d) => playheadMs >= d.tMs && !cleared.has(d.id),
    );
    return found ?? null;
  }, [decisions, playheadMs, cleared, compareWith]);

  // Playback. One frame loop, stopped by the end of the path or by a gate.
  const frame = useRef<number | null>(null);
  const last = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();

    const tick = (now: number) => {
      const delta = (now - last.current) * speed;
      last.current = now;

      setPlayheadMs((current) => {
        const next = current + delta;
        const gate = decisions.find(
          (d) => d.tMs > current && d.tMs <= next && !cleared.has(d.id),
        );
        if (gate) {
          setPlaying(false);
          setPhoneView("scene");
          return gate.tMs;
        }
        if (next >= endMs) {
          setPlaying(false);
          return endMs;
        }
        return next;
      });

      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [playing, speed, decisions, cleared, endMs]);

  const scrubTo = useCallback(
    (ms: number) => {
      setPlaying(false);
      setPlayheadMs(ms);
      // Moving the playhead by hand is a deliberate act, so gates already
      // behind it stop interrupting. They can still be reopened from the feed.
      setCleared((prev) => {
        const next = new Set(prev);
        for (const d of decisions) if (d.tMs <= ms) next.add(d.id);
        return next;
      });
    },
    [decisions],
  );

  const carryOn = useCallback(() => {
    if (!pending) return;
    setCleared((prev) => new Set(prev).add(pending.id));
    setPlaying(true);
  }, [pending]);

  const switchBranch = useCallback(
    (targetId: string) => {
      const target = trace.branches.find((b) => b.id === targetId);
      if (!target || !pending) return;
      const forkMs = target.forkFromMs ?? pending.tMs;
      setBranchId(targetId);
      setCompareWith(null);
      setPlayheadMs(forkMs);
      setCleared((prev) => new Set(prev).add(pending.id));
      setSelectedId(null);
      setPlaying(true);
    },
    [pending, trace.branches],
  );

  /**
   * Change branch from the transport, rather than only at the gate. The
   * playhead stays put when the new path reaches that far, because the two
   * paths are identical up to the fork and jumping would lose your place;
   * otherwise it lands on the fork, which is the first moment they differ.
   */
  const jumpToBranch = useCallback(
    (targetId: string) => {
      const target = trace.branches.find((b) => b.id === targetId);
      if (!target || targetId === branchId) return;

      const path = resolvePath(trace, targetId);
      const fork = target.forkFromMs ?? 0;
      const landing =
        playheadMs > path.durationMs ? fork : Math.max(playheadMs, fork);

      setBranchId(targetId);
      setCompareWith(null);
      setSelectedId(null);
      setPlayheadMs(landing);
      setCleared((prev) => {
        const next = new Set(prev);
        for (const d of decisionsOnPath(trace, path)) {
          if (d.tMs <= landing) next.add(d.id);
        }
        return next;
      });
    },
    [trace, branchId, playheadMs],
  );

  const openDecision = useCallback((decision: Decision) => {
    setPlaying(false);
    setPhoneView("scene");
    setPlayheadMs(decision.tMs);
    setCleared((prev) => {
      const next = new Set(prev);
      next.delete(decision.id);
      return next;
    });
  }, []);

  const restart = useCallback(() => {
    setBranchId(root.id);
    setCompareWith(null);
    setPlayheadMs(0);
    setCleared(new Set());
    setSelectedId(null);
    setPlaying(true);
  }, [root.id]);

  // Space to play or pause, arrows to step a second at a time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
        if (e.code !== "Space") return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.code === "ArrowLeft") scrubTo(Math.max(0, playheadMs - 1000));
      if (e.code === "ArrowRight") scrubTo(Math.min(endMs, playheadMs + 1000));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playheadMs, endMs, scrubTo]);

  const states = useMemo(
    () => agentStatesAt(trace, path, playheadMs),
    [trace, path, playheadMs],
  );

  const compareStates = useMemo(
    () =>
      comparePath ? agentStatesAt(trace, comparePath, playheadMs) : [],
    [trace, comparePath, playheadMs],
  );

  const current = eventAt(path, playheadMs);
  const selected: TraceEvent | null = selectedId
    ? (path.events.find((e) => e.id === selectedId) ?? null)
    : current;

  // Keep the current row in view. The log runs to hundreds of rows on a real
  // flight, and hunting for the highlighted one by hand is the whole
  // complaint. "nearest" rather than "center" so a row that is already visible
  // does not make the list jump.
  useEffect(() => {
    if (Date.now() - scrolledAt.current < 2000) return;
    // Instant, not smooth: during playback the row changes every second or so,
    // and a smooth scroll would still be animating when the next one arrives.
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const alternates = pending
    ? otherBranchesFor(trace, pending, branchId)
    : [];

  const otherBranches = useMemo(
    () => trace.branches.filter((b) => b.id !== branchId),
    [trace.branches, branchId],
  );

  const briefAgent = briefAgentId
    ? (trace.agents.find((a) => a.id === briefAgentId) ?? null)
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {onBack ? (
            <button className="back mono" onClick={onBack}>
              &larr; Flights
            </button>
          ) : null}
          <h1>Glass Box</h1>
          <span className="prompt">{trace.prompt}</span>
        </div>
        <div className="badges">
          <AboutHelp label="?" />
          {trace.placeholder && (
            <span className="badge placeholder">Placeholder trace</span>
          )}
          <span className="badge recorded">Recorded flight, not live</span>
          <span className="badge mono">{trace.model}</span>
        </div>
      </header>

      <div
        className={`stage ${comparePath ? "comparing" : ""} show-${phoneView}`}
      >
        <div className={comparePath ? "panes" : "single"}>
          <SceneView
            states={states}
            awaitingAgentId={pending ? pending.agentId : null}
            latest={current}
            branch={activeBranch}
            showHeader={Boolean(comparePath)}
            onSelectAgent={setBriefAgentId}
            onSeek={scrubTo}
          >
            {pending && !comparePath && (
              <DecisionCard
                decision={pending}
                agentName={agentNames.get(pending.agentId) ?? pending.agentId}
                watching={activeBranch}
                alternates={alternates}
                onContinue={carryOn}
                onSwitch={switchBranch}
              />
            )}
          </SceneView>

          {comparePath && compareBranch && (
            <SceneView
              states={compareStates}
              awaitingAgentId={null}
              latest={eventAt(comparePath, playheadMs)}
              branch={compareBranch}
              showHeader
              onSelectAgent={setBriefAgentId}
              onSeek={scrubTo}
            />
          )}
        </div>

        <aside
          ref={sideRef}
          className={`side ${briefAgent || selected ? "has-detail" : ""}`}
        >
          <h2>Flight log</h2>
          <div
            className="feed"
            ref={feedRef}
            onWheel={() => {
              scrolledAt.current = Date.now();
            }}
            onTouchMove={() => {
              scrolledAt.current = Date.now();
            }}
          >
            {path.events.map((event) => {
              const played = event.tMs <= playheadMs;
              const isDecision = event.kind === "decision";
              const classes = [
                "feed-item",
                played ? "played" : "pending",
                isDecision ? "decision" : "",
                selected?.id === event.id ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={event.id}
                  ref={selected?.id === event.id ? activeRowRef : undefined}
                  className={classes}
                  onClick={() => {
                    setSelectedId(event.id);
                    const decision = isDecision
                      ? decisions.find((d) => d.id === event.decisionId)
                      : undefined;
                    if (decision) openDecision(decision);
                    else scrubTo(event.tMs);
                  }}
                >
                  <span className="row">
                    <span className="t">{formatClock(event.tMs)}</span>
                    <span className="label">{event.label}</span>
                  </span>
                  {event.agentId && (
                    <span className="who">
                      {agentNames.get(event.agentId) ?? event.agentId}
                      {event.tool?.server && (
                        <span className="server-tag"> · server side</span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {(briefAgent || selected) && (
            <Splitter containerRef={sideRef} />
          )}
          {briefAgent && (
            <AgentBrief agent={briefAgent} onClose={() => setBriefAgentId(null)} />
          )}
          {selected && !briefAgent && (
            <div className="payload">
              <div className="heading">
                {selected.tool ? `${selected.tool.name} payload` : "detail"}
              </div>
              <pre>
                {selected.tool
                  ? JSON.stringify(
                      {
                        request: selected.tool.request,
                        response: selected.tool.response ?? "(pending)",
                      },
                      null,
                      2,
                    )
                  : (selected.detail ?? "No payload on this event.")}
              </pre>
            </div>
          )}
        </aside>
      </div>

      <div className="transport">
        <div className="transport-row">
          <div className="view-toggle" role="group" aria-label="Which panel to show">
            <button
              className={`btn ${phoneView === "scene" ? "on" : ""}`}
              onClick={() => setPhoneView("scene")}
            >
              Scene
            </button>
            <button
              className={`btn ${phoneView === "log" ? "on" : ""}`}
              onClick={() => setPhoneView("log")}
            >
              Log
            </button>
          </div>

          <button
            className="btn wide primary"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "Pause" : playheadMs >= endMs ? "Replay" : "Play"}
          </button>
          <button className="btn" onClick={restart}>
            Restart
          </button>
          <button
            className="btn mono"
            onClick={() =>
              setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])
            }
          >
            {speed}x
          </button>
          <span className="clock">
            {formatClock(playheadMs)} / {formatClock(endMs)}
          </span>
          {otherBranches.length > 0 && (
            <label className="compare-pick mono">
              compare
              <select
                value={compareWith ?? ""}
                onChange={(e) => {
                  setCompareWith(e.target.value || null);
                  setPlaying(false);
                }}
              >
                <option value="">off</option>
                {otherBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="branch-pill mono">
            branch
            <select
              className={activeBranch.kind === "alternate" ? "alternate" : ""}
              value={branchId}
              onChange={(e) => jumpToBranch(e.target.value)}
            >
              {trace.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Timeline
          events={
            comparePath ? [...path.events, ...comparePath.events] : path.events
          }
          decisions={decisions}
          durationMs={endMs}
          playheadMs={playheadMs}
          forkFromMs={
            compareBranch?.forkFromMs ?? activeBranch.forkFromMs
          }
          onScrub={scrubTo}
        />
      </div>
    </div>
  );
}
