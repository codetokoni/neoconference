"use client";

import { useEffect, useRef, useState } from "react";

/**
 * MobileMoreMenu — phone-only "More" overflow for the in-room ControlBar.
 *
 * Renders nothing on tablets/desktop (CSS hides .nc-mobile-more-btn above 640px).
 * On phone, mounts a "More" button into the LiveKit ControlBar via a portal-like
 * append at runtime, and toggles a popover containing Chat / Screen-share / Settings.
 *
 * We do NOT replace VideoConference's ControlBar — we just add one more peer
 * button and let CSS hide the originals on phone (see initials-overlay.css).
 */
export default function MobileMoreMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);

  // Move our button into the LiveKit ControlBar so it sits inline with mic/cam/leave.
  useEffect(() => {
    if (mountedRef.current) return;
    const btn = btnRef.current;
    if (!btn) return;
    const tryMount = () => {
      const bar = document.querySelector(".lk-control-bar");
      if (bar && btn.parentElement !== bar) {
        bar.appendChild(btn);
        mountedRef.current = true;
        return true;
      }
      return false;
    };
    if (tryMount()) return;
    const id = window.setInterval(() => {
      if (tryMount()) window.clearInterval(id);
    }, 300);
    return () => window.clearInterval(id);
  }, []);

  // Click triggers on the hidden originals — keeps LiveKit state in sync.
  const triggerHidden = (selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el) el.click();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="lk-button nc-mobile-more-btn"
        aria-label="More options"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ display: "none" }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          className="nc-mobile-more-popover"
          role="menu"
          style={{
            position: "fixed",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            background: "rgba(15, 23, 42, 0.96)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 8,
            minWidth: 200,
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreItem
            label="Chat"
            onClick={() => triggerHidden(".lk-chat-toggle")}
          />
          <MoreItem
            label="Share screen"
            onClick={() =>
              triggerHidden('.lk-control-bar [data-lk-source="screen_share"]')
            }
          />
          <MoreItem
            label="Settings"
            onClick={() => triggerHidden(".lk-settings-toggle")}
          />
        </div>
      )}
      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 49,
            background: "transparent",
          }}
        />
      )}
    </>
  );
}

function MoreItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: "#fff",
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 8,
        fontSize: 14,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "rgba(255,255,255,0.08)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}
