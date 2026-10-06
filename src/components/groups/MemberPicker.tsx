"use client";

// Choose group members: a search box over a list of checkboxes. Used to start
// a private call and, in the room, to add people to one.

import { useMemo, useState } from "react";

export interface PickableMember {
  userId: string;
  name: string;
  email?: string;
}

export default function MemberPicker({
  members,
  selected,
  onChange,
  emptyText,
}: {
  members: PickableMember[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyText: string;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q));
  }, [members, query]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  if (members.length === 0) return <p className="text-sm text-slate-400">{emptyText}</p>;

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members"
        aria-label="Search members"
        className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm"
      />
      <ul className="max-h-64 overflow-y-auto space-y-1 pr-1">
        {shown.map((m) => (
          <li key={m.userId}>
            <label className="flex items-center gap-3 rounded-lg px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(m.userId)}
                onChange={() => toggle(m.userId)}
                className="h-4 w-4 accent-cyan-400"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-100">{m.name}</span>
                {m.email ? <span className="block truncate text-xs text-slate-400">{m.email}</span> : null}
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-1 text-sm text-slate-400">No one matches “{query}”.</li> : null}
      </ul>
    </div>
  );
}
