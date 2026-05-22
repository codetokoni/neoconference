// Preset background images sourced from Unsplash under the Unsplash License:
// - office.jpg — Photo by Nastuh Abootalebi (unsplash.com/photos/rSpMla5RItA)
// - library.jpg — Photo by Robert | Visual Diary (unsplash.com/photos/grand-library-interior-with-tall-bookshelves-and-arched-windows-I9lIqAQGnu0)
// - gradient.jpg — Photo by Luke Chesser (unsplash.com/photos/blue-to-purple-gradient-eICUFSeirc0)

import { BackgroundBlur, VirtualBackground } from '@livekit/track-processors';
import { LocalParticipant, Track } from 'livekit-client';

export type BackgroundMode =
  | { type: 'none' }
  | { type: 'blur' }
  | { type: 'preset'; key: 'office' | 'library' | 'gradient' }
  | { type: 'custom'; dataUrl: string };

export async function applyBackground(
  participant: LocalParticipant,
  mode: BackgroundMode,
): Promise<void> {
  const pub = participant.getTrackPublication(Track.Source.Camera);
  const track = pub?.track as any;
  if (!track) return;

  if (mode.type === 'none') {
    if (typeof track.stopProcessor === 'function') {
      await track.stopProcessor();
    }
    return;
  }
  // segmenterOptions maps to MediaPipe ImageSegmenter baseOptions. `delegate: 'GPU'`
  // requests the WebGL path; MediaPipe transparently falls back to CPU when WebGL
  // isn't available. Blur radius bumped 10 -> 15 for stronger smoothing.
  if (mode.type === 'blur') {
    await track.setProcessor(BackgroundBlur(15, { delegate: 'GPU' as const }));
    return;
  }
  if (mode.type === 'preset') {
    await track.setProcessor(VirtualBackground(`/backgrounds/${mode.key}.jpg`, { delegate: 'GPU' as const }));
    return;
  }
  if (mode.type === 'custom') {
    await track.setProcessor(VirtualBackground(mode.dataUrl, { delegate: 'GPU' as const }));
    return;
  }
}

const MODE_KEY = 'nc:background-mode';
const CUSTOM_KEY_PREFIX = 'nc:bg-custom-image:';

export function loadBackgroundMode(roomSlug: string): BackgroundMode {
  if (typeof window === 'undefined') return { type: 'none' };
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (!stored) return { type: 'none' };
    const parsed = JSON.parse(stored) as BackgroundMode;
    if (parsed.type === 'custom') {
      const dataUrl = localStorage.getItem(CUSTOM_KEY_PREFIX + roomSlug);
      if (!dataUrl) return { type: 'none' };
      return { type: 'custom', dataUrl };
    }
    if (parsed.type === 'preset' && !['office', 'library', 'gradient'].includes(parsed.key)) {
      try { localStorage.removeItem(MODE_KEY); } catch {}
      return { type: 'none' };
    }
    return parsed;
  } catch {
    return { type: 'none' };
  }
}

export function saveBackgroundMode(mode: BackgroundMode, roomSlug: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (mode.type === 'custom') {
      localStorage.setItem(CUSTOM_KEY_PREFIX + roomSlug, mode.dataUrl);
      localStorage.setItem(MODE_KEY, JSON.stringify({ type: 'custom' }));
    } else {
      localStorage.setItem(MODE_KEY, JSON.stringify(mode));
    }
  } catch (e) {
    console.warn('Failed to save background mode:', e);
  }
}

export function clearCustomBackground(roomSlug: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CUSTOM_KEY_PREFIX + roomSlug);
  } catch {
    /* ignore */
  }
}

export function getCustomBackgroundDataUrl(roomSlug: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(CUSTOM_KEY_PREFIX + roomSlug);
  } catch {
    return null;
  }
}
