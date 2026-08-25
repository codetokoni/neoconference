"use client";

import { useEffect, useRef, useState } from "react";

/**
 * MobileMoreMenu — phone-only "More" overflow.
 *
 * On screens <= 640px:
 *  - Mounts a "More" button into the LiveKit ControlBar at the bottom.
 *  - On tap, opens a popover listing every button currently in the
 *    custom .room-toolbar PLUS the LiveKit chat / share / settings
 *    buttons (which are CSS-hidden on phone).
 *  - Tapping an item proxies the click to the original (hidden) button,
 *    so all behaviour stays in sync with the rest of the app.
 *
 * The popover items are scanned at OPEN time so we always reflect the
 * current toolbar state (e.g. "Record" vs "Stop", host-only buttons).
 */
export default function MobileMoreMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MoreEntry[]>([]);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);

  // Move our "More" button into the LiveKit ControlBar so it sits inline
  // with mic/cam/leave.
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

  // Scan the toolbar(s) and build the menu list when opening.
  const scan = (): MoreEntry[] => {
    const list: MoreEntry[] = [];
    // 1) Buttons in the custom top toolbar
    const topBtns = document.querySelectorAll<HTMLElement>(
      ".room-toolbar > button"
    );
    topBtns.forEach((b) => {
      // Skip buttons the toolbar has explicitly opted out of the mobile
      // menu (e.g. the desktop-only "More" dropdown trigger — surfacing
      // that inside our own mobile More popover is nonsense).
      if (b.hasAttribute("data-mobile-skip")) return;
      const label = (b.textContent || "").trim();
      if (!label) return;
      list.push({ label, target: b });
    });
    // 2) LiveKit chat toggle (it's a button too)
    const chat = document.querySelector<HTMLElement>(".lk-chat-toggle");
    if (chat) list.push({ label: "Chat", target: chat });
    // 3) Screen share button inside the LiveKit ControlBar
    const share = document.querySelector<HTMLElement>(
      '.lk-control-bar [data-lk-source="screen_share"]'
    );
    if (share) list.push({ label: "Share screen", target: share });
    // 4) Settings toggle
    const settings = document.querySelector<HTMLElement>(".lk-settings-toggle");
    if (settings) list.push({ label: "Settings", target: settings });
    // De-dupe by label (keep first occurrence)
    const seen = new Set<string>();
    return list.filter((it) => {
      const key = it.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const handleToggle = () => {
    if (!open) setItems(scan());
    setOpen((v) => !v);
  };

  const handlePick = (entry: MoreEntry) => {
    try {
      entry.target.click();
    } catch {
      // ignore
    }
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
        onClick={handleToggle}
        style={{ display: "none" }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      {open && (
        <>
          <div
            aria-hidden
            className="nc-mobile-more-backdrop"
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 49,
              background: "rgba(0,0,0,0.35)",
            }}
          />
          <div
            className="nc-mobile-more-popover"
            role="menu"
            style={{
              position: "fixed",
              bottom: 80,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 50,
              background: "rgba(15, 23, 42, 0.98)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 14,
              padding: 8,
              minWidth: 220,
              maxHeight: "60vh",
              overflowY: "auto",
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.length === 0 && (
              <div style={{ color: "rgba(255,255,255,0.6)", padding: 12, fontSize: 13 }}>
                No additional actions available.
              </div>
            )}
            {items.map((it, i) => (
              <MoreItem key={i + ":" + it.label} label={it.label} onClick={() => handlePick(it)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

type MoreEntry = { label: string; target: HTMLElement };

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
        padding: "12px 14px",
        borderRadius: 10,
        fontSize: 15,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
      onTouchStart={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "rgba(255,255,255,0.10)";
      }}
      onTouchEnd={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}
