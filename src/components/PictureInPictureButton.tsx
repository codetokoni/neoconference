"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * PictureInPictureButton
 *
 * Opens a Document Picture-in-Picture window (Chrome 116+, Edge) containing
 * a live clone of the currently-active speaker tile, allowing the user to
 * keep an eye on the call while multitasking in other windows.
 *
 * Graceful no-op on Firefox / Safari (button is hidden when unsupported).
 *
 * Keyboard shortcut: Alt+P toggles PiP.
 *
 * a11y: aria-pressed reflects active state; restores focus to the trigger
 * when the PiP window closes.
 */
type DocPipWindow = Window & {
  // documentPictureInPicture window is a normal Window plus close()/copy of
  // the parent document — no extra typing required.
};

type DocPipApi = {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<DocPipWindow>;
  window: DocPipWindow | null;
};

function getApi(): DocPipApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { documentPictureInPicture?: DocPipApi };
  return w.documentPictureInPicture ?? null;
}

function findActiveTile(): HTMLElement | null {
  // Prefer the speaking participant; fall back to the first focused tile,
  // then the first tile on screen.
  const speaking = document.querySelector<HTMLElement>(
    '.lk-participant-tile[data-lk-speaking="true"]'
  );
  if (speaking) return speaking;
  const focused = document.querySelector<HTMLElement>(
    ".lk-participant-tile.lk-focused, .lk-participant-tile[data-lk-focused='true']"
  );
  if (focused) return focused;
  return document.querySelector<HTMLElement>(".lk-participant-tile");
}

export default function PictureInPictureButton() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const pipRef = useRef<DocPipWindow | null>(null);
  const placeholderRef = useRef<Comment | null>(null);
  const movedTileRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSupported(getApi() != null);
  }, []);

  const restoreTile = useCallback(() => {
    const tile = movedTileRef.current;
    const placeholder = placeholderRef.current;
    if (tile && placeholder && placeholder.parentNode) {
      placeholder.parentNode.replaceChild(tile, placeholder);
    } else if (tile && tile.parentElement && tile.parentElement.ownerDocument !== document) {
      // PiP window closed while tile was inside — graceful drop.
      tile.remove();
    }
    movedTileRef.current = null;
    placeholderRef.current = null;
  }, []);

  const closePip = useCallback(() => {
    const win = pipRef.current;
    pipRef.current = null;
    if (win && !win.closed) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
    }
    restoreTile();
    setActive(false);
  }, [restoreTile]);

  const openPip = useCallback(async () => {
    const api = getApi();
    if (!api) return;
    const tile = findActiveTile();
    if (!tile) return;

    let pipWindow: DocPipWindow;
    try {
      pipWindow = await api.requestWindow({ width: 360, height: 240 });
    } catch {
      return;
    }
    pipRef.current = pipWindow;

    // Copy stylesheets so the cloned tile renders correctly in the PiP window.
    try {
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        try {
          const rules = Array.from(sheet.cssRules ?? []);
          const text = rules.map((r) => r.cssText).join("\n");
          if (text) {
            const style = pipWindow.document.createElement("style");
            style.textContent = text;
            pipWindow.document.head.appendChild(style);
          }
        } catch {
          // Cross-origin stylesheet — fall back to <link>
          if (sheet.href) {
            const link = pipWindow.document.createElement("link");
            link.rel = "stylesheet";
            link.href = sheet.href;
            pipWindow.document.head.appendChild(link);
          }
        }
      }
    } catch {
      /* ignore stylesheet copy failures */
    }

    // Style the PiP body to fill the window and center the tile.
    pipWindow.document.documentElement.style.height = "100%";
    pipWindow.document.body.style.cssText =
      "margin:0;padding:0;height:100%;background:#000;color:#fff;font-family:system-ui,sans-serif;display:flex;flex-direction:column;";
    pipWindow.document.title = "NeoConference — Picture-in-picture";

    // Move (not clone) the live tile so the video element keeps streaming.
    const placeholder = document.createComment("nc-pip-placeholder");
    if (tile.parentNode) {
      tile.parentNode.insertBefore(placeholder, tile);
    }
    placeholderRef.current = placeholder;
    movedTileRef.current = tile;

    const wrap = pipWindow.document.createElement("div");
    wrap.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;";
    wrap.appendChild(tile);

    const hint = pipWindow.document.createElement("div");
    hint.style.cssText =
      "padding:6px 10px;font-size:11px;opacity:0.7;text-align:center;background:#0008;";
    hint.textContent = "Close this window to return to the call";

    pipWindow.document.body.appendChild(wrap);
    pipWindow.document.body.appendChild(hint);

    const onPagehide = () => {
      pipWindow.removeEventListener("pagehide", onPagehide);
      restoreTile();
      pipRef.current = null;
      setActive(false);
      try {
        btnRef.current?.focus();
      } catch {
        /* ignore */
      }
    };
    pipWindow.addEventListener("pagehide", onPagehide);

    setActive(true);
  }, [restoreTile]);

  const toggle = useCallback(() => {
    if (active || pipRef.current) {
      closePip();
    } else {
      void openPip();
    }
  }, [active, openPip, closePip]);

  // Alt+P shortcut, ignored while typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "p" && e.key !== "P")) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Settings → Video tab can open/close PiP via this event.
  useEffect(() => {
    const onOpen = () => toggle();
    window.addEventListener("neoconf:pip:open", onOpen as EventListener);
    return () => window.removeEventListener("neoconf:pip:open", onOpen as EventListener);
  }, [toggle]);

  // Clean up on unmount (e.g. user leaves the room while PiP is open).
  useEffect(() => {
    return () => {
      if (pipRef.current && !pipRef.current.closed) {
        try {
          pipRef.current.close();
        } catch {
          /* ignore */
        }
      }
      restoreTile();
    };
  }, [restoreTile]);

  if (!supported) return null;

  return (
    <button
      ref={btnRef}
      type="button"
      data-room-chrome="true"
      onClick={toggle}
      aria-pressed={active}
      aria-keyshortcuts="Alt+P"
      title={active ? "Exit picture-in-picture (Alt+P)" : "Picture-in-picture (Alt+P)"}
      className="px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm inline-flex items-center gap-1.5"
    >
      <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
        {active ? "▣" : "▢"}
      </span>
      <span>{active ? "Exit PiP" : "PiP"}</span>
    </button>
  );
}
