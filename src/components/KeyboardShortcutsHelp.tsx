"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";

/**
 * KeyboardShortcutsHelp
 *
 * World-class keyboard-shortcut cheatsheet, on par with Zoom / Google Meet / Jitsi.
 *
 * Opens with:
 *   - "?" (Shift+/)
 *   - Ctrl/Cmd + /
 *   - Programmatically via the "ksh:open" CustomEvent on window
 *
 * Closes with: Esc, backdrop click, or the dedicated Close button.
 *
 * Safety / a11y:
 *   - Listener is ignored while focus is in input / textarea / contenteditable / select,
 *     so it never hijacks chat typing or name fields.
 *   - role="dialog", aria-modal, aria-labelledby, focus trap, focus restoration.
 *   - Platform-aware modifier label (Cmd on macOS, Ctrl elsewhere).
 *   - Respects prefers-reduced-motion (no fade animation).
 *   - Print-friendly: prints as a clean reference card.
 */

type Shortcut = {
  keys: string[];
  label: string;
};

type Group = {
  title: string;
  items: Shortcut[];
};

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";
const SHIFT = "Shift";

function buildGroups(): Group[] {
  return [
    {
      title: "Meeting",
      items: [
        { keys: ["M"], label: "Toggle microphone" },
        { keys: ["V"], label: "Toggle camera" },
        { keys: ["Space"], label: "Push-to-talk (hold)" },
        { keys: [ALT, "P"], label: "Picture-in-Picture" },
        { keys: ["S"], label: "Share screen" },
        { keys: [MOD, "D"], label: "Leave meeting" },
      ],
    },
    {
      title: "Panels",
      items: [
        { keys: ["C"], label: "Open chat" },
        { keys: ["P"], label: "Open people" },
        { keys: ["W"], label: "Open whiteboard" },
        { keys: ["R"], label: "Reactions" },
        { keys: ["H"], label: "Raise / lower hand" },
        { keys: ["L"], label: "Toggle live captions" },
      ],
    },
    {
      title: "View",
      items: [
        { keys: ["F"], label: "Fullscreen" },
        { keys: ["G"], label: "Toggle grid / speaker view" },
        { keys: ["T"], label: "Spotlight focused tile" },
        { keys: ["?"], label: "Show this help" },
        { keys: ["Esc"], label: "Close dialogs / panels" },
      ],
    },
  ];
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 28,
        height: 24,
        padding: "0 7px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(255,255,255,0.06)",
        color: "#f6f7fb",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1,
        boxShadow:
          "inset 0 -1px 0 rgba(0,0,0,0.35), 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {children}
    </kbd>
  );
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export default function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const groups = useMemo(() => buildGroups(), []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const openDialog = useCallback(() => {
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      if (active instanceof HTMLElement) openerRef.current = active;
    }
    setOpen(true);
  }, []);

  // Global keyboard listener: "?" or Ctrl/Cmd+/ opens, ignored in editable fields.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc handled by dialog listener while open
      if (open) return;
      if (isEditableTarget(e.target)) return;
      const isQuestionMark =
        e.key === "?" || (e.key === "/" && e.shiftKey);
      const isModSlash =
        e.key === "/" && (e.ctrlKey || e.metaKey) && !e.shiftKey;
      if (isQuestionMark || isModSlash) {
        e.preventDefault();
        openDialog();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openDialog]);

  // Programmatic open via CustomEvent so a toolbar button can dispatch it.
  useEffect(() => {
    function onOpen() {
      openDialog();
    }
    window.addEventListener("ksh:open", onOpen as EventListener);
    return () =>
      window.removeEventListener("ksh:open", onOpen as EventListener);
  }, [openDialog]);

  // Focus management + Esc + focus trap while open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Initial focus
    const t = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 0);

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea'
        )
      ).filter((el) => !el.hasAttribute("aria-hidden"));
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
      // Restore focus to the element that opened the dialog
      const opener = openerRef.current;
      if (opener && document.contains(opener)) {
        try { opener.focus(); } catch { /* ignore */ }
      }
    };
  }, [open, close]);

  // prefers-reduced-motion (computed at render — fine, CSS rule handles dynamic too)
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <>
      {/* Floating "?" launcher — small, discoverable, bottom-right. */}
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        aria-keyshortcuts="?"
        title="Keyboard shortcuts (?)"
        onClick={openDialog}
        style={{
          position: "fixed",
          right: 14,
          bottom: 14,
          zIndex: 60,
          width: 36,
          height: 36,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.18)",
          background: "rgba(20,22,30,0.72)",
          color: "#f6f7fb",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
          backdropFilter: "blur(8px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ?
      </button>

      {open && (
        <div
          role="presentation"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(8, 10, 18, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            animation: reduceMotion ? undefined : "ksh-fade 140ms ease-out",
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ksh-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(820px, 100%)",
              maxHeight: "min(86vh, 760px)",
              overflowY: "auto",
              background: "linear-gradient(180deg, #1b1e29 0%, #14161e 100%)",
              color: "#f6f7fb",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
              padding: "20px 22px 22px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <h2
                id="ksh-title"
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: 0.2,
                }}
              >
                Keyboard shortcuts
              </h2>
              <button
                ref={closeBtnRef}
                type="button"
                onClick={close}
                aria-label="Close keyboard shortcuts"
                style={{
                  background: "transparent",
                  color: "#cbd0dc",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 8,
                  padding: "5px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Esc
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 18,
              }}
            >
              {groups.map((g) => (
                <section key={g.title} aria-labelledby={"ksh-g-" + g.title}>
                  <h3
                    id={"ksh-g-" + g.title}
                    style={{
                      margin: "0 0 8px",
                      fontSize: 12,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: 1.1,
                      color: "#9aa2b4",
                    }}
                  >
                    {g.title}
                  </h3>
                  <ul
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {g.items.map((s) => (
                      <li
                        key={g.title + ":" + s.label}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "6px 4px",
                          borderRadius: 6,
                        }}
                      >
                        <span style={{ fontSize: 13, color: "#dfe3ee" }}>
                          {s.label}
                        </span>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            flexShrink: 0,
                          }}
                        >
                          {s.keys.map((k, i) => (
                            <span
                              key={i}
                              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                            >
                              {i > 0 && (
                                <span style={{ color: "#6b7280", fontSize: 11 }}>+</span>
                              )}
                              <Kbd>{k}</Kbd>
                            </span>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            <p
              style={{
                margin: "16px 0 0",
                fontSize: 11,
                color: "#8a91a3",
                lineHeight: 1.5,
              }}
            >
              Shortcuts are ignored while typing in chat or any input. Press{" "}
              <Kbd>?</Kbd> any time to open this list. {IS_MAC ? "Cmd" : "Ctrl"} +{" "}
              <Kbd>/</Kbd> also works.
            </p>
          </div>

          <style>{`
            @keyframes ksh-fade {
              from { opacity: 0; transform: translateY(4px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            @media print {
              [role="dialog"][aria-labelledby="ksh-title"] {
                background: white !important;
                color: black !important;
                box-shadow: none !important;
              }
            }
          `}</style>
        </div>
      )}
    </>
  );
}
