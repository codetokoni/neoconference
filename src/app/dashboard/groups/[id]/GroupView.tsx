"use client";

import { useEffect, useRef, useState } from "react";
import { useModal } from "@/components/ui/useModal";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MeetingRole } from "@/lib/permissions";
import type { Group, GroupActivity, GroupCapabilities, GroupMember } from "@/lib/groupStore";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import GroupIcon from "../GroupIcon";
import UpgradeHint from "@/components/groups/UpgradeHint";
import GroupActions, { roomHref } from "./GroupActions";
import MeetingsTab from "./MeetingsTab";
import ReportsTab from "./ReportsTab";
import ChatTab from "./ChatTab";
import CallAlertsButton from "@/components/notifications/CallAlertsButton";

type Tab = "chat" | "members" | "meetings" | "reports" | "settings";
const TABS: Tab[] = ["chat", "members", "meetings", "reports", "settings"];

const ROLE_LABEL: Record<MeetingRole, string> = {
  owner: "Owner",
  host: "Host",
  moderator: "Moderator",
  participant: "Member",
};

const ROLE_BADGE: Record<MeetingRole, string> = {
  owner: "bg-amber-500/15 text-amber-100 border-amber-400/40",
  host: "bg-cyan-500/15 text-cyan-100 border-cyan-400/40",
  moderator: "bg-violet-500/15 text-violet-100 border-violet-400/40",
  participant: "bg-slate-800/60 text-slate-200 border-slate-700",
};

function RoleBadge({ role }: { role: MeetingRole }) {
  return (
    <span className={"shrink-0 text-xs px-2.5 py-1 rounded-full border " + ROLE_BADGE[role]}>{ROLE_LABEL[role]}</span>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

const inputClass =
  "w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 placeholder:text-slate-500 border border-slate-700 focus:border-cyan-400 focus:outline-none text-sm";

/* -------------------------------------------------------------------------- */
/*  Confirm dialog                                                             */
/* -------------------------------------------------------------------------- */

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  error,
  confirmDisabled,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  error: string | null;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useModal(boxRef, onCancel, { busy });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => !busy && onCancel()}
    >
      <div
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        className={
          "w-full max-w-md rounded-2xl border bg-[#0a0b12] text-slate-100 shadow-2xl overflow-hidden " +
          (danger ? "border-rose-500/30" : "border-slate-800")
        }
      >
        <div className="px-6 py-5 space-y-3 text-sm">
          <h2 id="group-confirm-title" className="text-lg font-semibold text-slate-100">
            {title}
          </h2>
          {body ? <p className="text-slate-300">{body}</p> : null}
          {children}
          {error ? (
            <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
              {error}
            </div>
          ) : null}
        </div>
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            className={
              "px-4 py-2 rounded-full font-medium transition text-sm disabled:opacity-50 disabled:cursor-not-allowed " +
              (danger ? "bg-rose-500 text-slate-950 hover:bg-rose-400" : "bg-cyan-500 text-slate-950 hover:bg-cyan-400")
            }
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function GroupView({
  group,
  members,
  activity,
  me,
  capabilities,
  chatUnread,
  initialTab,
  nextMeeting,
}: {
  group: Group;
  members: GroupMember[];
  activity: GroupActivity[];
  me: { userId: string; role: MeetingRole };
  capabilities: GroupCapabilities;
  /** Messages in the group's chat this person has not read. */
  chatUnread: number;
  /** ?tab= from the link that brought them (a mention opens the chat). */
  initialTab?: string;
  /** The soonest meeting this person is invited to, or the one on now. */
  nextMeeting: { slug: string; title: string; start: string; state: string } | null;
}) {
  const showSettings = capabilities.editSettings || capabilities.deleteGroup || capabilities.transferOwnership;
  // Members land in the chat; those who run the group, on its members.
  const [tab, setTab] = useState<Tab>(
    TABS.includes(initialTab as Tab) ? (initialTab as Tab) : me.role === "participant" ? "chat" : "members"
  );
  const [unread, setUnread] = useState(chatUnread);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "chat", label: unread > 0 ? `Chat (${unread > 99 ? "99+" : unread})` : "Chat" },
    { key: "members", label: "Members" },
    { key: "meetings", label: "Meetings" },
    { key: "reports", label: "Reports" },
    ...(showSettings ? [{ key: "settings" as Tab, label: "Settings" }] : []),
  ];
  const visibleActivity = showAllActivity ? activity : activity.slice(0, 5);
  const router = useRouter();
  const [meetingsVersion, setMeetingsVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  /** A meeting was created, changed or cancelled: show it, list it, log it. */
  function meetingsChanged(message: string) {
    setNotice(message);
    setMeetingsVersion((v) => v + 1);
    setTab("meetings");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-[#05070d] text-white">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10 md:py-14 space-y-8">
        <div>
          <Link href="/dashboard/groups" className="text-xs text-white/50 hover:text-white transition">
            ← Groups
          </Link>
          <div className="mt-4 flex items-start gap-4">
            <GroupIcon name={group.name} iconUrl={group.iconUrl} size={64} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white break-words">
                  {group.name}
                </h1>
                <RoleBadge role={me.role} />
              </div>
              {group.description ? (
                <p className="mt-1.5 text-sm text-slate-300 whitespace-pre-line break-words">{group.description}</p>
              ) : null}
              <p className="mt-1 text-xs text-slate-400">
                {members.length} {members.length === 1 ? "member" : "members"}
              </p>
              {nextMeeting ? <NextMeetingLine meeting={nextMeeting} /> : null}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-start justify-between gap-3">
            <GroupActions
              groupId={group.id}
              groupName={group.name}
              members={members}
              meId={me.userId}
              capabilities={capabilities}
              onChanged={meetingsChanged}
            />
            <CallAlertsButton compact />
          </div>
          {notice ? (
            <p role="status" className="mt-3 text-sm text-emerald-300">
              {notice}
            </p>
          ) : null}
        </div>

        <section aria-labelledby="activity-heading" className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <h2 id="activity-heading" className="text-xs uppercase tracking-widest text-slate-400">
            Recent activity
          </h2>
          {activity.length === 0 ? (
            <p className="mt-2 text-sm text-slate-400">Nothing yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {visibleActivity.map((a, i) => (
                <li key={`${a.ts}-${i}`} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 text-slate-200 break-words">{a.detail}</span>
                  <span className="shrink-0 text-xs text-slate-500">{timeAgo(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
          {activity.length > 5 ? (
            <button
              type="button"
              onClick={() => setShowAllActivity((v) => !v)}
              className="mt-2 text-xs text-cyan-300 hover:text-cyan-200"
            >
              {showAllActivity ? "Show less" : `Show all ${activity.length}`}
            </button>
          ) : null}
        </section>

        <div>
          <div role="tablist" aria-label="Group sections" className="flex gap-1 border-b border-slate-800 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={
                  "px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition " +
                  (tab === t.key
                    ? "border-cyan-400 text-cyan-100"
                    : "border-transparent text-slate-400 hover:text-slate-200")
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="pt-6">
            {tab === "chat" ? (
              <ChatTab
                groupId={group.id}
                meId={me.userId}
                members={members}
                canModerate={capabilities.manageMembers}
                active
                onUnreadCleared={() => setUnread(0)}
              />
            ) : tab === "members" ? (
              <MembersTab group={group} members={members} me={me} capabilities={capabilities} />
            ) : tab === "meetings" ? (
              <MeetingsTab
                groupId={group.id}
                groupName={group.name}
                canSchedule={capabilities.schedule}
                canViewReports={capabilities.viewReports}
                version={meetingsVersion}
                onChanged={meetingsChanged}
              />
            ) : tab === "reports" ? (
              <ReportsTab groupId={group.id} canView={capabilities.viewReports} canExport={capabilities.exportReports} />
            ) : (
              <SettingsTab group={group} members={members} me={me} capabilities={capabilities} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/** "Up next: Choir practice · Tue 10:00 · Join" under the group's name. */
function NextMeetingLine({ meeting }: { meeting: { slug: string; title: string; start: string; state: string } }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const live = meeting.state === "live";
  const joinable = live || (now !== null && Date.parse(meeting.start) - now <= 15 * 60_000);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-300">
      <span className={live ? "text-rose-200" : "text-cyan-200"}>{live ? "Live now:" : "Up next:"}</span>
      <span className="min-w-0 truncate text-slate-100">{meeting.title}</span>
      {!live && now !== null ? (
        <span className="text-slate-400">
          {new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(meeting.start))}
        </span>
      ) : null}
      {joinable ? (
        <a href={live ? roomHref(meeting.slug) : `/${encodeURIComponent(meeting.slug)}`} className="rounded-full bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-cyan-400">
          Join
        </a>
      ) : null}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  Members                                                                    */
/* -------------------------------------------------------------------------- */

function MembersTab({
  group,
  members,
  me,
  capabilities,
}: {
  group: Group;
  members: GroupMember[];
  me: { userId: string; role: MeetingRole };
  capabilities: GroupCapabilities;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [invite, setInvite] = useState<{ url: string; copied: boolean } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ userId: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<GroupMember | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);

  async function addByEmail(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) {
      setAddMsg({ kind: "err", text: "Enter an email address to add." });
      return;
    }
    setAdding(true);
    setAddMsg(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails: [value] }),
      });
      if (!res.ok) {
        setAddMsg({ kind: "err", text: await groupErrorFrom(res) });
        return;
      }
      const data = (await res.json()) as { added: GroupMember[]; alreadyMembers: string[] };
      if (data.added.length > 0) {
        setAddMsg({ kind: "ok", text: `Added ${data.added.map((m) => m.name).join(", ")}.` });
        setEmail("");
        router.refresh();
      } else {
        setAddMsg({ kind: "ok", text: "They are already in this group." });
      }
    } catch {
      setAddMsg({ kind: "err", text: groupErrorMessage(null) });
    } finally {
      setAdding(false);
    }
  }

  async function copyInvite() {
    setInviteBusy(true);
    setInviteErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/invite`, { method: "POST" });
      if (!res.ok) {
        setInviteErr(await groupErrorFrom(res));
        return;
      }
      const data = (await res.json()) as { url: string };
      let copied = false;
      try {
        await navigator.clipboard.writeText(data.url);
        copied = true;
      } catch {
        // Clipboard can be refused (no focus, no permission); the link is
        // shown below either way so it can be copied by hand.
      }
      setInvite({ url: data.url, copied });
    } catch {
      setInviteErr(groupErrorMessage(null));
    } finally {
      setInviteBusy(false);
    }
  }

  async function changeRole(target: GroupMember, role: MeetingRole) {
    if (role === target.role) return;
    setRowBusy(target.userId);
    setRowErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: target.userId, role }),
      });
      if (!res.ok) {
        setRowErr({ userId: target.userId, text: await groupErrorFrom(res) });
        return;
      }
      router.refresh();
    } catch {
      setRowErr({ userId: target.userId, text: groupErrorMessage(null) });
    } finally {
      setRowBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const res = await fetch(
        `/api/groups/${encodeURIComponent(group.id)}/members?userId=${encodeURIComponent(removing.userId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setDialogErr(await groupErrorFrom(res));
        return;
      }
      setRemoving(null);
      router.refresh();
    } catch {
      setDialogErr(groupErrorMessage(null));
    } finally {
      setDialogBusy(false);
    }
  }

  async function confirmLeave() {
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/members`, { method: "DELETE" });
      if (!res.ok) {
        setDialogErr(await groupErrorFrom(res));
        setDialogBusy(false);
        return;
      }
      router.push("/dashboard/groups");
      router.refresh();
    } catch {
      setDialogErr(groupErrorMessage(null));
      setDialogBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {capabilities.manageMembers ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 space-y-4">
          <form onSubmit={addByEmail} className="space-y-2">
            <label htmlFor="add-member-email" className="text-xs uppercase tracking-widest text-slate-400">
              Add member
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="add-member-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className={inputClass}
              />
              <button
                type="submit"
                disabled={adding}
                className="shrink-0 px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
            <p className="text-xs text-slate-400">They need a NeoConference account with this email.</p>
            {addMsg ? (
              <p className={"text-xs " + (addMsg.kind === "ok" ? "text-emerald-300" : "text-rose-300")}>{addMsg.text}</p>
            ) : null}
            <UpgradeHint error={addMsg?.kind === "err" ? addMsg.text : null} />
          </form>

          <div className="border-t border-slate-800 pt-4 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={copyInvite}
                disabled={inviteBusy}
                className="px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm disabled:opacity-60"
              >
                {inviteBusy ? "Creating link…" : "Copy invite link"}
              </button>
              <span className="text-xs text-slate-400">Anyone with the link joins as a Member, for 72 hours.</span>
            </div>
            {invite ? (
              <div className="space-y-1">
                <input
                  readOnly
                  value={invite.url}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Invite link"
                  className={inputClass + " font-mono text-xs"}
                />
                <p className="text-xs text-emerald-300">
                  {invite.copied ? "Copied to your clipboard." : "Select the link above and copy it."}
                </p>
              </div>
            ) : null}
            {inviteErr ? <p className="text-xs text-rose-300">{inviteErr}</p> : null}
          </div>
        </div>
      ) : null}

      <ul className="grid gap-2">
        {members.map((m) => {
          const isMe = m.userId === me.userId;
          const canChange = !isMe && capabilities.assignableRoles.includes(m.role);
          const canRemove = !isMe && capabilities.removableRoles.includes(m.role);
          return (
            <li key={m.userId} className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-100">
                    {m.name}
                    {isMe ? <span className="text-slate-400"> (you)</span> : null}
                  </div>
                  {m.email ? <div className="truncate text-xs text-slate-400">{m.email}</div> : null}
                </div>
                {canChange ? (
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    disabled={rowBusy === m.userId}
                    onChange={(e) => changeRole(m, e.target.value as MeetingRole)}
                    className="shrink-0 rounded-full bg-slate-900 text-slate-100 border border-slate-700 px-3 py-1.5 text-xs focus:border-cyan-400 focus:outline-none disabled:opacity-60"
                  >
                    {capabilities.assignableRoles.map((r) => (
                      <option key={r} value={r} className="bg-slate-900 text-slate-100">
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <RoleBadge role={m.role} />
                )}
                {canRemove ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDialogErr(null);
                      setRemoving(m);
                    }}
                    className="shrink-0 px-3 py-1.5 rounded-full border border-rose-500/40 text-rose-200 hover:bg-rose-500/15 transition text-xs"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {rowErr?.userId === m.userId ? <p className="mt-2 text-xs text-rose-300">{rowErr.text}</p> : null}
            </li>
          );
        })}
      </ul>

      {capabilities.leave ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setDialogErr(null);
              setLeaving(true);
            }}
            className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-rose-500/50 hover:text-rose-200 transition text-sm"
          >
            Leave group
          </button>
        </div>
      ) : me.role === "owner" ? (
        <p className="text-right text-xs text-slate-400">
          To leave, first make someone else the owner in Settings.
        </p>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name} from ${group.name}?`}
          body="They can be added again later. Their attendance in past meetings is kept."
          confirmLabel="Remove"
          danger
          busy={dialogBusy}
          error={dialogErr}
          onConfirm={confirmRemove}
          onCancel={() => setRemoving(null)}
        />
      ) : null}

      {leaving ? (
        <ConfirmDialog
          title={`Leave ${group.name}?`}
          body="You will need a new invite to come back."
          confirmLabel="Leave"
          danger
          busy={dialogBusy}
          error={dialogErr}
          onConfirm={confirmLeave}
          onCancel={() => setLeaving(false)}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                   */
/* -------------------------------------------------------------------------- */

function SettingsTab({
  group,
  members,
  me,
  capabilities,
}: {
  group: Group;
  members: GroupMember[];
  me: { userId: string; role: MeetingRole };
  capabilities: GroupCapabilities;
}) {
  const router = useRouter();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [iconUrl, setIconUrl] = useState(group.iconUrl);
  const [retry, setRetry] = useState(String(group.settings.retryIntervalMin));
  const [attempts, setAttempts] = useState(String(group.settings.maxAttempts));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newOwner, setNewOwner] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);

  // A refresh after saving brings new props; keep the form in step with them.
  useEffect(() => {
    setName(group.name);
    setDescription(group.description);
    setIconUrl(group.iconUrl);
    setRetry(String(group.settings.retryIntervalMin));
    setAttempts(String(group.settings.maxAttempts));
  }, [group]);

  const nameError = !name.trim() ? "Give the group a name." : null;
  const retryN = Number(retry);
  const attemptsN = Number(attempts);
  const retryError = !Number.isInteger(retryN) || retryN < 1 || retryN > 60 ? "1 to 60 minutes." : null;
  const attemptsError = !Number.isInteger(attemptsN) || attemptsN < 1 || attemptsN > 10 ? "1 to 10 attempts." : null;
  const others = members.filter((m) => m.userId !== me.userId);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (nameError || retryError || attemptsError) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          iconUrl: iconUrl.trim(),
          settings: { retryIntervalMin: retryN, maxAttempts: attemptsN },
        }),
      });
      if (!res.ok) {
        setMsg({ kind: "err", text: await groupErrorFrom(res) });
        return;
      }
      setMsg({ kind: "ok", text: "Saved." });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: groupErrorMessage(null) });
    } finally {
      setSaving(false);
    }
  }

  async function transfer() {
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: newOwner, role: "owner" }),
      });
      if (!res.ok) {
        setDialogErr(await groupErrorFrom(res));
        return;
      }
      setTransferOpen(false);
      router.refresh();
    } catch {
      setDialogErr(groupErrorMessage(null));
    } finally {
      setDialogBusy(false);
    }
  }

  async function remove() {
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: confirmName.trim() }),
      });
      if (!res.ok) {
        setDialogErr(await groupErrorFrom(res));
        setDialogBusy(false);
        return;
      }
      router.push("/dashboard/groups");
      router.refresh();
    } catch {
      setDialogErr(groupErrorMessage(null));
      setDialogBusy(false);
    }
  }

  const fieldError = (text: string | null, id: string) =>
    text ? (
      <p id={id} className="text-xs text-rose-300">
        {text}
      </p>
    ) : null;

  return (
    <div className="space-y-8">
      {capabilities.editSettings ? (
        <form onSubmit={save} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 space-y-4 text-sm">
          <div className="space-y-1.5">
            <label htmlFor="settings-name" className="text-xs text-slate-400">
              Name
            </label>
            <input
              id="settings-name"
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "settings-name-error" : undefined}
              className={inputClass}
            />
            {fieldError(nameError, "settings-name-error")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-description" className="text-xs text-slate-400">
              Description
            </label>
            <textarea
              id="settings-description"
              value={description}
              maxLength={500}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass + " resize-none"}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-icon" className="text-xs text-slate-400">
              Icon (https:// image link)
            </label>
            <div className="flex items-center gap-3">
              <GroupIcon name={name || group.name} iconUrl={iconUrl.startsWith("https://") ? iconUrl : ""} size={40} />
              <input
                id="settings-icon"
                type="url"
                inputMode="url"
                value={iconUrl}
                maxLength={2048}
                onChange={(e) => setIconUrl(e.target.value)}
                placeholder="https://"
                className={inputClass}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="settings-retry" className="text-xs text-slate-400">
                Ring again every (minutes)
              </label>
              <input
                id="settings-retry"
                type="number"
                min={1}
                max={60}
                step={1}
                value={retry}
                onChange={(e) => setRetry(e.target.value)}
                aria-invalid={retryError ? true : undefined}
                aria-describedby={retryError ? "settings-retry-error" : undefined}
                className={inputClass}
              />
              {fieldError(retryError, "settings-retry-error")}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="settings-attempts" className="text-xs text-slate-400">
                Ring at most (times)
              </label>
              <input
                id="settings-attempts"
                type="number"
                min={1}
                max={10}
                step={1}
                value={attempts}
                onChange={(e) => setAttempts(e.target.value)}
                aria-invalid={attemptsError ? true : undefined}
                aria-describedby={attemptsError ? "settings-attempts-error" : undefined}
                className={inputClass}
              />
              {fieldError(attemptsError, "settings-attempts-error")}
            </div>
          </div>
          <div className="flex items-center justify-end gap-3">
            {msg ? (
              <span className={"text-xs " + (msg.kind === "ok" ? "text-emerald-300" : "text-rose-300")}>{msg.text}</span>
            ) : null}
            <button
              type="submit"
              disabled={saving || Boolean(nameError || retryError || attemptsError)}
              className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : null}

      {capabilities.transferOwnership ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 space-y-3 text-sm">
          <h3 className="font-medium text-slate-100">Transfer ownership</h3>
          <p className="text-xs text-slate-400">The new owner gets full control. You become a Host.</p>
          {others.length === 0 ? (
            <p className="text-xs text-slate-400">Add someone to the group first.</p>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                aria-label="New owner"
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
                className={inputClass}
              >
                <option value="" className="bg-slate-900 text-slate-100">
                  Choose a member…
                </option>
                {others.map((m) => (
                  <option key={m.userId} value={m.userId} className="bg-slate-900 text-slate-100">
                    {m.name} ({ROLE_LABEL[m.role]})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!newOwner}
                onClick={() => {
                  setDialogErr(null);
                  setTransferOpen(true);
                }}
                className="shrink-0 px-4 py-2 rounded-full border border-amber-400/50 text-amber-100 hover:bg-amber-500/15 transition text-sm disabled:opacity-50"
              >
                Transfer
              </button>
            </div>
          )}
        </section>
      ) : null}

      {capabilities.deleteGroup ? (
        <section className="rounded-2xl border border-rose-900/50 bg-rose-950/20 p-4 space-y-3 text-sm">
          <h3 className="font-medium text-rose-100">Delete group</h3>
          <p className="text-xs text-rose-200/70">
            Removes the group, its members list and its history. Past meetings and their attendance are kept.
          </p>
          <button
            type="button"
            onClick={() => {
              setDialogErr(null);
              setConfirmName("");
              setDeleteOpen(true);
            }}
            className="px-4 py-2 rounded-full border border-rose-500/50 text-rose-200 hover:bg-rose-500/15 transition text-sm font-medium"
          >
            Delete group…
          </button>
        </section>
      ) : null}

      {transferOpen ? (
        <ConfirmDialog
          title={`Make ${others.find((m) => m.userId === newOwner)?.name ?? "this member"} the owner?`}
          body="You will become a Host and can no longer change these settings."
          confirmLabel="Transfer ownership"
          busy={dialogBusy}
          error={dialogErr}
          onConfirm={transfer}
          onCancel={() => setTransferOpen(false)}
        />
      ) : null}

      {deleteOpen ? (
        <ConfirmDialog
          title={`Delete ${group.name}?`}
          body="This cannot be undone."
          confirmLabel="Delete group"
          danger
          busy={dialogBusy}
          error={dialogErr}
          confirmDisabled={confirmName.trim() !== group.name}
          onConfirm={remove}
          onCancel={() => setDeleteOpen(false)}
        >
          <label htmlFor="delete-confirm" className="block text-xs text-slate-400">
            Type <span className="font-mono text-rose-200">{group.name}</span> to confirm:
          </label>
          <input
            id="delete-confirm"
            type="text"
            value={confirmName}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setConfirmName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-900 text-slate-100 border border-slate-700 focus:border-rose-400 focus:outline-none text-sm font-mono"
          />
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
