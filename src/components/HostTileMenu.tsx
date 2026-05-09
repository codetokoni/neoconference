'use client';

import { useState, useCallback } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';

/**
 * HostTileMenu
 *
 * Per-tile overlay menu shown only when the local user is a host (or cohost)
 * and the tile belongs to a remote participant. Provides:
 *  - Mute mic
 *  - Mute camera
 *  - Remove from room (with confirm)
 *
 * The actual tile content is rendered separately; this component is positioned
 * absolutely over the tile.
 */
export function HostTileMenu({
  participantIdentity,
  participantName,
  isHost,
  slug,
}: {
  participantIdentity: string;
  participantName: string;
  isHost: boolean;
  slug: string;
}) {
  const { localParticipant } = useLocalParticipant();
  // useRoomContext call kept for hook stability (must be called before early return)
  useRoomContext();
  const [open, setOpen] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isSelf = localParticipant?.identity === participantIdentity;

  const call = useCallback(
    async (action: 'muteAudio' | 'muteVideo' | 'kick' | 'requestUnmuteAudio' | 'requestCameraOn') => {
      setError(null);
      setPending(action);
      try {
        const r = await fetch('/api/livekit/moderate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, action, participantIdentity }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error || 'request_failed');
          return;
        }
        setOpen(false);
        setConfirmKick(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [slug, participantIdentity],
  );

  if (!isHost || isSelf || !slug) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 10,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={`Host actions for ${participantName}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.25)',
          fontSize: 16,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {String.fromCharCode(8942)}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 32,
            right: 0,
            minWidth: 180,
            background: 'rgba(20,20,22,0.96)',
            color: '#fff',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            border: '1px solid rgba(255,255,255,0.1)',
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            fontSize: 14,
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              fontSize: 12,
              color: 'rgba(255,255,255,0.55)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              marginBottom: 4,
            }}
          >
            Host actions - {participantName}
          </div>

          <MenuItem
            label="Mute microphone"
            icon="M"
            disabled={pending !== null}
            onClick={() => call('muteAudio')}
            pending={pending === 'muteAudio'}
          />
          <MenuItem
            label="Turn off camera"
            icon="V"
            disabled={pending !== null}
            onClick={() => call('muteVideo')}
            pending={pending === 'muteVideo'}
          />
          <MenuItem
            label="Ask to unmute mic"
            icon="·M"
            disabled={pending !== null}
            onClick={() => call('requestUnmuteAudio')}
            pending={pending === 'requestUnmuteAudio'}
          />
          <MenuItem
            label="Ask to turn on camera"
            icon="·V"
            disabled={pending !== null}
            onClick={() => call('requestCameraOn')}
            pending={pending === 'requestCameraOn'}
          />

          {!confirmKick ? (
            <MenuItem
              label="Remove from room"
              icon="X"
              danger
              disabled={pending !== null}
              onClick={() => setConfirmKick(true)}
            />
          ) : (
            <div
              style={{
                margin: '4px 6px',
                padding: 8,
                borderRadius: 8,
                background: 'rgba(220,38,38,0.12)',
                border: '1px solid rgba(220,38,38,0.4)',
              }}
            >
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                Remove {participantName}?
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setConfirmKick(false)}
                  disabled={pending !== null}
                  style={btnSecondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => call('kick')}
                  disabled={pending !== null}
                  style={btnDanger}
                >
                  {pending === 'kick' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                fontSize: 11,
                color: '#fca5a5',
                padding: '4px 10px 2px',
              }}
            >
              Error: {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
  disabled,
  pending,
  danger,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'transparent',
        color: danger ? '#fca5a5' : '#fff',
        border: 'none',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !pending ? 0.6 : 1,
        fontSize: 14,
      }}
    >
      <span style={{ width: 20, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{pending ? label + '...' : label}</span>
    </button>
  );
}

const btnSecondary: React.CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.15)',
  fontSize: 12,
  cursor: 'pointer',
};

const btnDanger: React.CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  borderRadius: 6,
  background: '#dc2626',
  color: '#fff',
  border: 'none',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 600,
};
