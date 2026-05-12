'use client';
import { zIndex } from "@/lib/zIndex";

import { useEffect, useRef, useState } from 'react';
import {
  ParticipantTile,
  useTracks,
  VideoConference,
  TrackLoop,
  useLocalParticipant,
  useRoomContext,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * MobileVideoConference
 *
 * Phone (<= 640px): custom 2x2 grid (4 tiles per page) with horizontal swipe to
 * paginate, plus a fixed bottom control bar (mic / camera / more / leave).
 * Desktop: stock <VideoConference /> unchanged.
 */
export default function MobileVideoConference() {
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  if (!mounted || !isMobile) {
    return <VideoConference />;
  }

  return <MobileGridImpl />;
}

const PAGE_SIZE = 4;
const SWIPE_THRESHOLD = 50; // px
const BAR_HEIGHT = 64; // px reserved for bottom control bar

function MobileGridImpl() {
  const tracks: TrackReferenceOrPlaceholder[] = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageTracks = tracks.slice(start, start + PAGE_SIZE);

  // Touch swipe handlers
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartX.current = t.clientX;
    touchStartY.current = t.clientY;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null || touchStartY.current == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX.current;
    const dy = t.clientY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0 && safePage < totalPages - 1) setPage(safePage + 1);
    else if (dx > 0 && safePage > 0) setPage(safePage - 1);
  };

  return (
    <div
      className='lk-video-conference nc-mobile-vc'
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        position: 'absolute',
        inset: 0,
        touchAction: 'pan-y',
      }}
    >
      <div
        className='nc-mobile-grid'
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 6,
          padding: 6,
          paddingRight: 62,
          paddingBottom: BAR_HEIGHT + 6,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        <TrackLoop tracks={pageTracks}>
          <ParticipantTile
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 12,
              overflow: 'hidden',
              minHeight: 0,
            }}
          />
        </TrackLoop>
      </div>

      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            justifyContent: 'center',
            padding: '6px 0',
            position: 'absolute',
            bottom: BAR_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {Array.from({ length: totalPages }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              aria-label={`Go to page ${i + 1}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                border: 'none',
                padding: 0,
                background: i === safePage ? '#fff' : 'rgba(255,255,255,0.35)',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      )}

      <MobileControlBar />
    </div>
  );
}

// ---------- Bottom control bar ----------

type ToolbarItem = { label: string; el: HTMLElement; icon: string; section: ToolbarSection };
type ToolbarSection = 'communicate' | 'view' | 'host' | 'settings';

// Map a toolbar button label to an icon + section. Keyed by case-insensitive
// substring match so the picker stays in lock-step with whatever the desktop
// toolbar renders today, including future labels we have not enumerated yet.
const ITEM_RULES: Array<{ match: RegExp; icon: string; section: ToolbarSection }> = [
  { match: /^(chat|messages?)$/i, icon: '💬', section: 'communicate' },
  { match: /^(share[- ]?screen|screen[- ]?share|share)$/i, icon: '🖥️', section: 'communicate' },
  { match: /reaction|emoji/i, icon: '😊', section: 'communicate' },
  { match: /raise.?hand|hand/i, icon: '✋', section: 'communicate' },
  { match: /(cc|caption|subtitle)/i, icon: '🆒', section: 'view' },
  { match: /background|blur|effect/i, icon: '✨', section: 'view' },
  { match: /whiteboard/i, icon: '📝', section: 'view' },
  { match: /(device|camera|microphone|speaker|audio|video)/i, icon: '🎛️', section: 'view' },
  { match: /stats|connection|network|quality/i, icon: '📊', section: 'view' },
  { match: /spotlight/i, icon: '🌟', section: 'view' },
  { match: /people|participant|attendee/i, icon: '👥', section: 'host' },
  { match: /waiting|lobby/i, icon: '🚪', section: 'host' },
  { match: /breakout|room/i, icon: '🏘️', section: 'host' },
  { match: /poll|q&a|qna|question/i, icon: '📊', section: 'host' },
  { match: /record|stop|waiting for host/i, icon: '⏺️', section: 'host' },
  { match: /go ?live|stream/i, icon: '🔴', section: 'host' },
  { match: /host|cohost|moderate/i, icon: '👑', section: 'host' },
  { match: /setting|preference|option/i, icon: '⚙️', section: 'settings' },
];

const SECTION_LABEL: Record<ToolbarSection, string> = {
  communicate: 'Communicate',
  view: 'View & Effects',
  host: 'Host Controls',
  settings: 'Settings',
};

const SECTION_ORDER: ToolbarSection[] = ['communicate', 'view', 'host', 'settings'];

function classify(label: string): { icon: string; section: ToolbarSection } {
  for (const rule of ITEM_RULES) {
    if (rule.match.test(label)) return { icon: rule.icon, section: rule.section };
  }
  return { icon: '•', section: 'view' };
}

function MobileControlBar() {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [moreOpen, setMoreOpen] = useState(false);
  const [items, setItems] = useState<ToolbarItem[]>([]);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Scan toolbar surfaces and produce a classified, de-duplicated item list.
  // We scan the same superset that the desktop toolbar exposes:
  //   - .room-toolbar > button         (custom in-app actions)
  //   - .lk-chat-toggle                (LiveKit chat button)
  //   - .lk-control-bar [data-lk-source="screen_share"]
  //   - .lk-settings-toggle            (LiveKit settings)
  // Items are kept in DOM order so the menu mirrors the visual toolbar.
  const refreshItems = () => {
    const list: ToolbarItem[] = [];
    const seen = new Set<string>();
    const push = (label: string, el: HTMLElement | null) => {
      if (!el) return;
      const clean = label.trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const { icon, section } = classify(clean);
      list.push({ label: clean, el, icon, section });
    };
    document.querySelectorAll<HTMLButtonElement>('.room-toolbar > button').forEach((b) => {
      push((b.textContent || '').trim(), b);
    });
    const chat = document.querySelector<HTMLElement>('.lk-chat-toggle');
    if (chat) push('Chat', chat);
    const share = document.querySelector<HTMLElement>('.lk-control-bar [data-lk-source="screen_share"]');
    if (share) push('Share screen', share);
    const settings = document.querySelector<HTMLElement>('.lk-settings-toggle');
    if (settings) push('Settings', settings);
    setItems(list);
  };

  // Keep the sheet in sync with toolbar mutations while open (host buttons
  // appear/disappear, recording label flips between Record and Stop, etc).
  useEffect(() => {
    if (!moreOpen) return;
    refreshItems();
    const obs = new MutationObserver(() => refreshItems());
    const targets = ['.room-toolbar', '.lk-control-bar'].map((sel) => document.querySelector(sel)).filter((n): n is Element => !!n);
    targets.forEach((t) => obs.observe(t, { childList: true, subtree: true, characterData: true }));
    return () => obs.disconnect();
  }, [moreOpen]);

  // Esc to close + focus trap + initial focus + restore focus on close.
  useEffect(() => {
    if (!moreOpen) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) || null;
    const sheet = sheetRef.current;
    const focusables = () => Array.from(sheet?.querySelectorAll<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])'
    ) || []).filter((el) => !el.hasAttribute('disabled'));
    const first = focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setMoreOpen(false); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const idx = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && (idx <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && idx === list.length - 1) { e.preventDefault(); list[0].focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previouslyFocusedRef.current?.focus?.(); };
  }, [moreOpen]);

  const toggleMic = () => {
    if (!localParticipant) return;
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {});
  };
  const toggleCam = () => {
    if (!localParticipant) return;
    localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => {});
  };
  const leave = () => {
    try { room?.disconnect(); } catch {}
    if (typeof window !== 'undefined') window.location.href = '/';
  };
  const openMore = () => { refreshItems(); setMoreOpen(true); };
  const closeMore = () => setMoreOpen(false);

  const fire = (it: ToolbarItem) => {
    try {
      const lbl = (it.label || '').toLowerCase();
      // Recording buttons live inside .room-toolbar but the toolbar has
      // pointer-events: none on phones, and proxying a programmatic .click()
      // through React onClick can be unreliable in this stack. RecordingControls
      // exposes window.__ncRecordToggle so we trigger it directly.
      const isRec = lbl.includes('record') || lbl.includes('waiting for host');
      const toggle = (window as any).__ncRecordToggle;
      if (isRec && typeof toggle === 'function') {
        toggle();
      } else {
        it.el.click();
      }
    } catch {}
    closeMore();
  };

  const btnStyle: React.CSSProperties = {
    flex: 1,
    height: 48,
    border: 'none',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  };
  const offStyle: React.CSSProperties = { ...btnStyle, background: '#dc2626' };
  const dangerStyle: React.CSSProperties = { ...btnStyle, background: '#dc2626' };

  // Group items by section, preserving DOM order within each section.
  const grouped: Record<ToolbarSection, ToolbarItem[]> = {
    communicate: [], view: [], host: [], settings: [],
  };
  for (const it of items) grouped[it.section].push(it);

  return (
    <>
      <div
        data-nc-mobile-bar='true'
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: BAR_HEIGHT,
          padding: '8px 8px calc(env(safe-area-inset-bottom, 0px) + 8px)',
          display: 'flex',
          gap: 8,
          alignItems: 'stretch',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.55))',
          zIndex: zIndex.videoChrome,
        }}
      >
        <button type='button' onClick={toggleMic} aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'} style={isMicrophoneEnabled ? btnStyle : offStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>{isMicrophoneEnabled ? 'Mic' : 'Mic⊘'}</span>
        </button>
        <button type='button' onClick={toggleCam} aria-label={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'} style={isCameraEnabled ? btnStyle : offStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>{isCameraEnabled ? 'Cam' : 'Cam⊘'}</span>
        </button>
        <button type='button' onClick={openMore} aria-haspopup='dialog' aria-expanded={moreOpen} aria-label='More options' style={btnStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>More</span>
        </button>
        <button type='button' onClick={leave} aria-label='Leave room' style={dangerStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>Leave</span>
        </button>
      </div>

      {moreOpen && (
        <div
          onClick={closeMore}
          role='presentation'
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: zIndex.videoChromeRaised,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            ref={sheetRef}
            role='dialog'
            aria-modal='true'
            aria-labelledby='nc-more-title'
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 480,
              background: '#0f172a',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 12,
              paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
              maxHeight: '72vh',
              overflowY: 'auto',
              boxShadow: '0 -16px 40px rgba(0,0,0,0.5)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {/* Drag handle pill */}
            <div aria-hidden='true' style={{ display: 'flex', justifyContent: 'center', paddingTop: 2, paddingBottom: 8 }}>
              <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.25)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 6px 10px' }}>
              <div>
                <div id='nc-more-title' style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>More</div>
                <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 }}>Tools and host controls</div>
              </div>
              <button type='button' onClick={closeMore} aria-label='Close menu' style={{ color: '#bbb', background: 'transparent', border: 'none', fontSize: 18, cursor: 'pointer', padding: 4 }}>
                ✕
              </button>
            </div>

            {items.length === 0 && (
              <div style={{ color: '#888', fontSize: 13, padding: 16, textAlign: 'center' }}>
                No extra actions available right now.
              </div>
            )}

            {SECTION_ORDER.map((sec) => {
              const list = grouped[sec];
              if (list.length === 0) return null;
              return (
                <div key={sec} style={{ marginTop: 6 }}>
                  <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, padding: '6px 4px' }}>
                    {SECTION_LABEL[sec]}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {list.map((it, i) => (
                      <button
                        key={sec + i + it.label}
                        type='button'
                        onClick={() => fire(it)}
                        style={{
                          height: 64,
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.04)',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 500,
                          cursor: 'pointer',
                          padding: '8px 10px',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 4,
                          textAlign: 'center',
                        }}
                      >
                        <span aria-hidden='true' style={{ fontSize: 22, lineHeight: 1 }}>{it.icon}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{it.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
