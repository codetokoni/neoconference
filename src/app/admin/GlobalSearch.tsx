"use client";

// src/app/admin/GlobalSearch.tsx
//
// The admin top bar's search box: users, groups, meetings, payments, tickets,
// files and audit entries — whichever the role can open — from
// /api/admin/search. Keyboard: Ctrl+K (⌘K) or "/" to focus, ↑/↓ to move,
// Enter to open, Escape to close.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CategoryResult } from "@/lib/admin/search";
import { errorText, useAdmin } from "./AdminApi";

type Row = { key: string; title: string; sub: string; href: string; more?: boolean };

const DEBOUNCE_MS = 250;

export default function GlobalSearch() {
  const { adminFetch } = useAdmin();
  const router = useRouter();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CategoryResult[] | null>(null);
  // The term the shown results belong to (what is typed may already be newer).
  const [resultsFor, setResultsFor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  // Ctrl+K / ⌘K anywhere, or "/" when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const search = useCallback(
    async (term: string) => {
      const mine = ++seq.current;
      if (term.trim().length < 2) {
        setResults(null);
        setBusy(false);
        setError(null);
        return;
      }
      setBusy(true);
      const r = await adminFetch<{ categories: CategoryResult[] }>(`/api/admin/search?q=${encodeURIComponent(term.trim())}`);
      if (mine !== seq.current) return; // a newer search has started
      setBusy(false);
      if (!r.ok) {
        setError(`Search failed: ${errorText(r)}`);
        setResults(null);
        return;
      }
      setError(null);
      setResults(r.data.categories);
      setResultsFor(term.trim());
      setActive(0);
    },
    [adminFetch],
  );

  useEffect(() => {
    const t = setTimeout(() => search(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, search]);

  // One list of options across every category, in the order they are drawn,
  // so ↑/↓ walk straight through the sections.
  let offset = 0;
  const groups = (results ?? []).map((c) => {
    const own: Row[] =
      c.status === "ok"
        ? [
            ...c.items.map((it) => ({ key: `${c.id}:${it.id}`, title: it.title, sub: it.sub, href: it.href })),
            ...(c.more ? [{ key: `${c.id}:more`, title: `All ${c.label.toLowerCase()} matching “${resultsFor}” →`, sub: "", href: c.more, more: true }] : []),
          ]
        : [];
    const g = { c, rows: own, first: offset };
    offset += own.length;
    return g;
  });
  const rows = groups.flatMap((g) => g.rows);
  const go = (row: Row | undefined) => {
    if (!row) return;
    setOpen(false);
    router.push(row.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (rows.length ? (a + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(rows[active]);
    } else if (e.key === "Escape") {
      if (open) setOpen(false);
      else setQ("");
    }
  };

  const showPanel = open && q.trim().length >= 2;
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const found = rows.filter((r) => !r.more).length;
  // What a screen reader hears as the results change.
  const announce = !showPanel
    ? ""
    : busy
      ? "Searching…"
      : error
        ? ""
        : results
          ? results.length === 0
            ? "Your role cannot search any of these lists."
            : `${found} result${found === 1 ? "" : "s"} for “${resultsFor}”${found ? ". Use the up and down arrows to choose one." : "."}`
          : "";

  return (
    <div ref={box} className="relative mb-4">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search the admin
      </label>
      <input
        ref={input}
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && rows.length ? optionId(active) : undefined}
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          // Say "Searching…" from the first keystroke of every new search, not only the first one.
          setBusy(e.target.value.trim().length >= 2);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search users, groups, meetings, payments, tickets, files, audit…  (Ctrl K)"
        className="w-full rounded-xl border border-white/12 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70 focus-visible:ring-2 focus-visible:ring-cyan-400/50"
      />
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {showPanel && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0B1220] p-1 shadow-2xl">
          {busy && <p className="px-3 py-2 text-sm text-zinc-400">Searching…</p>}
          {error && (
            <p role="alert" className="px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          {results && results.length === 0 && <p className="px-3 py-2 text-sm text-zinc-400">Your role cannot search any of these lists.</p>}
          {!busy && results && results.length > 0 && rows.length === 0 && results.every((c) => c.status === "ok") && (
            <p className="px-3 py-2 text-sm text-zinc-400">Nothing matches “{resultsFor}”.</p>
          )}
          <ul id={listId} role="listbox" aria-label={resultsFor ? `Search results for ${resultsFor}` : "Search results"} className={busy ? "opacity-60" : ""}>
            {groups.map(({ c, rows: own, first }) => (
              <li key={c.id} role="group" aria-labelledby={`${listId}-cat-${c.id}`} aria-describedby={own.length === 0 ? `${listId}-note-${c.id}` : undefined}>
                <p id={`${listId}-cat-${c.id}`} role="presentation" className="px-3 pb-0.5 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                  {c.label}
                </p>
                {c.status === "error" ? (
                  <p id={`${listId}-note-${c.id}`} role="presentation" className="px-3 py-1 text-xs text-red-300">
                    Could not search {c.label.toLowerCase()}: {c.message}
                  </p>
                ) : own.length === 0 ? (
                  <p id={`${listId}-note-${c.id}`} role="presentation" className="px-3 py-1 text-xs text-zinc-400">
                    No matches
                  </p>
                ) : (
                  <ul role="presentation">
                    {own.map((it, j) => {
                      const i = first + j;
                      const selected = i === active;
                      return (
                        <li
                          key={it.key}
                          id={optionId(i)}
                          role="option"
                          aria-selected={selected}
                          onMouseEnter={() => setActive(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => go(it)}
                          className={`cursor-pointer rounded-lg px-3 py-1.5 ${selected ? "bg-cyan-400/10" : ""}`}
                        >
                          <span className={`block truncate text-sm ${it.more ? "text-cyan-300" : "text-zinc-100"}`}>{it.title}</span>
                          {it.sub && <span className="block truncate text-xs text-zinc-400">{it.sub}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
