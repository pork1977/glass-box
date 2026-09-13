"use client";

/**
 * The flight path: one mark per event, a warm mark where a person had to
 * decide, and a playhead you can drag. Drawn on a 2D canvas because there are
 * only ever a few hundred marks and a canvas scrubs without laying out DOM.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Decision, TraceEvent } from "@/lib/trace/schema";

const PAD = 18;

export default function Timeline({
  events,
  decisions,
  durationMs,
  playheadMs,
  forkFromMs,
  onScrub,
}: {
  events: TraceEvent[];
  decisions: Decision[];
  durationMs: number;
  playheadMs: number;
  forkFromMs: number | null;
  onScrub: (ms: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const pad = PAD * dpr;
    const usable = Math.max(1, w - pad * 2);
    const span = Math.max(durationMs, 1);
    const xFor = (ms: number) => pad + (ms / span) * usable;
    const lineY = h * 0.62;

    ctx.clearRect(0, 0, w, h);

    // the path itself
    ctx.strokeStyle = "rgba(110, 231, 192, 0.22)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(pad, lineY);
    ctx.lineTo(w - pad, lineY);
    ctx.stroke();

    // played portion
    ctx.strokeStyle = "rgba(110, 231, 192, 0.75)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(pad, lineY);
    ctx.lineTo(xFor(Math.min(playheadMs, span)), lineY);
    ctx.stroke();

    // where this path left the recorded primary run
    if (forkFromMs !== null) {
      const fx = xFor(forkFromMs);
      ctx.strokeStyle = "rgba(255, 176, 124, 0.35)";
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(fx, h * 0.12);
      ctx.lineTo(fx, h * 0.88);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const decisionTimes = new Set(decisions.map((d) => d.tMs));

    /*
     * Bucket by pixel column before drawing. A run can put dozens of events
     * inside a quarter of a second, and drawing them one on top of another
     * makes a busy stretch look like a single quiet tick. Height and
     * brightness carry the count instead, so the bar agrees with the log.
     */
    const columns = new Map<
      number,
      { count: number; played: number; decision: boolean; artifact: boolean }
    >();

    for (const event of events) {
      const x = Math.round(xFor(event.tMs));
      const column = columns.get(x) ?? {
        count: 0,
        played: 0,
        decision: false,
        artifact: false,
      };
      column.count += 1;
      if (event.tMs <= playheadMs) column.played += 1;
      if (event.kind === "decision" || decisionTimes.has(event.tMs)) {
        column.decision = true;
      }
      if (event.kind === "artifact") column.artifact = true;
      columns.set(x, column);
    }

    for (const [x, column] of columns) {
      const played = column.played > 0;
      // Two events should look busier than one, thirty should not be thirty
      // times taller, so the height follows the log of the count.
      const density = Math.min(1, Math.log2(column.count + 1) / 5);
      const tall = column.decision || column.artifact;
      const barH = h * (tall ? 0.26 : 0.1 + density * 0.18);

      let colour: string;
      if (column.decision) {
        colour = played
          ? "rgba(255, 176, 124, 0.95)"
          : "rgba(255, 176, 124, 0.4)";
      } else if (column.artifact) {
        colour = played
          ? "rgba(127, 217, 160, 0.9)"
          : "rgba(127, 217, 160, 0.35)";
      } else {
        const alpha = (played ? 0.4 : 0.16) + density * 0.45;
        colour = `rgba(110, 231, 192, ${alpha.toFixed(2)})`;
      }

      ctx.strokeStyle = colour;
      ctx.lineWidth = (column.decision ? 2 : 1.2) * dpr;
      ctx.beginPath();
      ctx.moveTo(x, lineY - barH);
      ctx.lineTo(x, lineY + barH * 0.45);
      ctx.stroke();
    }

    // playhead
    const px = xFor(Math.min(playheadMs, span));
    const glow = ctx.createLinearGradient(px - 26 * dpr, 0, px + 26 * dpr, 0);
    glow.addColorStop(0, "rgba(110, 231, 192, 0)");
    glow.addColorStop(0.5, "rgba(110, 231, 192, 0.22)");
    glow.addColorStop(1, "rgba(110, 231, 192, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(px - 26 * dpr, 0, 52 * dpr, h);

    ctx.strokeStyle = "rgba(232, 234, 242, 0.9)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(px, h * 0.1);
    ctx.lineTo(px, h * 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, h * 0.1, 3 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232, 234, 242, 0.95)";
    ctx.fill();
  }, [decisions, durationMs, events, forkFromMs, playheadMs]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const msFromEvent = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const usable = Math.max(1, rect.width - PAD * 2);
    const ratio = (clientX - rect.left - PAD) / usable;
    return Math.max(0, Math.min(1, ratio)) * Math.max(durationMs, 1);
  };

  return (
    <div className="timeline-wrap">
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onScrub(msFromEvent(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) onScrub(msFromEvent(e.clientX));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
    </div>
  );
}
