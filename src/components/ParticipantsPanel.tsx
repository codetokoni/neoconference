'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';

/**
 * ParticipantsPanel
 *
 * Host/cohost-only side panel listing every remote participant with
 * one-tap moderation actions (mute mic, mute cam, kick). Works on both
 * desktop and mobile (the per-tile HostMenuOverlay only attaches to
 * desktop tiles, so this panel is the canonical mobile path).
 *
 * Calls /api/livekit/moderate which already exists.
 */
export default function ParticipantsPanel({
  open,
  onClose,
  isHost,
  slug,
}: {
  open: boolean;
  onClose: () => void;
  isHost: boolean;
  slug: string;
}) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const [pending, setPending] = useState<string | null>(null);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => { if (!open) { setError(null); setConfirmKick(null); } }, [open]);

  const call = useCallback(
    async (
      action: 'muteAudio' | 'muteVideo' | 'kick' | 'requestUnmuteAudio' | 'requestCameraOn',
      identity: string,
    ) => {
      setError(null);
      setPending(identity + ':' + action);
      try {
        const r = await fetch('/api/livekit/moderate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, action, participantIdentity: identity }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error || 'request_failed');
          return;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [slug],
  );

  if (!open) return null;

  const localIdentity = localParticipant?.identity || '';
  const remote = participants.filter((p) => p && p.identity !== localIdentity);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? remote.filter((p) => ((p.name || p.identity || '').toLowerCase().includes(q)))
    : remote;

  return (
    <div
      role="dialog"
      aria-label="Participants"
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 'min(380px, 100vw)',
        background: 'rgba(10,10,12,0.97)',
        color: 'white',
        zIndex: 60,
        borderLeft: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        flexDirection: 'column',
      }}
      data-room-chrome="true"
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Participants ({remote.length + 1})</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: '0 6px' }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)', color: 'white', fontSize: 13, outline: 'none' }}
        />
      </div>

      {error && (
        <div style={{ margin: '10px 14px 0', padding: '8px 10px', background: 'rgba(220,40,40,0.18)', border: '1px solid rgba(220,40,40,0.4)', borderRadius: 8, fontSize: 12, color: '#ffd0d0' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(localParticipant?.name || localParticipant?.identity || 'You')} <span style={{ opacity: 0.6, fontWeight: 400 }}>(you)</span>
            </div>
          </div>
        </div>

        {filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, opacity: 0.6 }}>
            {q ? 'No matches.' : 'No other participants yet.'}
          </div>
        )}

        {filtered.map((p) => {
          const id = p.identity;
          const display = (p.name || id || '').trim() || id;
          const busy = (a: string) => pending === id + ':' + a;
          return (
            <div key={id} style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isHost ? 8 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                  {display}
                </div>
              </div>

              {isHost && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={!!pending}
                    onClick={() => call('muteAudio', id)}
                    style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: 'white', cursor: 'pointer', opacity: busy('muteAudio') ? 0.5 : 1 }}
                  >
                    {busy('muteAudio') ? '...' : 'Mute mic'}
                  </button>
                  <button
                    type="button"
                    disabled={!!pending}
                    onClick={() => call('muteVideo', id)}
                    style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: 'white', cursor: 'pointer', opacity: busy('muteVideo') ? 0.5 : 1 }}
                  >
                    {busy('muteVideo') ? '...' : 'Mute cam'}
                  </button>
                  {confirmKick === id ? (
                    <>
                      <button
                        type="button"
                        disabled={!!pending}
                        onClick={async () => { await call('kick', id); setConfirmKick(null); }}
                        style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(220,40,40,0.6)', background: 'rgba(220,40,40,0.25)', color: '#ffdada', cursor: 'pointer' }}
                      >
                        {busy('kick') ? '...' : 'Confirm kick'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmKick(null)}
                        style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: 'white', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!!pending}
                      onClick={() => setConfirmKick(id)}
                      style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(220,40,40,0.45)', background: 'rgba(220,40,40,0.12)', color: '#ffbcbc', cursor: 'pointer' }}
                    >
                      Kick
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
