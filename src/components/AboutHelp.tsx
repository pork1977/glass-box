"use client";

/**
 * The short version of "what is this and how do I use it", shown once on a
 * first visit and reachable from a button after that.
 *
 * It renders its own trigger, so wherever this component is placed is where
 * the button appears. Open and closed are kept on the DOM node rather than in
 * React state: it is one boolean about one element, and reading the
 * first-visit flag from storage during render would mean a different first
 * paint on the server and the client.
 */

import { useCallback, useEffect, useRef } from "react";

const SEEN_KEY = "glassbox.seenAbout";

function seenBefore(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // No storage means every visit is a first visit. Mildly annoying, not
    // broken, and better than an error.
    return false;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to do. The dialog will open again next time.
  }
}

export default function AboutHelp({ label = "How this works" }: { label?: string }) {
  const overlay = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const open = useCallback(() => {
    if (!overlay.current) return;
    overlay.current.hidden = false;
    closeButton.current?.focus();
  }, []);

  const close = useCallback(() => {
    if (!overlay.current) return;
    overlay.current.hidden = true;
    markSeen();
    trigger.current?.focus();
  }, []);

  // First visit only: open it, and remember that it has been seen so a second
  // visit goes straight to the flights.
  useEffect(() => {
    if (!seenBefore() && overlay.current) {
      overlay.current.hidden = false;
      closeButton.current?.focus();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlay.current && !overlay.current.hidden) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      <button ref={trigger} className="about-btn mono" onClick={open}>
        {label}
      </button>

      <div
        ref={overlay}
        className="about-overlay"
        hidden
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          className="about"
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
        >
          <div className="about-head">
            <h2 id="about-title">Watching an agent work</h2>
            <button ref={closeButton} className="btn" onClick={close}>
              Close
            </button>
          </div>

          <p>
            Every flight here is a recording of AI agents doing a real job:
            planning it, using real tools, and stopping to ask a person before
            anything with real consequences. It already happened. Nothing is
            simulated, and nothing calls a model while you watch.
          </p>

          <ol className="about-steps">
            <li>
              <span className="mono step-tag">play</span>
              Press play, or drag the line at the bottom to move through the run
              at your own pace.
            </li>
            <li>
              <span className="mono step-tag">read</span>
              Click an agent to see the exact instructions it was given and the
              tools it was allowed to use. Click any step in the log for the
              real request and response.
            </li>
            <li>
              <span className="mono step-tag">decide</span>
              Playback stops where the run stopped to ask a person. You can see
              what was decided, and take one of the answers that was not given.
            </li>
            <li>
              <span className="mono step-tag">compare</span>
              Or put two answers side by side and watch them come apart, using
              the compare menu next to the speed control.
            </li>
          </ol>

          <p className="about-note">
            A flight marked <strong>placeholder</strong> is sample data written
            by hand rather than a capture, and it says so in the corner while
            you watch it.
          </p>

          <p className="about-note">
            Recording once and replaying it is a deliberate choice. It means
            this page costs nothing to serve however many people open it, and
            nobody can point the agents at anything of their own.
          </p>
        </div>
      </div>
    </>
  );
}
