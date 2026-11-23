"use client";

// "Your church or group" on the join screen and the full-name step, for a
// meeting that lists them (src/lib/attendanceGroups.ts): picked once and
// remembered for that meeting, so its organisers and each group's leader get
// their people's attendance after every session.

export const GROUP_REQUIRED = "Choose your church or group.";

export default function GroupPicker({
  groups,
  value,
  onChange,
  problem,
  id = "attendance-group",
  className = "",
}: {
  groups: string[];
  value: string;
  onChange: (group: string) => void;
  problem?: string;
  id?: string;
  className?: string;
}) {
  if (!groups.length) return null;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[11px] uppercase tracking-[0.25em] text-cyan-400/70 mb-2">
        Your church or group
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-help`}
        className="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 text-base text-white"
      >
        <option value="">Choose…</option>
        {groups.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      <p id={`${id}-help`} role={problem ? "alert" : undefined} className={`text-xs mt-1 ${problem ? "text-rose-300" : "text-zinc-400"}`}>
        {problem || "Your group's leader gets the attendance of their people after the meeting."}
      </p>
    </div>
  );
}
