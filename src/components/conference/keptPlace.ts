'use client';

// Keep a long list of people where the reader left it.
//
// When a meeting's connection restarts, LiveKit drops every other person and
// adds them back a moment later, in a new order. A host taking the register
// by scrolling through hundreds of people was thrown back to the top each
// time: the list shrank to one, the scroll position fell to 0, and the people
// came back reshuffled (SA region, 2026-11-20: "the page refreshes on its own,
// taking me back to the beginning").
//
// Two parts:
// - keepOrder: people stay in the order they were first seen, so a restart
//   (or someone leaving and coming back) never reshuffles the list;
// - useKeptPlace: the list remembers the person at the top of the view, as
//   the reader scrolls, and puts them back there when the list changes.
//   Scrolling the list does not come from a tap while it is rebuilding, so
//   only scrolls that follow a touch, wheel or key count as the reader's.

import { useCallback, useLayoutEffect, useRef } from 'react';

/** The list in first-seen order. `seen` lives as long as the list (a ref). */
export function keepOrder<T extends { identity: string }>(seen: Map<string, number>, list: readonly T[]): T[] {
  for (const p of list) if (!seen.has(p.identity)) seen.set(p.identity, seen.size);
  return [...list].sort((a, b) => (seen.get(a.identity) ?? 0) - (seen.get(b.identity) ?? 0));
}

/** A scroll counts as the reader's within this long of their last touch, wheel or key. */
const READER_MS = 2500;
/** While the reader scrolls, only a move bigger than this is put back. */
const JUMP_PX = 150;

type Place = { id: string; offset: number };

function topOf(scroller: HTMLElement, item: Element): number {
  return item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function items(scroller: HTMLElement): Element[] {
  return Array.from(scroller.querySelectorAll('[data-place]'));
}

/** The first item still showing at the top of the view, and how far into it the view starts. */
export function placeIn(scroller: HTMLElement): Place | null {
  const top = scroller.scrollTop;
  if (top < 2) return null; // at the top: nothing to hold
  for (const item of items(scroller)) {
    const itemTop = topOf(scroller, item);
    if (itemTop + item.getBoundingClientRect().height > top) {
      return { id: item.getAttribute('data-place') || '', offset: top - itemTop };
    }
  }
  return null;
}

/**
 * Put `ref` on the scrolling element and spread `handlers` on it; mark each
 * item with data-place={identity}. `version` changes whenever the list does
 * (who is in it, or how it is laid out).
 */
export function useKeptPlace(version: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const place = useRef<Place | null>(null);
  const readerAt = useRef(0);
  const settling = useRef(false);

  const touched = useCallback(() => {
    readerAt.current = Date.now();
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el || settling.current || Date.now() - readerAt.current > READER_MS) return;
    place.current = placeIn(el);
  }, []);

  useLayoutEffect(() => {
    // The list just changed. A scroll it causes (a shorter list pulls the
    // view up) is not the reader's: ignore scrolls until it has settled.
    settling.current = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        settling.current = false;
      });
    });
    const el = ref.current;
    const p = place.current;
    if (el && p) {
      const item = items(el).find((x) => x.getAttribute('data-place') === p.id);
      // Not back yet (mid-restart): keep the place for when they are.
      if (item) {
        const want = Math.max(0, topOf(el, item) + p.offset);
        // While the reader is scrolling, setting the position would stop a
        // flick, and the place is a frame old anyway: step in only for a
        // jump (the list fell away under them), not for a few pixels.
        const reading = Date.now() - readerAt.current <= READER_MS;
        if (Math.abs(el.scrollTop - want) > (reading ? JUMP_PX : 1)) el.scrollTop = want;
      }
    }
    return () => cancelAnimationFrame(frame);
  }, [version]);

  return {
    ref,
    handlers: {
      onScroll,
      onTouchStart: touched,
      onTouchMove: touched,
      onWheel: touched,
      onPointerDown: touched,
      onKeyDown: touched,
    },
  };
}
