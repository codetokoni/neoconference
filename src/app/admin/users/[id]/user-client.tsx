"use client";

// One account: who they are, their plan and usage, groups, payments and
// sessions, what administrators did to the account, and the actions an
// administrator's role allows — each confirmed here, then checked and
// audited by the server. The platform owner's account shows no actions;
// the server refuses them anyway.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fmtTime, useAdmin, type ApiResult } from "../../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { statusBadges, type UserRow } from "../users-client";
import { SUPPORT_CHANGED } from "../../AdminShell";
import { ACTIVITY_TYPES } from "@/lib/activityTypes";
import type { ActivityEvent } from "@/lib/activity";

type Email = { id: string; address: string; verified: boolean; status: string | null; primary: boolean };
type Note = { id: string; ts: number; byEmail: string; text: string };
type SupportSession = {
  id: string;
  adminEmail: string;
  userId: string;
  userEmail: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
  endedAt?: number;
  endedBy?: string;
};
type AuditEntry = { seq: number; ts: number; actorEmail: string; action: string; before?: unknown; after?: unknown; note?: string; outcome: string };
type Detail = {
  user: UserRow & {
    username: string | null;
    emails: Email[];
    passwordEnabled: boolean;
    twoFactorEnabled: boolean;
    meetingsCreated: number;
  };
  protection: { isOwner: boolean; isSelf: boolean; refusal: { error: string; message: string } | null };
  admin: { roleName: string; status: string } | null;
  plan: {
    effective: string;
    stored: string | null;
    planExpiresAt: number | null;
    expired: boolean;
    lifetimeMeetingCap: number;
    recordingHoursPerMonth: number;
  };
  usage: {
    meetingsHosted: number | null;
    recentHosted: { id: string; slug: string; name: string; createdAt: string; status: string }[];
    attended: { eid: string; startMs: number }[] | null;
    recording: { thisMonth: { month: string; seconds: number | null }; lastMonth: { month: string; seconds: number | null } };
  };
  groups: { id: string; name: string; role: string; memberCount: number }[] | null;
  payments: { paymentRef: string; plan: string; billingCycle: string; amountEsp: number; status: string; paidAt: number; periodEnd: number; source: string }[] | null;
  sessions: {
    clerk: { id: string; lastActiveAt: number; createdAt: number; expireAt: number; device: string | null; ip: string | null; impersonated: boolean }[] | null;
    devices: { id: string; userAgent: string | null; ip: string | null; lastActivityAt: number; createdAt: number }[] | null;
  };
  audit: AuditEntry[] | null;
  activity: ActivityEvent[] | null;
  notes: Note[];
  deletion: { requestedAt: number; deleteAfter: number; requestedByEmail: string; reason: string; due: boolean } | null;
  suspension: { at: number; byEmail: string; reason: string } | null;
  retentionDays: number;
  support: { history: SupportSession[]; mine: SupportSession | null; elsewhere: SupportSession | null };
  mailConfigured: boolean;
};
type Workspace = {
  meetings: { id: string; slug: string; name: string; visibility: string; createdAt: string; scheduledAt: string | null; startedAt: string | null; endedAt: string | null; waitingRoomEnabled: boolean; isLocked: boolean; passwordProtected: boolean }[];
  attended: { eid: string; startMs: number; name: string | null; slug: string | null; hostedBy: string | null }[];
  groups: { id: string; name: string; role: string; members: { userId: string; name: string; role: string }[]; pending: { kind: string; value: string }[] }[];
};

type Ask = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  withReason?: string;
  run: (reason: string) => Promise<ApiResult>;
  done: string | ((r: ApiResult) => string);
  /** After success, instead of reloading this page. */
  after?: () => void;
};

const hours = (s: number | null | undefined) => (s == null ? "—" : `${(s / 3600).toFixed(1)} h`);

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <dt className="w-40 shrink-0 text-zinc-500">{k}</dt>
      <dd className="min-w-0 break-words text-zinc-200">{children}</dd>
    </div>
  );
}

export default function UserClient({ id }: { id: string }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [names, setNames] = useState<{ firstName: string; lastName: string } | null>(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [support, setSupport] = useState({ reason: "", minutes: 30 });
  const [ws, setWs] = useState<Workspace | null>(null);
  const base = `/api/admin/users/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    const r = await adminFetch<Detail>(base);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    setD(r.data);
    setTags(r.data.user.tags.join(" "));
  }, [adminFetch, base]);
  useEffect(() => {
    load();
  }, [load]);

  const loadWorkspace = useCallback(async () => {
    const r = await adminFetch<Workspace>(`${base}/support`);
    if (r.ok) setWs(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not open the workspace." });
  }, [adminFetch, base]);
  useEffect(() => {
    if (d?.support.mine) loadWorkspace();
    else setWs(null);
  }, [d?.support.mine, loadWorkspace]);

  const go = async (a: Ask, reason: string) => {
    setAsk(null);
    setMsg(null);
    const r = await a.run(reason);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? r.data.error ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: typeof a.done === "string" ? a.done : a.done(r) });
    // The support banner in the shell checks again (a session may have opened or ended).
    window.dispatchEvent(new Event(SUPPORT_CHANGED));
    if (a.after) return a.after();
    load();
  };
  const direct = async (run: () => Promise<ApiResult>, done: string) => go({ title: "", body: null, confirmLabel: "", run, done }, "");

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!d) return <Loading />;
  const u = d.user;
  const label = u.name || u.email || u.id;
  const blocked = d.protection.refusal;
  const mayWrite = can("users:write") && !blocked;
  const maySuspend = can("users:suspend") && !blocked;
  const mayDelete = can("users:delete") && !blocked;
  const maySupport = can("users:support_access") && !blocked;
  const ended = (r: ApiResult) => {
    const s = (r.data as { sessionsEnded?: { clerk: number; devices: number } }).sessionsEnded;
    return s ? ` ${s.clerk} sign-in session${s.clerk === 1 ? "" : "s"} and ${s.devices} device session${s.devices === 1 ? "" : "s"} ended.` : "";
  };

  return (
    <div className="space-y-4">
      <Link href="/admin/users" className="text-sm text-cyan-300 hover:underline">
        ← Users
      </Link>
      <PageHeader
        title={label}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <span>{u.email}</span>
            {statusBadges(u)}
            {d.admin && <Badge tone="cyan">{d.admin.roleName}</Badge>}
          </span>
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {blocked && (
        <Notice kind="err">
          {d.protection.isOwner ? "This is the platform owner's account. No administrator action reaches it." : blocked.message}
        </Notice>
      )}
      {d.deletion && (
        <Notice kind="err">
          Deletion requested by {d.deletion.requestedByEmail} on {fmtTime(d.deletion.requestedAt)} ({d.deletion.reason}). The account is suspended and{" "}
          {d.deletion.due ? "its retention period is over: it can be deleted now." : `can be deleted for good from ${fmtTime(d.deletion.deleteAfter)}.`}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Account"
          aside={
            mayWrite && !names ? (
              <button type="button" className={btn.ghost} onClick={() => setNames({ firstName: "", lastName: "" })}>
                Edit name
              </button>
            ) : null
          }
        >
          {names && (
            <form
              className="mb-3 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = names;
                setNames(null);
                direct(() => adminFetch(base, { method: "PATCH", json: n }), "Name saved.");
              }}
            >
              <input aria-label="First name" placeholder="First name" value={names.firstName} onChange={(e) => setNames({ ...names, firstName: e.target.value })} className={`${field} w-40`} />
              <input aria-label="Last name" placeholder="Last name" value={names.lastName} onChange={(e) => setNames({ ...names, lastName: e.target.value })} className={`${field} w-40`} />
              <button type="submit" className={btn.primary}>
                Save
              </button>
              <button type="button" className={btn.ghost} onClick={() => setNames(null)}>
                Cancel
              </button>
            </form>
          )}
          <dl>
            <Row k="User id">
              <code className="text-xs">{u.id}</code>
            </Row>
            <Row k="Name">{u.name || "—"}</Row>
            {u.username && <Row k="Username">{u.username}</Row>}
            <Row k="Signed up">{fmtTime(u.createdAt)}</Row>
            <Row k="Last sign-in">{u.lastSignInAt ? fmtTime(u.lastSignInAt) : "Never"}</Row>
            <Row k="Last active">{u.lastActiveAt ? fmtTime(u.lastActiveAt) : "—"}</Row>
            <Row k="Sign-in">
              {u.passwordEnabled ? "Password" : "No password (social, KingsChat or email code)"}
              {u.twoFactorEnabled ? " · two-factor on" : ""}
            </Row>
            <Row k="App role">{u.appRole}</Row>
            {d.suspension && (
              <Row k="Suspended">
                {fmtTime(d.suspension.at)} by {d.suspension.byEmail}: {d.suspension.reason}
              </Row>
            )}
          </dl>
        </Section>

        <Section title="Email addresses">
          <ul className="space-y-2">
            {u.emails.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-zinc-100">{e.address}</span>
                {e.primary && <Badge>primary</Badge>}
                <Badge tone={e.verified ? "green" : "amber"}>{e.verified ? "verified" : e.status ?? "unverified"}</Badge>
                {mayWrite && (
                  <button
                    type="button"
                    className={`${btn.ghost} px-2 py-1 text-xs`}
                    onClick={() =>
                      setAsk({
                        title: e.verified ? "Mark this address unverified?" : "Mark this address verified?",
                        body: e.verified
                          ? `${e.address} will stop counting as verified: it no longer proves anything (administrator lists, group invitations), and the user may have to verify it again to sign in with it.`
                          : `Only do this if you have confirmed ${e.address} belongs to this person some other way. Clerk will treat it as verified.`,
                        confirmLabel: e.verified ? "Mark unverified" : "Mark verified",
                        danger: e.verified,
                        run: () => adminFetch(`${base}/email`, { method: "POST", json: { emailId: e.id, verified: !e.verified } }),
                        done: e.verified ? `${e.address} is now unverified.` : `${e.address} is now verified.`,
                      })
                    }
                  >
                    {e.verified ? "Mark unverified" : "Mark verified"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Plan">
          <dl>
            <Row k="Plan in effect">
              <span className="capitalize">{d.plan.effective}</span>
              {d.protection.isOwner && " (owner — always the top tier)"}
            </Row>
            <Row k="Stored on account">
              {d.plan.stored ?? "none (Free)"}
              {d.plan.planExpiresAt && (
                <span className={d.plan.expired ? "text-red-300" : ""}>
                  {" "}
                  · {d.plan.expired ? "expired" : "until"} {fmtTime(d.plan.planExpiresAt)}
                </span>
              )}
            </Row>
            <Row k="Meetings created">
              {u.meetingsCreated}
              {d.plan.lifetimeMeetingCap ? ` of ${d.plan.lifetimeMeetingCap} on this plan` : " (no lifetime cap)"}
            </Row>
            <Row k="Recording">{d.plan.recordingHoursPerMonth ? `${d.plan.recordingHoursPerMonth} h a month` : "Not on this plan"}</Row>
          </dl>
        </Section>

        <Section title="Usage">
          <dl>
            <Row k="Meetings hosted">{d.usage.meetingsHosted ?? "Could not be read"}</Row>
            <Row k="Group meetings joined">{d.usage.attended ? `${d.usage.attended.length}${d.usage.attended.length === 10 ? "+" : ""} recently` : "—"}</Row>
            <Row k={`Recorded ${d.usage.recording.thisMonth.month}`}>{hours(d.usage.recording.thisMonth.seconds)}</Row>
            <Row k={`Recorded ${d.usage.recording.lastMonth.month}`}>{hours(d.usage.recording.lastMonth.seconds)}</Row>
          </dl>
          {d.usage.recentHosted.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {d.usage.recentHosted.map((m) => (
                <li key={m.id} className="flex flex-wrap gap-2">
                  <span className="text-zinc-200">{m.name}</span>
                  <span className="text-zinc-500">/{m.slug}</span>
                  <Badge tone={m.status === "live" ? "green" : "zinc"}>{m.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Groups">
          {!d.groups ? (
            <p className="text-sm text-zinc-500">Could not be read.</p>
          ) : d.groups.length === 0 ? (
            <p className="text-sm text-zinc-500">Not in any group.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.groups.map((gr) => (
                <li key={gr.id}>
                  <Link href={`/admin/groups/${encodeURIComponent(gr.id)}`} className="text-cyan-300 hover:underline">
                    {gr.name}
                  </Link>{" "}
                  <span className="text-zinc-500">
                    {gr.role === "participant" ? "member" : gr.role} · {gr.memberCount} members
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Payments">
          {d.payments == null ? (
            <p className="text-sm text-zinc-500">{can("billing:read") ? "Could not be read." : "Needs the billing:read permission."}</p>
          ) : d.payments.length === 0 ? (
            <p className="text-sm text-zinc-500">No payments.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.payments.map((p) => (
                <li key={p.paymentRef} className="flex flex-wrap gap-2">
                  <span className="text-zinc-200">{fmtTime(p.paidAt)}</span>
                  <span className="capitalize">
                    {p.plan} ({p.billingCycle})
                  </span>
                  <span>{p.amountEsp} ESP</span>
                  <Badge tone={p.status === "paid" ? "green" : "amber"}>{p.status}</Badge>
                  <span className="text-xs text-zinc-500">{p.source}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section
        title="Sessions"
        aside={
          maySuspend ? (
            <button
              type="button"
              className={btn.warn}
              onClick={() =>
                setAsk({
                  title: `Sign ${label} out everywhere?`,
                  body: "Every browser and device they are signed in on is signed out now. They can sign in again.",
                  confirmLabel: "Sign out everywhere",
                  run: () => adminFetch(`${base}/sessions`, { method: "DELETE" }),
                  done: (r) => `Signed out.${ended(r)}`,
                })
              }
            >
              Sign out everywhere
            </button>
          ) : null
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Sign-in sessions (Clerk)</h3>
            {!d.sessions.clerk ? (
              <p className="text-sm text-zinc-500">Could not be read.</p>
            ) : d.sessions.clerk.length === 0 ? (
              <p className="text-sm text-zinc-500">None active.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.sessions.clerk.map((s) => (
                  <li key={s.id}>
                    <span className="text-zinc-200">{s.device || "Unknown device"}</span>
                    <span className="text-zinc-500"> · last active {fmtTime(s.lastActiveAt)}</span>
                    {s.impersonated && <Badge tone="amber">impersonated</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Devices (stay-signed-in)</h3>
            {!d.sessions.devices ? (
              <p className="text-sm text-zinc-500">Could not be read.</p>
            ) : d.sessions.devices.length === 0 ? (
              <p className="text-sm text-zinc-500">None.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.sessions.devices.map((s) => (
                  <li key={s.id} className="truncate" title={s.userAgent ?? ""}>
                    <span className="text-zinc-200">{(s.userAgent ?? "Unknown").slice(0, 60)}</span>
                    <span className="text-zinc-500"> · {fmtTime(s.lastActivityAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      {(mayWrite || maySuspend || mayDelete) && (
        <Section title="Account actions">
          <div className="flex flex-wrap gap-2">
            {maySuspend &&
              !d.deletion &&
              (u.banned ? (
                <button
                  type="button"
                  className={btn.ghost}
                  onClick={() =>
                    setAsk({
                      title: `Reactivate ${label}?`,
                      body: "They can sign in again.",
                      confirmLabel: "Reactivate",
                      run: () => adminFetch(`${base}/suspend`, { method: "DELETE" }),
                      done: "Reactivated.",
                    })
                  }
                >
                  Reactivate
                </button>
              ) : (
                <button
                  type="button"
                  className={btn.warn}
                  onClick={() =>
                    setAsk({
                      title: `Suspend ${label}?`,
                      body: "They are signed out everywhere and cannot sign in until reactivated. Their meetings, groups and data stay as they are.",
                      confirmLabel: "Suspend",
                      danger: true,
                      withReason: "Reason (recorded in the audit log)",
                      run: (reason) => adminFetch(`${base}/suspend`, { method: "POST", json: { reason } }),
                      done: (r) => `Suspended.${ended(r)}`,
                    })
                  }
                >
                  Suspend
                </button>
              ))}
            {mayWrite && (["staff", "user"] as const).filter((r) => r !== u.appRole && u.appRole !== "admin").map((r) => (
              <button
                key={r}
                type="button"
                className={btn.ghost}
                onClick={() =>
                  setAsk({
                    title: `Make ${label} ${r === "staff" ? "staff" : "a regular user"}?`,
                    body: r === "staff" ? "Staff can run video rooms." : "They lose staff access to video rooms.",
                    confirmLabel: r === "staff" ? "Make staff" : "Make user",
                    run: () => adminFetch("/api/admin/role", { method: "POST", json: { userId: u.id, role: r } }),
                    done: `App role is now ${r}.`,
                  })
                }
              >
                Make {r}
              </button>
            ))}
            {mayDelete &&
              (d.deletion ? (
                <>
                  <button
                    type="button"
                    className={btn.ghost}
                    onClick={() =>
                      setAsk({
                        title: "Cancel the deletion?",
                        body: "The account is kept. If it was not suspended before the deletion was requested, it is reactivated.",
                        confirmLabel: "Cancel deletion",
                        run: () => adminFetch(`${base}/deletion`, { method: "DELETE" }),
                        done: "Deletion cancelled.",
                      })
                    }
                  >
                    Cancel deletion
                  </button>
                  <button
                    type="button"
                    className={btn.danger}
                    disabled={!d.deletion.due}
                    title={d.deletion.due ? undefined : `Available from ${fmtTime(d.deletion.deleteAfter)}`}
                    onClick={() =>
                      setAsk({
                        title: `Delete ${label} for good?`,
                        body: "The Clerk account is deleted, they are removed from their groups, and the notes and tags here are dropped. The audit log keeps the record. This cannot be undone.",
                        confirmLabel: "Delete now",
                        danger: true,
                        typeToConfirm: "delete",
                        run: () => adminFetch(`${base}/deletion/purge`, { method: "POST" }),
                        done: "Account deleted.",
                        after: () => window.location.assign("/admin/users?deleted=1"),
                      })
                    }
                  >
                    Delete now
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={btn.danger}
                  onClick={() =>
                    setAsk({
                      title: `Delete ${label}?`,
                      body: `The account is suspended and signed out now, and kept for ${d.retentionDays} days in case this is a mistake. After that an administrator can delete it for good.`,
                      confirmLabel: "Request deletion",
                      danger: true,
                      typeToConfirm: "delete",
                      withReason: "Reason (recorded in the audit log)",
                      run: (reason) => adminFetch(`${base}/deletion`, { method: "POST", json: { reason } }),
                      done: `Deletion requested. The account is suspended for ${d.retentionDays} days first.`,
                    })
                  }
                >
                  Delete account…
                </button>
              ))}
          </div>
          {mayWrite && (
            <div className="mt-4 border-t border-white/5 pt-3">
              <h3 className="text-sm font-medium text-zinc-200">Can&apos;t sign in?</h3>
              <p className="mt-1 text-sm text-zinc-400">
                Clerk&apos;s backend cannot send its own password-reset email: a reset is something the user starts, with &ldquo;Forgot password?&rdquo; on the sign-in page,
                which emails them a code. From here you can:
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btn.ghost}
                  disabled={!d.mailConfigured || !u.emailVerified}
                  title={!d.mailConfigured ? "Email is not set up on this deployment" : !u.emailVerified ? "The primary address is not verified" : undefined}
                  onClick={() =>
                    setAsk({
                      title: "Email sign-in instructions?",
                      body: `${u.email} gets a link to the sign-in page and how to reset their password. Nothing in it signs anyone in.`,
                      confirmLabel: "Send email",
                      run: () => adminFetch(`${base}/password`, { method: "POST", json: { action: "send_instructions" } }),
                      done: `Instructions emailed to ${u.email}.`,
                    })
                  }
                >
                  Email sign-in instructions
                </button>
                {u.passwordEnabled && maySuspend && (
                  <button
                    type="button"
                    className={btn.warn}
                    onClick={() =>
                      setAsk({
                        title: "Require a new password?",
                        body: "Clerk marks the current password as compromised: they are signed out everywhere now, and the next sign-in makes them set a new password.",
                        confirmLabel: "Require new password",
                        run: () => adminFetch(`${base}/password`, { method: "POST", json: { action: "require_reset" } }),
                        done: (r) => `They must set a new password at their next sign-in.${ended(r)}`,
                      })
                    }
                  >
                    Require a new password
                  </button>
                )}
                {u.passwordEnabled && (
                  <button type="button" className={btn.ghost} onClick={() => direct(() => adminFetch(`${base}/password`, { method: "POST", json: { action: "clear_reset" } }), "The password no longer has to be changed.")}>
                    Undo &ldquo;require a new password&rdquo;
                  </button>
                )}
              </div>
              {!u.passwordEnabled && <p className="mt-2 text-xs text-zinc-500">This account has no password: it signs in with a social account, KingsChat or an email code.</p>}
            </div>
          )}
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Internal notes and tags">
          {mayWrite && (
            <form
              className="mb-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const tagList = tags.split(/[\s,]+/).filter(Boolean);
                direct(() => adminFetch(`${base}/tags`, { method: "PUT", json: { tags: tagList } }), "Tags saved.");
              }}
            >
              <input aria-label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, separated by spaces" className={field} />
              <button type="submit" className={btn.ghost}>
                Save tags
              </button>
            </form>
          )}
          {!mayWrite && u.tags.length > 0 && (
            <p className="mb-2 flex flex-wrap gap-1">
              {u.tags.map((t) => (
                <Badge key={t}>#{t}</Badge>
              ))}
            </p>
          )}
          {mayWrite && (
            <form
              className="mb-3 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = note.trim();
                if (!text) return;
                setNote("");
                direct(() => adminFetch(`${base}/notes`, { method: "POST", json: { text } }), "Note added.");
              }}
            >
              <textarea aria-label="New note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Add a note only administrators can see" className={field} />
              <button type="submit" className={btn.ghost} disabled={!note.trim()}>
                Add note
              </button>
            </form>
          )}
          {d.notes.length === 0 ? (
            <p className="text-sm text-zinc-500">No notes.</p>
          ) : (
            <ul className="space-y-2">
              {d.notes.map((n) => (
                <li key={n.id} className="rounded-lg border border-white/5 bg-black/20 p-2 text-sm">
                  <p className="whitespace-pre-wrap text-zinc-200">{n.text}</p>
                  <p className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                    <span>
                      {n.byEmail} · {fmtTime(n.ts)}
                    </span>
                    {mayWrite && (
                      <button
                        type="button"
                        className="text-red-300 hover:underline"
                        onClick={() =>
                          setAsk({
                            title: "Remove this note?",
                            body: "The audit log keeps what it said.",
                            confirmLabel: "Remove",
                            danger: true,
                            run: () => adminFetch(`${base}/notes?noteId=${encodeURIComponent(n.id)}`, { method: "DELETE" }),
                            done: "Note removed.",
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Support access">
          <p className="mb-2 text-sm text-zinc-400">
            A support session opens this account&apos;s workspace — meetings, groups — read-only, for a set time. It is recorded on the account and in the audit
            log, and a banner stays on every admin page while it is open. It does not sign you in as the user.
          </p>
          {d.support.mine ? (
            <button
              type="button"
              className={btn.warn}
              onClick={() => direct(() => adminFetch(`${base}/support`, { method: "DELETE" }), "Support session ended.")}
            >
              End support session
            </button>
          ) : maySupport ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                direct(() => adminFetch(`${base}/support`, { method: "POST", json: support }), "Support session open.");
              }}
            >
              {d.support.elsewhere && (
                <p className="text-xs text-amber-300">This ends your open session on {d.support.elsewhere.userEmail}.</p>
              )}
              <input
                aria-label="Why you need access"
                value={support.reason}
                onChange={(e) => setSupport({ ...support, reason: e.target.value })}
                placeholder="Why (ticket number, what the user asked)"
                className={field}
                maxLength={300}
              />
              <div className="flex items-center gap-2">
                <select aria-label="How long" value={support.minutes} onChange={(e) => setSupport({ ...support, minutes: Number(e.target.value) })} className={`${field} w-auto`}>
                  {[15, 30, 60, 120].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </select>
                <button type="submit" className={btn.primary} disabled={!support.reason.trim()}>
                  Open support session
                </button>
              </div>
            </form>
          ) : null}
          {d.support.history.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-zinc-400">
              {d.support.history.map((s) => (
                <li key={s.id}>
                  {fmtTime(s.startedAt)} · {s.adminEmail} · {s.reason} ·{" "}
                  {s.endedAt ? `ended ${fmtTime(s.endedAt)}` : s.expiresAt > Date.now() ? `open until ${fmtTime(s.expiresAt)}` : "expired"}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {ws && (
        <Section title={`Workspace — ${label} (support session, read-only)`}>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Meetings they host ({ws.meetings.length})</h3>
              {ws.meetings.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {ws.meetings.map((m) => (
                    <li key={m.id}>
                      <span className="text-zinc-200">{m.name}</span> <span className="text-zinc-500">/{m.slug}</span>
                      <span className="block text-xs text-zinc-500">
                        {m.visibility}
                        {m.passwordProtected ? " · password" : ""}
                        {m.waitingRoomEnabled ? " · waiting room" : ""}
                        {m.isLocked ? " · locked" : ""} · {m.endedAt ? "ended" : m.startedAt ? "live" : m.scheduledAt ? `scheduled ${m.scheduledAt.slice(0, 16).replace("T", " ")}` : "not started"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Group meetings joined</h3>
              {ws.attended.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {ws.attended.map((m) => (
                    <li key={m.eid}>
                      <span className="text-zinc-200">{m.name ?? m.eid}</span>
                      <span className="block text-xs text-zinc-500">
                        {fmtTime(m.startMs)}
                        {m.hostedBy ? ` · ${m.hostedBy}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Groups</h3>
              {ws.groups.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {ws.groups.map((gr) => (
                    <li key={gr.id}>
                      <span className="text-zinc-200">{gr.name}</span> <span className="text-xs text-zinc-500">({gr.role})</span>
                      <span className="block text-xs text-zinc-500">
                        {gr.members.map((m) => m.name).join(", ")}
                        {gr.pending.length ? ` · ${gr.pending.length} invited` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      )}

      {d.activity && (
        <Section title="Activity">
          {d.activity.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing recorded yet. The activity log keeps 90 days.</p>
          ) : (
            <ul className="divide-y divide-white/5 text-sm">
              {d.activity.map((e) => (
                <li key={e.id} className="py-1.5">
                  <span className="text-zinc-200">{ACTIVITY_TYPES[e.type]?.label ?? e.type}</span>{" "}
                  <span className="text-zinc-400">· {fmtTime(e.ts)}</span>
                  {e.severity !== "info" && (
                    <>
                      {" "}
                      <Badge tone={e.severity === "error" ? "red" : "amber"}>{e.severity}</Badge>
                    </>
                  )}
                  {e.props && (
                    <span className="block truncate text-xs text-zinc-500">
                      {Object.entries(e.props)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Link href={`/admin/logs?source=activity&user=${encodeURIComponent(u.id)}&from=${new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10)}`} className="mt-2 inline-block text-xs text-cyan-300 hover:underline">
            Search all of it in Logs →
          </Link>
        </Section>
      )}

      {d.audit && (
        <Section title="Administrator actions on this account">
          {d.audit.length === 0 ? (
            <p className="text-sm text-zinc-500">None recorded.</p>
          ) : (
            <ul className="divide-y divide-white/5 text-sm">
              {d.audit.map((e) => (
                <li key={e.seq} className="py-1.5">
                  <span className="font-mono text-xs text-cyan-300">{e.action}</span>{" "}
                  <span className="text-zinc-400">
                    by {e.actorEmail} · {fmtTime(e.ts)}
                  </span>
                  {e.outcome !== "ok" && (
                    <>
                      {" "}
                      <Badge tone="red">{e.outcome}</Badge>
                    </>
                  )}
                  {e.note && <span className="block text-xs text-zinc-500">{e.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {ask && <Confirm {...ask} onConfirm={(reason) => go(ask, reason)} onCancel={() => setAsk(null)} />}
    </div>
  );
}
