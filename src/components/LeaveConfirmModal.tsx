"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRoomContext } from "@livekit/components-react";

/**
 * LeaveConfirmModal
 *
 * Intercepts clicks on LiveKit's stock Leave / disconnect button (and any other
 * element flagged as a leave-trigger) and presents a confirmation dialog,
 * matching the safety net users expect from Zoom, Google Meet, and Jitsi.
 *
 * For hosts, an additional primary action — "End meeting for everyone" — calls
 * POST /api/events/[slug]/end to mark the event ended on the server, then
 * disconnects locally. Guests / cohosts only see "Leave meeting".
 *
 * Interception strategy:
 *   - One capture-phase click listener on document.
 *   - Matches when the click target (or any ancestor) is a known disconnect
 *     control: .lk-disconnect-button, [data-lk-disconnect-button], or a
 *     button whose accessible name is exactly "Leave" / "Disconnect".
 *   - On match, preventDefault + stopPropagation + stopImmediatePropagation,
 *     then open the modal. The original click never reaches LiveKit's handler.
 *   - When the user confirms, we call room.disconnect() ourselves and set a
 *     short-lived ref flag so the cleanup path doesn't recurse.
 *
 * Safety:
 *   - role="dialog", aria-modal, aria-labelledby, focus trap, focus restoration.
 *   - Default focus on Cancel (safer than confirming destructive action).
 *   - Esc and backdrop click both cancel.
 *   - prefers-reduced-motion respected.
 */

type Props = {
  /** Event slug used by /api/events/[slug]/end for host's "End for everyone". */
  eventSlug?: string | null;
  /** When true, expose the "End meeting for everyone" action. */
  isHost?: boolean;
};

function isLeaveControl(el: Element | null): boolean {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 6) {
    if (node instanceof HTMLElement) {
      // 1) LiveKit's stock disconnect button classnames / attributes
      if (node.classList.contains("lk-disconnect-button")) return true;
      if (node.hasAttribute("data-lk-disconnect-button")) return true;
      // 2) Our own opt-in marker
      if (node.hasAttribute("data-leave-trigger")) return true;
      // 3) Generic <button> with an accessible name of exactly "Leave" or "Disconnect"
      if (node.tagName === "BUTTON") {
        const aria = node.getAttribute("aria-label") || "";
        const text = (node.textContent || "").trim();
        const name = (aria || text).toLowerCase();
        if (name === "leave" || name === "disconnect" || name === "leave meeting") {
          return true;
        }
      }
    }
    node = node.parentElement;
    depth++;
  }
  return false;
}

export default function LeaveConfirmModal({ eventSlug, isHost }: Props) {
  const room = useRoomContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // When true, the next disconnect-button click is allowed to pass through
  // unmolested. We set this just before calling room.disconnect() so that any
  // re-entrant cleanup paths don't pop the modal again.
  const allowPassThroughRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setErrMsg(null);
  }, []);

  // Install the global capture-phase click interceptor.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (allowPassThroughRef.current) return;
      const target = e.target as Element | null;
      if (!isLeaveControl(target)) return;
      // Block the original handler.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Remember the opener for focus restoration on cancel.
      if (target instanceof HTMLElement) openerRef.current = target;
      else openerRef.current = null;
      setOpen(true);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Focus management, Esc, focus trap.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const t = window.setTimeout(() => {
      cancelBtnRef.current?.focus();
    }, 0);

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea'
        )
      );
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        const focusable = getFocusable();
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      const opener = openerRef.current;
      if (opener && document.contains(opener)) {
        try { opener.focus(); } catch { /* ignore */ }
      }
    };
  }, [open, close]);

  const doLocalDisconnect = useCallback(async () => {
    allowPassThroughRef.current = true;
    try {
      if (room && typeof room.disconnect === "function") {
        await room.disconnect();
      }
    } catch {
      /* room may already be disconnected — ignore */
    } finally {
      // Reset the flag after a tick so a future Join->Leave still triggers the modal.
      setTimeout(() => { allowPassThroughRef.current = false; }, 1000);
    }
  }, [room]);

  const handleLeave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await doLocalDisconnect();
      setOpen(false);
    } catch (err) {
      setErrMsg(
        err instanceof Error ? err.message : "Could not leave the meeting."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, doLocalDisconnect]);

  const handleEndForAll = useCallback(async () => {
    if (busy) return;
    if (!eventSlug) {
      // Without an event slug we can't call /end — fall back to local leave.
      return handleLeave();
    }
    setBusy(true);
    setErrMsg(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventSlug)}/end`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        }
      );
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `End-for-all failed (${res.status})${body ? ": " + body.slice(0, 140) : ""}`
        );
      }
      await doLocalDisconnect();
      setOpen(false);
    } catch (err) {
      setErrMsg(
        err instanceof Error ? err.message : "Could not end the meeting for everyone."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, eventSlug, doLocalDisconnect, handleLeave]);

  // prefers-reduced-motion
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={() => { if (!busy) close(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(8, 10, 18, 0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        animation: reduceMotion ? undefined : "lcm-fade 140ms ease-out",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lcm-title"
        aria-describedby="lcm-desc"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          background: "linear-gradient(180deg, #1b1e29 0%, #14161e 100%)",
          color: "#f6f7fb",
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          padding: "20px 22px 18px",
        }}
      >
        <h2
          id="lcm-title"
          style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700 }}
        >
          {isHost ? "Leave or end the meeting?" : "Leave the meeting?"}
        </h2>
        <p
          id="lcm-desc"
          style={{
            margin: "0 0 18px",
            fontSize: 13,
            color: "#aab0c0",
            lineHeight: 1.5,
          }}
        >
          {isHost
            ? "You can leave on your own and let others continue, or end the meeting for everyone now."
            : "You can rejoin from the same link as long as the meeting is still active."}
        </p>

        {errMsg && (
          <div
            role="alert"
            style={{
              margin: "0 0 12px",
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(220, 38, 38, 0.14)",
              border: "1px solid rgba(220, 38, 38, 0.35)",
              color: "#fecaca",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {errMsg}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: isHost ? "column" : "row",
            gap: 8,
            marginTop: 4,
          }}
        >
          {isHost && (
            <button
              type="button"
              onClick={handleEndForAll}
              disabled={busy}
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: 9,
                border: "1px solid rgba(220, 38, 38, 0.55)",
                background:
                  "linear-gradient(180deg, rgba(220, 38, 38, 0.95), rgba(185, 28, 28, 0.95))",
                color: "white",
                fontWeight: 600,
                fontSize: 13,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy ? "Ending…" : "End meeting for everyone"}
            </button>
          )}

          <div
            style={{
              display: "flex",
              gap: 8,
              flexDirection: "row",
              width: "100%",
              justifyContent: isHost ? "stretch" : "flex-end",
            }}
          >
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={() => { if (!busy) close(); }}
              disabled={busy}
              style={{
                flex: isHost ? 1 : "0 0 auto",
                padding: "9px 14px",
                borderRadius: 9,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "transparent",
                color: "#e6e9f2",
                fontWeight: 500,
                fontSize: 13,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleLeave}
              disabled={busy}
              style={{
                flex: isHost ? 1 : "0 0 auto",
                padding: "9px 16px",
                borderRadius: 9,
                border: "1px solid rgba(255,255,255,0.18)",
                background:
                  "linear-gradient(180deg, rgba(38, 42, 60, 0.95), rgba(28, 30, 44, 0.95))",
                color: "white",
                fontWeight: 600,
                fontSize: 13,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy && !isHost ? "Leaving…" : "Leave meeting"}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes lcm-fade {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
