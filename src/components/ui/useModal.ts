"use client";

// What every dialog does: focus moves into it when it opens, Tab and
// Shift+Tab stay inside it, Escape closes it (unless it is busy), and focus
// goes back to whatever opened it when it closes.

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModal(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  opts: { open?: boolean; busy?: boolean } = {}
): void {
  const open = opts.open ?? true;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(Boolean(opts.busy));
  busyRef.current = Boolean(opts.busy);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const items = () => Array.from(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Focus the first field marked autoFocus, else the first focusable thing.
    if (box && !box.contains(document.activeElement)) {
      const auto = box.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      (auto ?? items()[0] ?? box).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!busyRef.current) {
          e.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (e.key !== "Tab" || !box) return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !box.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, ref]);
}
