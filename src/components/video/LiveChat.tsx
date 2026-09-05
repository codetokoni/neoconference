"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/simulcast";

const NAME_KEY = "nc:video-chat-name";

export default function LiveChat({ room, code }: { room: string; code: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const cursor = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      setName(localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const r = await fetch(
        `/api/video/chat?room=${encodeURIComponent(room)}&after=${cursor.current}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!j.ok || !j.messages?.length) return;
      cursor.current = j.cursor;
      setMessages((prev) => [...prev, ...j.messages].slice(-200));
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 2500);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    const who = name.trim() || "Guest";
    try {
      localStorage.setItem(NAME_KEY, who);
    } catch {
      /* private mode */
    }

    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/video/chat?room=${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: who, text, code }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error ?? "Message did not send.");
        return;
      }
      setDraft("");
      poll();
    } catch {
      setError("Message did not send. Check your connection.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-[420px] flex-col border-t border-white/10 bg-neutral-50 text-neutral-900 lg:border-l lg:border-t-0 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="flex items-center justify-between gap-3 border-b border-black/5 px-4 py-3 dark:border-white/10">
        <h2 className="text-sm font-semibold">Live chat</h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
          Room · {room}
        </span>
      </div>

      <div ref={logRef} className="flex max-h-[360px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <p className="text-sm text-neutral-500">No messages yet. Say hello.</p>}
        {messages.map((m) => (
          <div key={m.seq} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs text-neutral-500">
              <b className="font-semibold text-neutral-700 dark:text-neutral-300">{m.name}</b>
              {m.code && (
                <span className="rounded-sm border border-black/10 px-1 font-mono text-[9px] uppercase tracking-wider dark:border-white/15">
                  {m.code}
                </span>
              )}
            </span>
            <span className="text-sm">{m.text}</span>
          </div>
        ))}
      </div>

      {error && <p className="px-4 pb-1 text-xs text-red-600 dark:text-red-400">{error}</p>}

      <form onSubmit={send} className="flex flex-col gap-2 border-t border-black/5 p-3 dark:border-white/10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          placeholder="Your name"
          aria-label="Display name"
          className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/15 dark:bg-neutral-950"
        />
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={300}
            placeholder="Say something…"
            aria-label="Chat message"
            className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/15 dark:bg-neutral-950"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
