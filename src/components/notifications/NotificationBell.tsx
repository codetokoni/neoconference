"use client";

// The bell in the header: unread count, and a list of the latest
// notifications. Refreshed when it mounts, when the window regains focus,
// and when the service worker reports a push — never on a timer.

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { NOTIFICATIONS_CHANGED } from "@/lib/pushClient";

interface Item {
  id: string;
  ts: number;
  type: string;
  title: string;
  body: string;
  url: string;
  read: boolean;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/me/notifications", { cache: "no-store" });
      if (!res.ok) return setFailed(true);
      const data = (await res.json()) as { items: Item[]; unread: number };
      setItems(data.items);
      setUnread(data.unread);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [load]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function mark(body: { all: true } | { ids: string[] }) {
    const res = await fetch("/api/me/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { unread: number };
    setUnread(data.unread);
    setItems((prev) =>
      prev.map((n) => ("all" in body || body.ids.includes(n.id) ? { ...n, read: true } : n))
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-cyan-100/80 hover:text-white hover:bg-white/5 transition"
      >
        <Bell className="h-[18px] w-[18px]" aria-hidden />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-[10px] font-semibold leading-[18px] text-white text-center">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <span className="text-sm font-semibold text-slate-100">Notifications</span>
            {unread > 0 ? (
              <button type="button" onClick={() => mark({ all: true })} className="text-xs text-cyan-300 hover:text-cyan-200">
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {failed && items.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-slate-400">Couldn&apos;t load notifications.</li>
            ) : items.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-slate-400">Nothing yet.</li>
            ) : (
              items.map((n) => (
                <li key={n.id} role="none">
                  <a
                    role="menuitem"
                    href={n.url}
                    onClick={() => {
                      if (!n.read) void mark({ ids: [n.id] });
                    }}
                    className={
                      "block px-4 py-3 border-b border-slate-800/60 hover:bg-slate-900/70 transition " +
                      (n.read ? "" : "bg-cyan-500/5")
                    }
                  >
                    <div className="flex items-start gap-2">
                      {!n.read ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-cyan-400" aria-label="Unread" /> : null}
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 break-words">{n.title}</div>
                        {n.body ? <div className="text-xs text-slate-400 break-words">{n.body}</div> : null}
                        <div className="mt-0.5 text-[11px] text-slate-500">{ago(n.ts)}</div>
                      </div>
                    </div>
                  </a>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
