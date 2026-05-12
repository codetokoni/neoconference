/**
 * Z-index design tokens.
 *
 * NeoConference UI layers, ordered from background to foreground.
 * Every component that previously hard-coded a numeric z-index should
 * import a named token from this module so the stacking order stays
 * coherent across the app.
 *
 * Scale (powers of 10, with a few intermediate values for tightly
 * adjacent layers):
 *
 *   0   base            default flow content
 *   1   content         explicitly above base, below chrome
 *   5   tileBadge       small in-tile UI (role badges, name pills)
 *  10   tileMenu        per-tile context menus (HostTileMenu)
 *  20   videoChrome     mobile video chrome layer
 *  30   videoChromeRaised
 *  40   toolbar         the main top toolbar
 *  49   mobileMenuBackdrop
 *  50   mobileMenu      MobileMoreMenu and similar
 *  59   panelBackdrop
 *  60   panel           side panels (Participants, Chat default)
 *  70   panelRaised     raise-hand, reactions, hovering UI above panels
 *  80   panelModal      full panel overlays (waiting, breakouts, polls)
 *  90   panelModalRaised  dialogs spawned from panels (polls confirm)
 * 200   floatingPiP     picture-in-picture floating window
 * 9999  mediaPrompt     device-permission prompts (must always win)
 *
 * Usage:
 *   import { zIndex } from "@/lib/zIndex";
 *   <div style={{ zIndex: zIndex.panel }} />
 *
 * Adding a new layer? Pick the smallest unused value that puts it in
 * the right relative position, and document it both here and at the
 * call site.
 */

export const zIndex = {
  base: 0,
  content: 1,
  tileBadge: 5,
  tileMenu: 10,
  videoChrome: 20,
  videoChromeRaised: 30,
  toolbar: 40,
  mobileMenuBackdrop: 49,
  mobileMenu: 50,
  panelBackdrop: 59,
  panel: 60,
  panelRaised: 70,
  panelModal: 80,
  panelModalRaised: 90,
  floatingPiP: 200,
  mediaPrompt: 9999,
} as const;

export type ZIndexToken = keyof typeof zIndex;

