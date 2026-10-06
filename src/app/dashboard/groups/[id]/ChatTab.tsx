"use client";

// The group's chat. Messages with day separators, replies, @mentions (with
// suggestions from the members), pictures and files, and delete. While a
// group meeting is on, a "Live now · Join" bar sits on top.
//
// It asks for news every 3 seconds, but only while this tab is open and the
// page is in view; the server answers "unchanged" from a single counter read
// when nothing happened.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Reply, Trash2, X } from "lucide-react";
import type { GroupMember } from "@/lib/groupStore";
import type { ChatMessageView } from "@/lib/groupChatView";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import { roomHref } from "./GroupActions";
import { useModal } from "@/components/ui/useModal";

const POLL_MS = 3_000;
const MAX_LEN = 8000;

interface Pending {
  key: string;
  url: string | null;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "file";
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Merge a fresh window of messages into what is shown, by id, oldest first. */
function merge(shown: ChatMessageView[], fresh: ChatMessageView[]): ChatMessageView[] {
  const byId = new Map(shown.map((m) => [m.id, m]));
  for (const m of fresh) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

export default function ChatTab({
  groupId,
  meId,
  members,
  canModerate,
  active,
  onUnreadCleared,
}: {
  groupId: string;
  meId: string;
  members: GroupMember[];
  canModerate: boolean;
  /** This tab is the one open. */
  active: boolean;
  onUnreadCleared: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [live, setLive] = useState<Array<{ slug: string; title: string }>>([]);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChatMessageView | null>(null);
  const [visible, setVisible] = useState(true);
  const [caret, setCaret] = useState(0);
  const verRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastMarked = useRef<string>("");
  const deleteBoxRef = useRef<HTMLDivElement>(null);
  useModal(deleteBoxRef, () => setConfirmDelete(null), { open: confirmDelete !== null });
  const base = `/api/groups/${encodeURIComponent(groupId)}/messages`;

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const markRead = useCallback(
    (latest: ChatMessageView[]) => {
      const last = latest.at(-1)?.ts ?? "";
      if (!last || last === lastMarked.current) return;
      lastMarked.current = last;
      void fetch(`${base}/read`, { method: "POST" }).then(() => onUnreadCleared()).catch(() => undefined);
    },
    [base, onUnreadCleared]
  );

  const poll = useCallback(async () => {
    try {
      const v = verRef.current;
      const res = await fetch(v === null ? base : `${base}?sinceVer=${v}`, { cache: "no-store" });
      if (!res.ok) {
        if (v === null) setErr(await groupErrorFrom(res));
        return;
      }
      const data = (await res.json()) as
        | { unchanged: true; ver: number }
        | { ver: number; messages: ChatMessageView[]; hasOlder: boolean; live: Array<{ slug: string; title: string }> };
      if ("unchanged" in data) return;
      const el = listRef.current;
      const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      const first = verRef.current === null;
      verRef.current = data.ver;
      setMessages((prev) => {
        const next = merge(prev, data.messages);
        markRead(next);
        return next;
      });
      if (first) setHasOlder(data.hasOlder);
      setLive(data.live);
      setLoaded(true);
      if (first || atBottom) scrollToEnd();
    } catch {
      /* the next poll tries again */
    }
  }, [base, markRead]);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Poll only while open and in view.
  useEffect(() => {
    if (!active || !visible) return;
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, visible, poll]);

  async function loadOlder() {
    const oldest = messages[0];
    if (!oldest) return;
    const el = listRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const res = await fetch(`${base}?before=${encodeURIComponent(oldest.id)}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { messages: ChatMessageView[]; hasOlder: boolean };
    setMessages((prev) => merge(data.messages, prev));
    setHasOlder(data.hasOlder);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom;
    });
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setErr(null);
    try {
      for (const file of Array.from(files).slice(0, 5 - pending.length)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/upload`, { method: "POST", body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setErr(
            body.error === "too_large"
              ? `${file.name} is over 10 MB.`
              : body.error === "unsupported_type"
                ? `${file.name} isn't a type that can be shared here.`
                : groupErrorMessage(body.error)
          );
          continue;
        }
        const data = (await res.json()) as { attachment: Pending };
        setPending((p) => [...p, data.attachment]);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function send() {
    const body = text.trim();
    if (!body && pending.length === 0) return;
    if (body.length > MAX_LEN) return setErr(`A message can be up to ${MAX_LEN} characters.`);
    setSending(true);
    setErr(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: body,
          ...(replyTo ? { replyToId: replyTo.id } : {}),
          ...(pending.length ? { attachments: pending.map(({ key, name, size, mime, kind }) => ({ key, name, size, mime, kind })) } : {}),
        }),
      });
      if (!res.ok) {
        const body2 = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body2.error === "rate_limited" ? "You're sending messages too quickly. Wait a moment." : groupErrorMessage(body2.error));
        return;
      }
      setText("");
      setReplyTo(null);
      setPending([]);
      await poll();
      scrollToEnd();
    } catch {
      setErr(groupErrorMessage(null));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function remove(m: ChatMessageView) {
    const res = await fetch(`${base}/${encodeURIComponent(m.id)}`, { method: "DELETE" }).catch(() => null);
    setConfirmDelete(null);
    if (!res?.ok) {
      setErr(res ? await groupErrorFrom(res) : groupErrorMessage(null));
      return;
    }
    await poll();
  }

  // @mention suggestions: the word being typed at the caret, if it starts with @.
  const mentionQuery = useMemo(() => {
    const upto = text.slice(0, caret);
    const m = upto.match(/(?:^|\s)@([\p{L}\p{N}_ ]{0,30})$/u);
    return m ? m[1] : null;
  }, [text, caret]);
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return members.filter((m) => m.userId !== meId && m.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mentionQuery, members, meId]);

  function pick(name: string) {
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf("@");
    const next = `${text.slice(0, at)}@${name} ${text.slice(caret)}`;
    setText(next);
    const pos = at + name.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  const meName = members.find((m) => m.userId === meId)?.name ?? "";

  return (
    <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/30 overflow-hidden">
      {live.map((l) => (
        <a key={l.slug} href={roomHref(l.slug)} className="flex items-center gap-2 bg-rose-500/15 border-b border-rose-400/30 px-4 py-2.5 text-sm text-rose-100 hover:bg-rose-500/20">
          <span className="h-2 w-2 rounded-full bg-rose-400 animate-pulse" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{l.title}</span>
          <span className="shrink-0 font-semibold">Live now · Join</span>
        </a>
      ))}

      <div ref={listRef} className="h-[min(60vh,560px)] overflow-y-auto px-3 sm:px-4 py-3 space-y-1" aria-live="polite">
        {hasOlder ? (
          <div className="text-center py-2">
            <button type="button" onClick={loadOlder} className="text-xs text-cyan-300 hover:text-cyan-200">Show earlier messages</button>
          </div>
        ) : null}
        {!loaded ? (
          err ? null : <p className="text-sm text-slate-400 py-6 text-center">Loading chat…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-400 py-10 text-center">No messages yet. Say hello.</p>
        ) : (
          messages.map((m, i) => {
            const day = dayLabel(m.ts);
            const newDay = i === 0 || dayLabel(messages[i - 1].ts) !== day;
            const mine = m.userId === meId;
            const mentionsMe = Boolean(m.mentions?.includes(meId));
            return (
              <div key={m.id}>
                {newDay ? (
                  <div className="my-3 flex items-center gap-3 text-[11px] uppercase tracking-widest text-slate-500">
                    <span className="h-px flex-1 bg-slate-800" />
                    {day}
                    <span className="h-px flex-1 bg-slate-800" />
                  </div>
                ) : null}
                {m.system ? (
                  <div className="my-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-center text-xs text-slate-300 whitespace-pre-line">
                    {m.text}
                    {m.link && !m.deleted ? (
                      <>
                        {" "}
                        <a href={m.link.href} className="text-cyan-300 hover:text-cyan-200 whitespace-nowrap">{m.link.label}</a>
                      </>
                    ) : null}
                    <span className="ml-2 text-slate-500">{clock(m.ts)}</span>
                  </div>
                ) : (
                  <div className={"group relative rounded-xl px-3 py-2 " + (mentionsMe ? "bg-cyan-500/10 border border-cyan-400/20" : "hover:bg-slate-900/60")}>
                    <div className="flex items-baseline gap-2">
                      <span className={"text-sm font-medium " + (mine ? "text-cyan-200" : "text-slate-100")}>{m.name}</span>
                      <span className="text-[11px] text-slate-500">{clock(m.ts)}</span>
                    </div>
                    {m.replyTo ? (
                      <div className="mt-1 border-l-2 border-slate-600 pl-2 text-xs text-slate-400 line-clamp-2 [overflow-wrap:anywhere]">
                        <span className="text-slate-300">{m.replyTo.name}:</span> {m.replyTo.snippet}
                      </div>
                    ) : null}
                    <p className={"mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm " + (m.deleted ? "italic text-slate-500" : "text-slate-200")}>{m.text}</p>
                    {m.attachments?.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.attachments.map((a, k) =>
                          a.kind === "image" && a.url ? (
                            <a key={k} href={a.url} target="_blank" rel="noreferrer" className="block">
                              {/* eslint-disable-next-line @next/next/no-img-element -- signed R2 links */}
                              <img src={a.url} alt={a.name} className="max-h-48 max-w-[min(18rem,70vw)] rounded-lg border border-slate-800 object-cover" />
                            </a>
                          ) : (
                            <a
                              key={k}
                              href={a.url ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              aria-disabled={!a.url}
                              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500"
                            >
                              <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              <span className="truncate">{a.name}</span>
                              <span className="shrink-0 text-slate-500">{sizeText(a.size)}</span>
                            </a>
                          )
                        )}
                      </div>
                    ) : null}
                    {!m.deleted ? (
                      <div className="absolute right-2 top-1.5 hidden gap-1 group-hover:flex group-focus-within:flex">
                        <button type="button" onClick={() => { setReplyTo(m); inputRef.current?.focus(); }} aria-label={`Reply to ${m.name}`} className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100">
                          <Reply className="h-4 w-4" aria-hidden />
                        </button>
                        {mine || canModerate ? (
                          <button type="button" onClick={() => setConfirmDelete(m)} aria-label="Delete message" className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-300">
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-slate-800 p-3 space-y-2 relative">
        {err ? <p className="text-xs text-rose-300">{err}</p> : null}
        {replyTo ? (
          <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs text-slate-300">
            <Reply className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Replying to <span className="text-slate-100">{replyTo.name}</span>: {replyTo.text}</span>
            <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="text-slate-400 hover:text-slate-100">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
        {pending.length ? (
          <div className="flex flex-wrap gap-2">
            {pending.map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">
                <Paperclip className="h-3 w-3" aria-hidden />
                <span className="max-w-[10rem] truncate">{p.name}</span>
                <button type="button" onClick={() => setPending((all) => all.filter((x) => x.key !== p.key))} aria-label={`Remove ${p.name}`} className="text-slate-400 hover:text-slate-100">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {suggestions.length ? (
          <ul role="listbox" aria-label="Mention a member" className="absolute bottom-full left-3 mb-1 w-64 rounded-xl border border-slate-700 bg-[#0a0b12] text-slate-100 shadow-xl overflow-hidden z-10">
            {suggestions.map((s) => (
              <li key={s.userId} role="option" aria-selected="false">
                <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(s.name); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-800">
                  @{s.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-end gap-2"
        >
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || pending.length >= 5}
            aria-label="Attach a file"
            className="shrink-0 rounded-full border border-slate-700 p-2 text-slate-300 hover:border-slate-500 disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
          </button>
          <label htmlFor="group-chat-input" className="sr-only">Message</label>
          <textarea
            id="group-chat-input"
            ref={inputRef}
            value={text}
            rows={1}
            maxLength={MAX_LEN}
            placeholder={meName ? `Message as ${meName}` : "Message"}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (suggestions.length) pick(suggestions[0].name);
                else void send();
              }
            }}
            className="min-h-[40px] max-h-40 flex-1 resize-y rounded-xl bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={sending || uploading || (!text.trim() && pending.length === 0)}
            className="shrink-0 rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 transition disabled:opacity-60"
          >
            {uploading ? "Uploading…" : sending ? "Sending…" : "Send"}
          </button>
        </form>
      </div>

      {confirmDelete ? (
        <div role="dialog" aria-modal="true" aria-labelledby="delete-msg-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setConfirmDelete(null)}>
          <div ref={deleteBoxRef} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-rose-500/30 bg-[#0a0b12] text-slate-100 shadow-2xl p-5 space-y-4">
            <h2 id="delete-msg-title" className="text-base font-semibold text-slate-100">Delete this message?</h2>
            <p className="text-sm text-slate-300 line-clamp-3">{confirmDelete.text}</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 text-sm">Keep it</button>
              <button type="button" onClick={() => remove(confirmDelete)} className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 text-sm">Delete</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
