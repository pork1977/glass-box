"use client";

/**
 * The line between the flight log and the detail panel, made draggable.
 *
 * The panel below it holds whole tool payloads, so a fixed split leaves it too
 * short to read anything. Dragging is the obvious gesture; arrow keys do the
 * same thing for anyone not using a mouse, which is why this is a real
 * separator rather than a div with a cursor on it. Double click resets it.
 *
 * The height is written straight onto the panel as a CSS variable rather than
 * held in React state. A layout preference is exactly the kind of thing that
 * belongs on the DOM node, and it means dragging does not re-render the scene
 * sixty times a second.
 */

import { useCallback, useEffect, useRef } from "react";

const MIN_DETAIL = 90;
/* Measured against the whole panel, so this has to cover the header and the
   handle as well as leaving a few rows of log visible. */
const MIN_FEED = 190;
const DEFAULT_DETAIL = 260;
const STEP = 24;
const STORAGE_KEY = "glassbox.detailHeight";

function readSaved(): number {
  try {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN_DETAIL
      ? saved
      : DEFAULT_DETAIL;
  } catch {
    // Private windows and blocked site data both land here. Not a problem.
    return DEFAULT_DETAIL;
  }
}

function save(height: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(height));
  } catch {
    // The split still works, it just will not be remembered.
  }
}

export default function Splitter({
  containerRef,
}: {
  /** The panel the two sections live in, used to turn a pointer into a size. */
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const height = useRef(DEFAULT_DETAIL);

  const clamp = useCallback(
    (value: number) => {
      const box = containerRef.current?.getBoundingClientRect();
      const max = box ? Math.max(MIN_DETAIL, box.height - MIN_FEED) : 600;
      return Math.round(Math.min(Math.max(value, MIN_DETAIL), max));
    },
    [containerRef],
  );

  const apply = useCallback(
    (value: number, remember: boolean) => {
      const next = clamp(value);
      height.current = next;
      containerRef.current?.style.setProperty("--detail-h", `${next}px`);
      handleRef.current?.setAttribute("aria-valuenow", String(next));
      if (remember) save(next);
    },
    [clamp, containerRef],
  );

  // Restore the remembered split once, on mount.
  useEffect(() => {
    apply(readSaved(), false);
  }, [apply]);

  const fromPointer = useCallback(
    (clientY: number) => {
      const box = containerRef.current?.getBoundingClientRect();
      return box ? box.bottom - clientY : height.current;
    },
    [containerRef],
  );

  return (
    <div
      ref={handleRef}
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the detail panel"
      aria-valuenow={DEFAULT_DETAIL}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add("dragging");
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        apply(fromPointer(e.clientY), false);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        e.currentTarget.classList.remove("dragging");
        apply(fromPointer(e.clientY), true);
      }}
      onDoubleClick={() => apply(DEFAULT_DETAIL, true)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        apply(height.current + (e.key === "ArrowUp" ? STEP : -STEP), true);
      }}
    />
  );
}
