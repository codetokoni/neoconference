'use client';

// src/components/LiveTranslation.tsx
//
// Live speech translation MVP for FRS §8 (future spec addition —
// "listen to a speaker in your own language"). Uses the existing
// caption pipeline for ASR, DeepL for translation, and the browser's
// SpeechSynthesis API for playback. That means:
//
//   - **Requires captions to be ON in the room.** This component reads
//     from LiveKit's TranscriptionReceived events; if the captions
//     worker isn't dispatched, there's no source to translate.
//   - **Voice quality is browser-dependent.** Chrome / Edge have
//     acceptable multilingual voices; iOS Safari has excellent
//     premium voices; Firefox on desktop can be robotic. This is a
//     trade-off for shipping without an ElevenLabs-tier server
//     pipeline (which is a separate follow-up).
//   - **Requires DEEPL_API_KEY in the environment** (see
//     src/app/api/translate/route.ts). Without it the toolbar toggle
//     silently no-ops and this component logs a one-shot warning.
//   - **Original speaker audio is not muted.** Users lower their
//     system volume or use headphones on the "wrong ear" while the
//     translation plays. Muting originals in-app is a follow-up
//     that has to deal cleanly with tiles going in and out.
//
// Toggle model: each viewer picks their own target language locally
// (localStorage), independent of the caption display language. Setting
// it to "off" is the default. Setting it to any supported language
// starts speaking the translation of every final caption segment.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages } from 'lucide-react';
import { useRoomContext } from '@livekit/components-react';
import {
  RoomEvent,
  type Participant,
  type TranscriptionSegment,
  type TrackPublication,
} from 'livekit-client';
import { CAPTION_LOCALES } from '@/lib/locales';

const STORAGE_KEY = 'neo:translation:target';
// DeepL doesn't cover ar / hi at the time of writing — filter them out
// so the picker only lists languages that actually round-trip. Keeping
// this list on the client too means we never post a request that we
// know the server will refuse.
const UNSUPPORTED_TARGETS = new Set(['ar', 'hi']);
const TARGET_LANGUAGES = CAPTION_LOCALES.filter(
  (l) => l.code !== 'auto' && !UNSUPPORTED_TARGETS.has(l.code),
);

const TOOLBAR_BTN_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition';

function useSpeechVoice(targetLang: string) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      // Prefer an exact lang match (e.g. "es-ES"), then a startsWith
      // (e.g. "es"), then default voice for the language, then null.
      const exact = voices.find(
        (v) => v.lang.toLowerCase() === targetLang.toLowerCase(),
      );
      const partial = voices.find((v) =>
        v.lang.toLowerCase().startsWith(targetLang.toLowerCase() + '-'),
      );
      const any = voices.find((v) =>
        v.lang.toLowerCase().startsWith(targetLang.toLowerCase()),
      );
      setVoice(exact || partial || any || null);
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, [targetLang]);
  return voice;
}

interface Diagnostics {
  captionsSeen: number;
  finalsSeen: number;
  translateAttempts: number;
  translateOk: number;
  spoke: number;
  lastError: string | null;
  lastSample: string | null;
}

const EMPTY_DIAG: Diagnostics = {
  captionsSeen: 0,
  finalsSeen: 0,
  translateAttempts: 0,
  translateOk: 0,
  spoke: 0,
  lastError: null,
  lastSample: null,
};

export default function LiveTranslation() {
  const room = useRoomContext();
  const [targetLang, setTargetLangState] = useState<string>('off');
  const [open, setOpen] = useState(false);
  const [diag, setDiag] = useState<Diagnostics>(EMPTY_DIAG);
  // Ref mirror so async work can update counters without stale closures.
  const diagRef = useRef<Diagnostics>(EMPTY_DIAG);
  const bumpDiag = useCallback((patch: Partial<Diagnostics>) => {
    diagRef.current = { ...diagRef.current, ...patch };
    setDiag(diagRef.current);
  }, []);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const warnedNoTts = useRef(false);
  const voice = useSpeechVoice(targetLang === 'off' ? 'en' : targetLang);

  // Load / persist per-viewer preference.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v) setTargetLangState(v);
    } catch {
      // ignore
    }
  }, []);
  const setTargetLang = useCallback((next: string) => {
    setTargetLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    // Any change cancels queued utterances so the switch is instant,
    // and resets diagnostics so the next attempt starts from zero.
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    diagRef.current = EMPTY_DIAG;
    setDiag(EMPTY_DIAG);
  }, []);

  // Warn once if TTS is unavailable — no user-facing error, just a
  // console note so support can diagnose "why doesn't translation work".
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('speechSynthesis' in window) && !warnedNoTts.current) {
      warnedNoTts.current = true;
      console.warn(
        '[live-translation] window.speechSynthesis is unavailable — translation toggle is inert in this browser.',
      );
    }
  }, []);

  // Close popover on Escape / outside tap. Popover is portaled to
  // document.body so contains() checks have to cover both button and
  // the popover DOM. Track the popover element via callback ref.
  const [popoverEl, setPopoverEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverEl?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, popoverEl]);

  // Main pipeline: caption arrives → translate if needed → speak.
  useEffect(() => {
    if (!room) return;
    if (targetLang === 'off') return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const seenFinalIds = new Set<string>();

    const handler = async (
      segments: TranscriptionSegment[],
      _participant?: Participant,
      _publication?: TrackPublication,
    ) => {
      bumpDiag({ captionsSeen: diagRef.current.captionsSeen + segments.length });
      for (const seg of segments) {
        if (!seg.final) continue;
        if (seenFinalIds.has(seg.id)) continue;
        seenFinalIds.add(seg.id);
        bumpDiag({ finalsSeen: diagRef.current.finalsSeen + 1 });
        const text = (seg.text || '').trim();
        if (!text) continue;
        // Skip if the caption is already in the viewer's target
        // language (common when a caption worker is multi-language).
        const source = (seg as { language?: string }).language || '';
        const sourceShort = source.split('-')[0].toLowerCase();
        if (sourceShort && sourceShort === targetLang) continue;

        bumpDiag({
          translateAttempts: diagRef.current.translateAttempts + 1,
          lastError: null,
        });
        try {
          const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              targetLang,
              sourceLang: sourceShort || undefined,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            const code = body?.error || 'http_' + res.status;
            const humanized = describeError(code, res.status);
            bumpDiag({ lastError: humanized });
            console.warn('[live-translation] translate failed', res.status, body);
            if (res.status === 503) {
              // No point retrying — key isn't configured. Stop until
              // the user changes target (which resets diagnostics).
              return;
            }
            continue;
          }
          const j = (await res.json()) as { translated?: string };
          const out = (j.translated || '').trim();
          if (!out) {
            bumpDiag({ lastError: 'Provider returned empty translation.' });
            continue;
          }
          bumpDiag({
            translateOk: diagRef.current.translateOk + 1,
            lastSample: out.length > 60 ? out.slice(0, 57) + '…' : out,
          });

          const utt = new SpeechSynthesisUtterance(out);
          utt.lang = targetLang;
          if (voice) utt.voice = voice;
          utt.rate = 1.15;
          utt.onstart = () => bumpDiag({ spoke: diagRef.current.spoke + 1 });
          utt.onerror = (ev) =>
            bumpDiag({ lastError: 'TTS error: ' + (ev.error || 'unknown') });
          window.speechSynthesis.speak(utt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          bumpDiag({ lastError: 'Network: ' + msg });
          console.warn('[live-translation] fetch failed', e);
        }
      }
    };

    room.on(RoomEvent.TranscriptionReceived, handler);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, handler);
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    };
  }, [room, targetLang, voice]);

  const currentLabel = useMemo(() => {
    if (targetLang === 'off') return 'Off';
    const match = TARGET_LANGUAGES.find((l) => l.code === targetLang);
    return match?.native || targetLang;
  }, [targetLang]);

  const testVoice = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const sample =
      targetLang === 'off' || targetLang === 'en'
        ? 'Live translation is ready.'
        : 'Translation test.';
    const utt = new SpeechSynthesisUtterance(sample);
    utt.lang = targetLang === 'off' ? 'en' : targetLang;
    if (voice) utt.voice = voice;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    window.speechSynthesis.speak(utt);
    setEverSpoke(true);
  }, [targetLang, voice]);

  const popover = open && typeof document !== 'undefined' ? createPortal(
    <div
      ref={setPopoverEl}
      role="menu"
      style={{
        position: 'fixed',
        top: computePopoverTop(buttonRef.current),
        left: computePopoverLeft(buttonRef.current),
        minWidth: 260,
        maxHeight: '60vh',
        overflowY: 'auto',
        padding: 6,
        borderRadius: 12,
        background: 'rgba(11,16,32,0.98)',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        zIndex: 200,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'rgba(255,255,255,0.5)',
          padding: '4px 10px',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        Hear this meeting in
      </div>
      <TargetOption
        code="off"
        label="Off (original audio only)"
        active={targetLang === 'off'}
        onPick={setTargetLang}
      />
      {TARGET_LANGUAGES.map((l) => (
        <TargetOption
          key={l.code}
          code={l.code}
          label={`${l.native} · ${l.label}`}
          active={targetLang === l.code}
          onPick={setTargetLang}
        />
      ))}
      <div
        style={{
          fontSize: 10,
          color: 'rgba(255,255,255,0.4)',
          padding: '6px 10px 4px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          marginTop: 4,
        }}
      >
        Uses your browser&apos;s voice. Captions must be on for this
        to work — if you don&apos;t hear anything, ask the host to turn
        Captions on.
      </div>
      {targetLang !== 'off' && diag.spoke === 0 && (
        <button
          type="button"
          onClick={testVoice}
          style={{
            width: 'calc(100% - 12px)',
            margin: '4px 6px',
            padding: '6px 8px',
            fontSize: 12,
            borderRadius: 8,
            border: '1px solid rgba(34,211,238,0.35)',
            background: 'rgba(34,211,238,0.12)',
            color: '#7ee9f7',
            cursor: 'pointer',
          }}
        >
          Test voice
        </button>
      )}

      {targetLang !== 'off' && (
        <div
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.55)',
            padding: '6px 10px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.4)',
              marginBottom: 4,
            }}
          >
            Pipeline status
          </div>
          <StatusRow label="Captions received" value={diag.captionsSeen} good={diag.captionsSeen > 0} />
          <StatusRow label="Final sentences" value={diag.finalsSeen} good={diag.finalsSeen > 0} />
          <StatusRow label="Translations OK" value={`${diag.translateOk} / ${diag.translateAttempts}`} good={diag.translateOk > 0} />
          <StatusRow label="Spoke aloud" value={diag.spoke} good={diag.spoke > 0} />
          {diag.captionsSeen === 0 && (
            <div style={{ color: '#fbbf24', marginTop: 6 }}>
              No captions received yet — ask the host to turn Captions ON.
            </div>
          )}
          {diag.lastSample && (
            <div style={{ marginTop: 6, color: 'rgba(126,233,247,0.9)', fontStyle: 'italic' }}>
              Latest: “{diag.lastSample}”
            </div>
          )}
          {diag.lastError && (
            <div style={{ marginTop: 6, color: '#fca5a5' }}>
              {diag.lastError}
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  // Return a FRAGMENT with the button as a direct child of whatever
  // parent renders us (in practice: `.room-toolbar`). The wrapping
  // <div> the previous version had broke the `.room-toolbar > button`
  // scan used by both DesktopMoreMenu and MobileMoreMenu — that's why
  // the button never appeared on mobile. Popover is portaled to
  // document.body so it doesn't need the local anchor either.
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-toolbar-item="true"
        data-room-chrome="true"
        data-in-more="true"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Live translation — hear this meeting in your language"
        className={TOOLBAR_BTN_CLASS}
      >
        <Languages size={16} aria-hidden />
        Translate{targetLang !== 'off' ? ` · ${currentLabel}` : ''}
      </button>
      {popover}
    </>
  );
}

/* Positioning helpers for the portaled popover. Anchored under the
 * button's bounding rect; clamped to the viewport so the menu never
 * flies off-screen on mobile where the button lives in the More
 * popover rather than in the visible toolbar. */
function computePopoverTop(btn: HTMLElement | null): number {
  if (!btn) return 80;
  const rect = btn.getBoundingClientRect();
  const desired = rect.bottom + 6;
  const maxTop = window.innerHeight - 100;
  return Math.min(desired, maxTop);
}
function computePopoverLeft(btn: HTMLElement | null): number {
  if (!btn) return 16;
  const rect = btn.getBoundingClientRect();
  const width = 260;
  const desired = rect.right - width;
  const min = 8;
  const max = window.innerWidth - width - 8;
  return Math.max(min, Math.min(desired, max));
}

function StatusRow({
  label,
  value,
  good,
}: {
  label: string;
  value: number | string;
  good: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: 999,
            marginRight: 6,
            background: good ? '#34d399' : 'rgba(255,255,255,0.25)',
            verticalAlign: 'middle',
          }}
        />
        {label}
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: good ? '#fff' : 'rgba(255,255,255,0.45)' }}>{value}</span>
    </div>
  );
}

function describeError(code: string, status: number): string {
  switch (code) {
    case 'translation_not_configured':
      return 'DEEPL_API_KEY is not set in Vercel env. Add it and redeploy.';
    case 'unauthenticated':
      return 'Sign in to use translation.';
    case 'target_not_supported':
      return 'This language is not supported by DeepL.';
    case 'text_too_long':
      return 'Caption was too long to translate.';
    case 'provider_error':
      return `DeepL rejected the request (HTTP ${status}). Check the API key or your DeepL quota.`;
    case 'provider_bad_response':
    case 'provider_empty_response':
      return 'DeepL returned an unexpected response.';
    case 'network_error':
      return 'Network error contacting DeepL.';
    default:
      return `Translate failed (${code}).`;
  }
}

function TargetOption({
  code,
  label,
  active,
  onPick,
}: {
  code: string;
  label: string;
  active: boolean;
  onPick: (code: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onPick(code)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        background: active ? 'rgba(34,211,238,0.14)' : 'transparent',
        color: active ? '#7ee9f7' : '#fff',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      <span>{label}</span>
      {active && <span aria-hidden>✓</span>}
    </button>
  );
}
