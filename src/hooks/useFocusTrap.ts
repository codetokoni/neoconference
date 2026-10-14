'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside `ref` while `active`, and puts focus back
 * on whatever had it before (the button that opened the dialog) when it
 * closes, if that is still on screen. A dialog opened from a More menu has
 * no such button left: the menu item is gone by then, so focus stays put.
 *
 * Focus moves to the first focusable element on open. Don't put autoFocus
 * on anything inside: it takes focus before this effect runs, which then
 * records that field, not the button, as the opener. `onEscape`, if given,
 * runs on Escape from anywhere while active.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onEscape?: () => void,
) {
  // Read through a ref so a new callback each render doesn't re-run the
  // effect, which would take the dialog's own focused element as the opener.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
    (focusables()[0] ?? root).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeRef.current) {
        escapeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener && opener.isConnected && opener.getClientRects().length > 0) opener.focus();
    };
  }, [active, ref]);
}
