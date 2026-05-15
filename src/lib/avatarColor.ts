const PALETTE = [
  { name: 'cyan',    hex: '#06b6d4', rgb: '6, 182, 212' },
  { name: 'violet',  hex: '#8b5cf6', rgb: '139, 92, 246' },
  { name: 'emerald', hex: '#10b981', rgb: '16, 185, 129' },
  { name: 'rose',    hex: '#f43f5e', rgb: '244, 63, 94' },
  { name: 'amber',   hex: '#f59e0b', rgb: '245, 158, 11' },
  { name: 'indigo',  hex: '#6366f1', rgb: '99, 102, 241' },
  { name: 'pink',    hex: '#ec4899', rgb: '236, 72, 153' },
  { name: 'orange',  hex: '#f97316', rgb: '249, 115, 22' },
  { name: 'teal',    hex: '#14b8a6', rgb: '20, 184, 166' },
  { name: 'purple',  hex: '#a855f7', rgb: '168, 85, 247' },
];

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Returns a stable hex color for the given seed string.
 *
 * Stable across sessions only when the seed is stable — typically
 * `participant.name || participant.identity`. LiveKit identity may be
 * a per-room token and is not stable across sessions; display name
 * usually is.
 */
export function getAvatarColor(seed: string): string {
  return PALETTE[hash(seed) % PALETTE.length].hex;
}

/** Returns bare `'r, g, b'` for composing into `rgba(${rgb}, alpha)`. */
export function getAvatarColorRGB(seed: string): string {
  return PALETTE[hash(seed) % PALETTE.length].rgb;
}

/** Up to two uppercase initials. Returns `'?'` for empty/whitespace input. */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();
}
