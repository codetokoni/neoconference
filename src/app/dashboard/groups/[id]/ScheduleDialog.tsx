"use client";

// Schedule a group meeting, or change one. Every rule the server enforces is
// checked inline first, so the form says what is wrong before sending it.

import { useMemo, useState } from "react";
import type { MeetingListItem } from "@/lib/groupMeetings";
import { isoToWallTime, wallTimeToIso } from "@/lib/zonedTime";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";

const inputClass =
  "w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm";
const errorInput = " border-rose-500 focus:border-rose-400";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(current: string): string[] {
  const all =
    (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set([current, viewerTimezone(), "UTC", ...all]));
}

/** "Sent to 12, couldn't reach 2" — what the server says it delivered. */
export function deliveryText(n: { sent: number; unreachable: number } | undefined): string {
  if (!n) return "";
  if (n.sent === 0 && n.unreachable === 0) return "";
  if (n.unreachable === 0) return `Sent to ${n.sent}.`;
  return `Sent to ${n.sent}, couldn't reach ${n.unreachable}.`;
}

type Recurrence = "none" | "daily" | "weekly" | "monthly";

export default function ScheduleDialog({
  groupId,
  groupName,
  editing,
  onClose,
  onDone,
}: {
  groupId: string;
  groupName: string;
  /** The meeting being changed; absent to schedule a new one. */
  editing?: MeetingListItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const startTz = editing?.timezone || viewerTimezone();
  const [title, setTitle] = useState(editing?.title ?? `${groupName} meeting`);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [timezone, setTimezone] = useState(startTz);
  const [when, setWhen] = useState(() =>
    editing ? isoToWallTime(editing.start, startTz) : isoToWallTime(new Date(Date.now() + 60 * 60_000).toISOString(), startTz).slice(0, 14) + "00"
  );
  const [duration, setDuration] = useState(String(editing?.durationMin ?? 60));
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [waitingRoom, setWaitingRoom] = useState(editing?.waitingRoom ?? true);
  const [extraEmails, setExtraEmails] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  const [interval, setIntervalValue] = useState("1");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [endBy, setEndBy] = useState<"count" | "until">("count");
  const [count, setCount] = useState("4");
  const [until, setUntil] = useState("");
  const [scope, setScope] = useState<"this" | "following">("this");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const zones = useMemo(() => timezones(timezone), [timezone]);

  const startIso = wallTimeToIso(when, timezone);
  const durationN = Number(duration);
  const intervalN = Number(interval);
  const countN = Number(count);
  const emails = extraEmails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const errors = {
    title: !title.trim() ? "Give the meeting a title." : title.trim().length > 120 ? "120 characters at most." : null,
    when: !startIso ? "Choose a date and time." : Date.parse(startIso) < Date.now() ? "Choose a time in the future." : null,
    duration:
      !Number.isInteger(durationN) || durationN < 5 || durationN > 480 ? "Between 5 and 480 minutes." : null,
    interval:
      recurrence !== "none" && (!Number.isInteger(intervalN) || intervalN < 1 || intervalN > 12) ? "1 to 12." : null,
    end:
      recurrence === "none"
        ? null
        : endBy === "count"
          ? !Number.isInteger(countN) || countN < 1 || countN > 52
            ? "1 to 52 meetings."
            : null
          : !/^\d{4}-\d{2}-\d{2}$/.test(until)
            ? "Choose the last date."
            : startIso && until < when.slice(0, 10)
              ? "The last date must be on or after the first meeting."
              : null,
    emails: emails.find((e) => !EMAIL.test(e)) ? "One of these is not an email address." : emails.length > 50 ? "50 at most." : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (touched ? errors[k] : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid || !startIso) return;
    setBusy(true);
    setErr(null);
    try {
      let res: Response;
      if (editing) {
        res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/meetings/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope,
            title: title.trim(),
            description: description.trim(),
            scheduledAt: startIso,
            durationMin: durationN,
            waitingRoom,
            ...(removePassword ? { password: null } : password ? { password } : {}),
          }),
        });
      } else {
        res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/meetings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "scheduled",
            title: title.trim(),
            description: description.trim(),
            scheduledAt: startIso,
            durationMin: durationN,
            timezone,
            waitingRoom,
            ...(password ? { password } : {}),
            ...(emails.length ? { extraEmails: emails } : {}),
            ...(recurrence !== "none"
              ? {
                  recurrence: {
                    freq: recurrence,
                    interval: intervalN,
                    ...(recurrence === "weekly" && weekdays.length ? { byWeekday: weekdays } : {}),
                    ...(endBy === "count" ? { count: countN } : { until }),
                  },
                }
              : {}),
          }),
        });
      }
      if (!res.ok) {
        setErr(await groupErrorFrom(res));
        setBusy(false);
        return;
      }
      const data = (await res.json()) as {
        events?: unknown[];
        updated?: unknown[];
        notified?: { sent: number; unreachable: number };
      };
      const made = editing
        ? `Updated ${data.updated?.length ?? 1} ${data.updated?.length === 1 ? "meeting" : "meetings"}.`
        : `Scheduled ${data.events?.length ?? 1} ${data.events?.length === 1 ? "meeting" : "meetings"}.`;
      onDone([made, deliveryText(data.notified)].filter(Boolean).join(" "));
    } catch {
      setErr(groupErrorMessage(null));
      setBusy(false);
    }
  }

  const fieldError = (text: string | null) => (text ? <p className="text-xs text-rose-300">{text}</p> : null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4"
      onClick={() => !busy && onClose()}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        noValidate
        className="w-full sm:max-w-lg max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden"
      >
        <div className="px-6 py-5 border-b border-slate-800">
          <h2 id="schedule-title" className="text-lg font-semibold text-slate-100">
            {editing ? "Change meeting" : "Schedule a meeting"}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            {editing ? "Everyone invited is told about the change." : `Everyone in ${groupName} is invited and gets an email with a calendar invite.`}
          </p>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto text-sm">
          <div className="space-y-1.5">
            <label htmlFor="mtg-title" className="text-xs text-slate-400">Title</label>
            <input id="mtg-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} className={inputClass + (show("title") ? errorInput : "")} />
            {fieldError(show("title"))}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="mtg-desc" className="text-xs text-slate-400">Description (optional)</label>
            <textarea id="mtg-desc" value={description} maxLength={2000} rows={2} onChange={(e) => setDescription(e.target.value)} className={inputClass + " resize-none"} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="mtg-when" className="text-xs text-slate-400">Date and time</label>
              <input id="mtg-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputClass + " [color-scheme:dark]" + (show("when") ? errorInput : "")} />
              {fieldError(show("when"))}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mtg-duration" className="text-xs text-slate-400">Duration (minutes)</label>
              <input id="mtg-duration" type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} className={inputClass + (show("duration") ? errorInput : "")} />
              {fieldError(show("duration"))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="mtg-tz" className="text-xs text-slate-400">Timezone</label>
            <select id="mtg-tz" value={timezone} disabled={Boolean(editing)} onChange={(e) => setTimezone(e.target.value)} className={inputClass + " disabled:opacity-60"}>
              {zones.map((z) => (
                <option key={z} value={z} className="bg-slate-900 text-slate-100">{z}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="mtg-password" className="text-xs text-slate-400">
                {editing?.hasPassword ? "New password (blank keeps it)" : "Password (optional)"}
              </label>
              <input id="mtg-password" type="text" autoComplete="off" value={password} maxLength={80} disabled={removePassword} onChange={(e) => setPassword(e.target.value)} className={inputClass + " disabled:opacity-60"} />
              {editing?.hasPassword ? (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} className="h-4 w-4 accent-cyan-400" />
                  Remove the password
                </label>
              ) : null}
            </div>
            <label className="flex items-start gap-2 pt-6 text-sm text-slate-200">
              <input type="checkbox" checked={waitingRoom} onChange={(e) => setWaitingRoom(e.target.checked)} className="mt-0.5 h-4 w-4 accent-cyan-400" />
              <span>
                Waiting room
                <span className="block text-xs text-slate-400">People who aren&apos;t invited wait to be let in. Invitees go straight in.</span>
              </span>
            </label>
          </div>

          {!editing ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="mtg-extras" className="text-xs text-slate-400">Also invite (emails, optional)</label>
                <textarea id="mtg-extras" value={extraEmails} rows={2} placeholder="guest@example.com, another@example.com" onChange={(e) => setExtraEmails(e.target.value)} className={inputClass + " resize-none" + (show("emails") ? errorInput : "")} />
                {fieldError(show("emails"))}
              </div>

              <fieldset className="space-y-3 rounded-xl border border-slate-800 p-3">
                <legend className="px-1 text-xs text-slate-400">Repeat</legend>
                <div className="flex flex-wrap gap-2">
                  {(["none", "daily", "weekly", "monthly"] as Recurrence[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRecurrence(r)}
                      aria-pressed={recurrence === r}
                      className={
                        "px-3 py-1.5 rounded-full text-xs border transition " +
                        (recurrence === r ? "border-cyan-400 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-300 hover:border-slate-500")
                      }
                    >
                      {r === "none" ? "Doesn't repeat" : r[0].toUpperCase() + r.slice(1)}
                    </button>
                  ))}
                </div>
                {recurrence !== "none" ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-slate-200">
                      <span>Every</span>
                      <input aria-label="Interval" type="number" min={1} max={12} value={interval} onChange={(e) => setIntervalValue(e.target.value)} className={inputClass + " w-20" + (show("interval") ? errorInput : "")} />
                      <span>{recurrence === "daily" ? "day(s)" : recurrence === "weekly" ? "week(s)" : "month(s)"}</span>
                    </div>
                    {fieldError(show("interval"))}
                    {recurrence === "weekly" ? (
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
                        {WEEKDAY_LABELS.map((label, i) => (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={weekdays.includes(i)}
                            onClick={() => setWeekdays((w) => (w.includes(i) ? w.filter((d) => d !== i) : [...w, i].sort()))}
                            className={
                              "w-11 py-1.5 rounded-lg text-xs border transition " +
                              (weekdays.includes(i) ? "border-cyan-400 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-300 hover:border-slate-500")
                            }
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 text-slate-200">
                      <select aria-label="Ends" value={endBy} onChange={(e) => setEndBy(e.target.value as "count" | "until")} className={inputClass + " w-auto"}>
                        <option value="count" className="bg-slate-900 text-slate-100">After</option>
                        <option value="until" className="bg-slate-900 text-slate-100">Until</option>
                      </select>
                      {endBy === "count" ? (
                        <>
                          <input aria-label="Number of meetings" type="number" min={1} max={52} value={count} onChange={(e) => setCount(e.target.value)} className={inputClass + " w-20" + (show("end") ? errorInput : "")} />
                          <span>meetings</span>
                        </>
                      ) : (
                        <input aria-label="Last date" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={inputClass + " w-auto [color-scheme:dark]" + (show("end") ? errorInput : "")} />
                      )}
                    </div>
                    {fieldError(show("end"))}
                    <p className="text-xs text-slate-400">Up to 12 meetings within the next 90 days are created now.</p>
                  </div>
                ) : null}
              </fieldset>
            </>
          ) : editing.seriesId ? (
            <fieldset className="space-y-2 rounded-xl border border-slate-800 p-3">
              <legend className="px-1 text-xs text-slate-400">Apply to</legend>
              {(["this", "following"] as const).map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm text-slate-200">
                  <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} className="h-4 w-4 accent-cyan-400" />
                  {s === "this" ? "This meeting" : "This and following meetings"}
                </label>
              ))}
            </fieldset>
          ) : null}

          {err ? <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div> : null}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
          <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60">
            {busy ? "Saving…" : editing ? "Save changes" : "Schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}
