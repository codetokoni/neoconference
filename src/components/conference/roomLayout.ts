// src/components/conference/roomLayout.ts
//
// Two rules of the meeting room's layout, kept apart from React and
// LiveKit so the browser tests can run them as they are
// (tests/unit/room-layout.spec.ts).

/**
 * Gives the grid the top toolbar's own band.
 *
 * The toolbar floats (centred, absolute, over the room shell), so the grid
 * started under it and the first row's names, tile menus and enlarge
 * buttons were covered. This measures the toolbar and sets
 * `--room-toolbar-space` on the shell; initials-overlay.css pads the grid
 * by it. Taller when the toolbar grows, 0 when it folds away (on phones it
 * collapses to nothing and its buttons live in More). Returns the clean-up.
 */
export function watchToolbarSpace(shell: HTMLElement, bar: HTMLElement): () => void {
  const measure = () => {
    const h = bar.offsetHeight;
    const shown = h > 0 && getComputedStyle(bar).display !== 'none';
    shell.style.setProperty('--room-toolbar-space', `${shown ? bar.offsetTop + h + 8 : 0}px`);
  };
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(bar);
  ro.observe(shell);
  // Fullscreen moves the toolbar without resizing it.
  document.addEventListener('fullscreenchange', measure);
  return () => {
    ro.disconnect();
    document.removeEventListener('fullscreenchange', measure);
  };
}

/**
 * Whose tile this is. Computer tiles say it as `data-neo-identity`
 * (NeoVideoConference); phone tiles (MobileParticipantTile) as
 * `data-lk-participant-identity`. LiveKit's own computer tiles said neither,
 * so features that looked only for the second one (spotlight, breakout
 * rooms) did nothing on a computer.
 */
export const TILE_IDENTITY_SELECTOR = '[data-neo-identity], [data-lk-participant-identity]';

export function tileIdentityOf(tile: Element): string | null {
  return (
    tile.getAttribute('data-neo-identity') ||
    tile.getAttribute('data-lk-participant-identity') ||
    tile.querySelector('[data-lk-participant-identity]')?.getAttribute('data-lk-participant-identity') ||
    null
  );
}

/**
 * Whether the tile enlarged on this screen can no longer be shown, so the
 * gallery should come back: that person left, their video is hidden (on
 * this screen or for everyone), or it is you and "Hide me" is on. LiveKit
 * kept the pin, and the stage stayed empty until a refresh.
 */
export function enlargedTileGone(input: {
  focusIdentity: string | undefined;
  focusIsLocal: boolean;
  present: readonly string[];
  isHidden: (identity: string) => boolean;
  hideSelf: boolean;
}): boolean {
  const { focusIdentity, focusIsLocal, present, isHidden, hideSelf } = input;
  if (!focusIdentity) return false;
  if (!present.includes(focusIdentity)) return true;
  return focusIsLocal ? hideSelf : isHidden(focusIdentity);
}
