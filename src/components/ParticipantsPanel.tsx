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
type PanelRole = 'owner' | 'host' | 'moderator';

const PANEL_BADGE_STYLE: Record<PanelRole, { bg: string; border: string; fg: string; label: string }> = {
  owner: { bg: 'rgba(168,85,247,0.18)', border: 'rgba(168,85,247,0.55)', fg: '#e8d7ff', label: 'Owner' },
  host: { bg: 'rgba(80,140,220,0.18)', border: 'rgba(80,140,220,0.55)', fg: '#cfe1ff', label: 'Host' },
  moderator: { bg: 'rgba(120,200,140,0.18)', border: 'rgba(120,200,140,0.55)', fg: '#cdeacd', label: 'Moderator' },
};

function RoleBadge({ role }: { role: PanelRole | null }) {
  if (!role) return null;
  const style = PANEL_BADGE_STYLE[role];
  return (
    <span
      data-role-badge={role}
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: '14px',
        borderRadius: 999,
        background: style.bg,
        border: '1px solid ' + style.border,
        color: style.fg,
        verticalAlign: 'middle',
      }}
    >
      {style.label}
    </span>
  );
}

export default function ParticipantsPanel({
  open,
  onClose,
  isHost,
  roomRole,
  ownerUserId,
  isOwner,
  slug,
  isLocked,
  onLockChanged,
}: {
  open: boolean;
  onClose: () => void;
  isHost: boolean;
  /** Wire-format role — 'host' covers owner+host after toLegacyRole. Used to
   *  gate the FRS §5.1 Mute All button, which is Owner+Host only (moderator
   *  cannot see it, even though they can mute individuals). */
  roomRole?: string;
  ownerUserId?: string | null;
  /** True only for the actual event creator (from /api/events/role). Used to
   *  gate the FRS §1.1 "Make Host" action — canManageRole in permissions.ts
   *  refuses to grant a Host role from a Host actor (needs strictly higher
   *  rank), so only the Owner may promote to Host. */
  isOwner?: boolean;
  slug: string;
  /** FRS §12.8 meeting lock state — reflected on the toggle button. */
  isLocked?: boolean;
  /** Called after a successful toggle so the room page can sync its copy. */
  onLockChanged?: (locked: boolean) => void;
}) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const [pending, setPending] = useState<string | null>(null);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [muteAllConfirm, setMuteAllConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Moderator can also trigger Mute All — spec §5.1 says the button "should
  // be available to the Owner and Host" but §1.3 doesn't explicitly forbid
  // Moderator, and Moderators running programme segments need the affordance
  // in practice. Server-side muteAll route still exempts Owner/Host/Moderator
  // and the caller from being muted, so the "keep elevated roles unmuted"
  // half of §5.1 still holds regardless of who presses the button.
  const canMuteAll = roomRole === 'host' || roomRole === 'cohost';
  // FRS §1.3: Moderator (cohost) must NOT remove participants or assign
  // Moderator/Host/Owner rights. Server already refuses via the RBAC catalog
  // (participant:kick, role:grant, role:revoke are all at RANK.host); this
  // is the UI-side gate so the button doesn't leak to Moderator and
  // silently 403 on click.
  const canRemoveOrPromote = roomRole === 'host';
  // FRS §1.1: only the Owner may appoint Hosts. canManageRole in
  // permissions.ts refuses to grant a Host role from a Host actor because
  // it requires strictly higher rank, so this is server-enforced too.
  const canMakeHost = Boolean(isOwner);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!open) {
      setError(null);
      setConfirmKick(null);
      setMuteAllConfirm(false);
    }
  }, [open]);

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

  // Panel-wide action: toggle meeting lock (FRS §12.8). Server refuses new
  // tokens for ordinary participants when locked; elevated roles can still
  // enter to unlock. Toggle is instant — no confirmation, since the action
  // is reversible with a single click.
  const toggleLock = useCallback(async () => {
    setError(null);
    setPending('lock');
    const next = !isLocked;
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(slug)}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || 'request_failed');
        return;
      }
      onLockChanged?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [slug, isLocked, onLockChanged]);

  // Panel-wide action: Mute All (FRS §5.1). Confirmation lives in the panel
  // body; server keeps host/cohost/self unmuted.
  const muteAll = useCallback(async () => {
    setError(null);
    setPending('muteAll');
    try {
      const r = await fetch('/api/livekit/muteAll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName: slug }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || 'request_failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [slug]);

  // Role assign/demote goes through the RBAC-aware /roles route rather than
  // /api/livekit/moderate so the write lands in the Redis membership hash and
  // the server enforces the rank ladder. The LiveKit metadata push happens
  // inside the route so the badge still flips live.
  const assignRole = useCallback(
    async (role: 'host' | 'moderator' | 'participant', identity: string) => {
      setError(null);
      setPending(identity + ':role:' + role);
      try {
        const targetUserId = identity.split('#')[0];
        const r = await fetch(`/api/events/${encodeURIComponent(slug)}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: targetUserId, role }),
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

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(10,10,12,0.98)",
        color: "white",
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        paddingBottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
        boxSizing: "border-box",
      }
    : {
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: "min(380px, 100vw)",
        background: "rgba(10,10,12,0.97)",
        color: "white",
        zIndex: 60,
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        display: "flex",
        flexDirection: "column",
      };

  if (!open) return null;

  const localIdentity = localParticipant?.identity || '';

  function roleOf(p: { identity?: string; metadata?: string } | null | undefined): PanelRole | null {
    if (!p) return null;
    // FRS §1 four-role display: recover the Owner distinction that
    // toLegacyRole collapses into "host" on the wire.
    if (ownerUserId && p.identity && (p.identity === ownerUserId || p.identity.startsWith(ownerUserId + '#'))) return 'owner';
    const md = p.metadata;
    if (!md) return null;
    try {
      const j = JSON.parse(md);
      if (j && j.role === 'host') return 'host';
      if (j && j.role === 'cohost') return 'moderator';
    } catch {}
    return null;
  }
  const remote = participants.filter((p) => p && p.identity !== localIdentity);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? remote.filter((p) => ((p.name || p.identity || '').toLowerCase().includes(q)))
    : remote;

  return (
    <div
      role="dialog"
      aria-label="Participants"
      style={panelStyle}
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

      {canMuteAll && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            disabled={!!pending}
            onClick={toggleLock}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: '1px solid ' + (isLocked ? 'rgba(244,63,94,0.55)' : 'rgba(148,163,184,0.35)'),
              background: isLocked ? 'rgba(244,63,94,0.15)' : 'rgba(148,163,184,0.08)',
              color: isLocked ? '#fecaca' : '#e2e8f0',
              cursor: 'pointer',
              opacity: pending === 'lock' ? 0.5 : 1,
            }}
            title={isLocked ? 'Meeting is locked — click to unlock new joiners' : 'Lock this meeting so new ordinary participants cannot join'}
          >
            {pending === 'lock' ? '…' : isLocked ? 'Meeting locked · Unlock' : 'Lock meeting'}
          </button>
          {muteAllConfirm ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, color: '#ddd', lineHeight: 1.4 }}>
                Mute all Participants? Owners, Hosts and Moderators will remain unmuted.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={!!pending}
                  onClick={async () => { await muteAll(); setMuteAllConfirm(false); }}
                  style={{ flex: '1 1 auto', padding: '8px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: '1px solid rgba(255,180,60,0.55)', background: 'rgba(255,180,60,0.18)', color: '#ffe6b8', cursor: 'pointer', opacity: pending === 'muteAll' ? 0.5 : 1 }}
                >
                  {pending === 'muteAll' ? 'Muting…' : 'Mute all'}
                </button>
                <button
                  type="button"
                  onClick={() => setMuteAllConfirm(false)}
                  style={{ padding: '8px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: 'white', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!!pending}
              onClick={() => setMuteAllConfirm(true)}
              style={{ width: '100%', padding: '8px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: '1px solid rgba(255,180,60,0.45)', background: 'rgba(255,180,60,0.10)', color: '#ffe6b8', cursor: 'pointer' }}
              title="Mute every ordinary participant. Owners, Hosts and Moderators stay unmuted."
            >
              Mute All
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(localParticipant?.name || localParticipant?.identity || 'You')} <span style={{ opacity: 0.6, fontWeight: 400 }}>(you)</span><RoleBadge role={roleOf(localParticipant)} />
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
                  {display}<RoleBadge role={roleOf(p)} />
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
                  {canRemoveOrPromote && (confirmKick === id ? (
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
                  ))}

                {canRemoveOrPromote && (
                  <>
                    {canMakeHost && (
                      <button
                        type="button"
                        disabled={!!pending}
                        onClick={() => assignRole('host', id)}
                        style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(80,140,220,0.45)', background: 'rgba(80,140,220,0.12)', color: '#cfe1ff', cursor: 'pointer' }}
                        title="Appoint this participant as Host (Owner only per FRS §1.1)"
                      >
                        {busy('role:host') ? '...' : 'Make Host'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!!pending}
                      onClick={() => assignRole('moderator', id)}
                      style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(120,200,140,0.45)', background: 'rgba(120,200,140,0.12)', color: '#cdeacd', cursor: 'pointer' }}
                    >
                      {busy('role:moderator') ? '...' : 'Make Moderator'}
                    </button>
                    <button
                      type="button"
                      disabled={!!pending}
                      onClick={() => assignRole('participant', id)}
                      style={{ flex: '1 1 auto', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(255,200,90,0.45)', background: 'rgba(255,200,90,0.12)', color: '#ffe6b8', cursor: 'pointer' }}
                    >
                      {busy('role:participant') ? '...' : 'Demote'}
                    </button>
                  </>
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
