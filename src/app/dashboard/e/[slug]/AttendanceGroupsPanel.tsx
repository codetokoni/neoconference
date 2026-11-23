'use client';

// Attendance by church or group, for the meeting's owner (src/lib/attendanceGroups.ts):
// the list attendees pick from when joining, each group's leader (a KingsChat
// handle and/or an email) who is sent their people after every session, and
// the sessions already sent, to download again.

import { useCallback, useEffect, useState } from 'react';

type Contact = { kcHandle?: string; email?: string };
type Group = { name: string; leader?: Contact };
type Row = { name: string; kcHandle: string; email: string };
type Reach = { group: string; kcHandleKnown: boolean | null; ownerKcLinked: boolean | null };
type Send = { start: number; end: number; attended: number; sentAt: number; download: string; leaders: Array<{ group: string; kc: boolean; email: boolean }> };
type Data = { groups: Group[]; allowed: boolean; reach: Reach[]; sends: Send[] };

const field =
  'w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70';
const toRow = (g: Group): Row => ({ name: g.name, kcHandle: g.leader?.kcHandle ? `@${g.leader.kcHandle}` : '', email: g.leader?.email ?? '' });
const when = (s: Send) => {
  const d = new Date(s.start);
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t(s.start)}–${t(s.end)}`;
};

export default function AttendanceGroupsPanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [paste, setPaste] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/attendance-groups`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Attendance by group did not load. Reload the page to try again.');
      setData(j as Data);
      setRows((j as Data).groups.map(toRow));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addPasted = () => {
    const names = paste.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.name.trim().toLowerCase()));
      return [...rs, ...names.filter((n) => !have.has(n.toLowerCase())).map((name) => ({ name, kcHandle: '', email: '' }))];
    });
    setPaste('');
  };

  const save = async () => {
    setSaving(true);
    setNote(null);
    const groups = rows
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), ...(r.kcHandle.trim() || r.email.trim() ? { leader: { kcHandle: r.kcHandle.trim(), email: r.email.trim() } } : {}) }));
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attendanceGroups: groups.length ? { groups } : null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote({
          ok: false,
          text: j.message || (j.error === 'plan_required' ? 'Attendance by group needs a paid plan.' : 'Not saved. Try again.'),
        });
        return;
      }
      setNote({ ok: true, text: groups.length ? `Saved: ${groups.length} churches or groups. People pick theirs when they next join.` : 'Removed. People are no longer asked.' });
      await load();
    } catch {
      setNote({ ok: false, text: 'Not saved. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <p className='text-sm text-red-300'>{loadError}</p>;
  if (!data) return <p className='text-sm text-slate-400'>Loading…</p>;
  const reachOf = (name: string) => data.reach.find((r) => r.group === name);
  const ownerKcMissing = data.reach.some((r) => r.ownerKcLinked === false);

  return (
    <div className='space-y-5'>
      <p className='text-sm text-slate-300'>
        List the churches or groups that attend. Everyone picks theirs once when they join. After every session, you get a spreadsheet with a tab
        per group, and each group&apos;s leader gets their own people by KingsChat or email.
      </p>
      {!data.allowed && <p className='text-sm text-amber-200/90'>Attendance by group needs a paid plan.</p>}
      {ownerKcMissing && (
        <p className='text-xs text-amber-200/90'>KingsChat messages are sent from your own KingsChat account. Sign in with KingsChat once so they can be sent.</p>
      )}

      <div className='space-y-2'>
        {rows.map((r, i) => {
          const reach = reachOf(r.name.trim());
          return (
            <div key={i} className='rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2'>
              <div className='flex gap-2'>
                <input aria-label={`Church or group ${i + 1}`} className={field} value={r.name} placeholder='Church or group name' onChange={(e) => setRow(i, { name: e.target.value })} />
                <button type='button' onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className='shrink-0 rounded-lg px-3 text-xs text-slate-300 hover:bg-white/10' aria-label={`Remove ${r.name || `group ${i + 1}`}`}>
                  Remove
                </button>
              </div>
              <div className='grid gap-2 sm:grid-cols-2'>
                <input aria-label={`Leader's KingsChat for ${r.name || `group ${i + 1}`}`} className={field} value={r.kcHandle} placeholder="Leader's KingsChat (@handle)" onChange={(e) => setRow(i, { kcHandle: e.target.value })} />
                <input aria-label={`Leader's email for ${r.name || `group ${i + 1}`}`} className={field} type='email' value={r.email} placeholder="Leader's email" onChange={(e) => setRow(i, { email: e.target.value })} />
              </div>
              {reach?.kcHandleKnown === false && r.kcHandle.trim() && (
                <p className='text-xs text-amber-200/90'>Nobody has signed in here with {r.kcHandle.trim()} yet, so a KingsChat message cannot find them. They need to sign in with KingsChat once.</p>
              )}
            </div>
          );
        })}
        <button type='button' onClick={() => setRows((rs) => [...rs, { name: '', kcHandle: '', email: '' }])} className='rounded-lg border border-white/15 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10'>
          Add a church or group
        </button>
      </div>

      <div className='space-y-2'>
        <label htmlFor='groups-paste' className='block text-xs text-slate-400'>
          Or paste many names, one per line
        </label>
        <textarea id='groups-paste' rows={3} className={field} value={paste} onChange={(e) => setPaste(e.target.value)} />
        <button type='button' onClick={addPasted} disabled={!paste.trim()} className='rounded-lg border border-white/15 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-50'>
          Add these
        </button>
      </div>

      <div className='flex items-center gap-3'>
        <button type='button' onClick={() => void save()} disabled={saving} className='rounded-lg bg-cyan-500/85 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50'>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {note && (
          <p role={note.ok ? 'status' : 'alert'} className={`text-sm ${note.ok ? 'text-emerald-200' : 'text-red-300'}`}>
            {note.text}
          </p>
        )}
      </div>

      <div className='space-y-2'>
        <h3 className='text-sm font-medium text-slate-200'>Sent after each session</h3>
        {data.sends.length === 0 ? (
          <p className='text-sm text-slate-400'>Nothing yet. The first is sent a few minutes after the next session ends.</p>
        ) : (
          <ul className='space-y-2'>
            {data.sends.map((s) => (
              <li key={s.start} className='rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-300'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span>
                    {when(s)} · {s.attended} attended
                  </span>
                  <a href={s.download} className='text-cyan-300 underline'>
                    Download spreadsheet
                  </a>
                </div>
                {s.leaders.length > 0 && (
                  <p className='mt-1 text-xs text-slate-400'>
                    Sent to {s.leaders.filter((l) => l.kc || l.email).length} of {s.leaders.length} leaders
                    {s.leaders.some((l) => !l.kc && !l.email) ? ` (not reached: ${s.leaders.filter((l) => !l.kc && !l.email).map((l) => l.group).join(', ')})` : ''}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
