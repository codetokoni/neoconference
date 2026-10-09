"use client";

// Administrator roles: the built-in ones (read-only) and custom roles made
// from the permission catalog. A change reaches every holder at once, so
// saving an edit is confirmed, and a role still held cannot be deleted.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ADMIN_PERMISSIONS, permissionGroups, type AdminPermission } from "@/lib/admin/catalog";
import { errorText, fmtNumber, useAdmin } from "../AdminApi";
import { Badge, Confirm, Dialog, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

type Role = { id: string; name: string; description: string; permissions: AdminPermission[]; builtIn: boolean; memberCount: number };
type Draft = { id: string | null; name: string; description: string; permissions: AdminPermission[] };

const label = new Map<string, string>(ADMIN_PERMISSIONS.map((p) => [p.key, p.label]));
const admins = (n: number) => `${fmtNumber(n)} administrator${n === 1 ? "" : "s"}`;

export default function RolesClient() {
  const { me, can, adminFetch } = useAdmin();
  const manage = can("roles:manage");
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<{ roles: Role[] }>("/api/admin/roles");
    if (r.ok) setRoles(r.data.roles);
    else setLoadError(errorText(r));
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  // Opening the form (New role, or Edit on a card far down the page) brings it into view with the name ready to type.
  const draftKey = draft ? draft.id ?? "new" : null;
  useEffect(() => {
    if (!draftKey) return;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    nameRef.current?.focus({ preventScroll: true });
  }, [draftKey]);

  const mine = (p: AdminPermission) => me.isOwner || me.permissions.includes(p);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions };
    const r = draft.id
      ? await adminFetch(`/api/admin/roles/${encodeURIComponent(draft.id)}`, { method: "PATCH", json: body })
      : await adminFetch("/api/admin/roles", { method: "POST", json: body });
    setBusy(false);
    setSaving(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not save the role." });
    setMsg({ kind: "ok", text: draft.id ? `Saved "${draft.name}". Everyone with this role has the change now.` : `Created "${draft.name}".` });
    setDraft(null);
    load();
  };

  const remove = async (role: Role) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
    setDeleting(null);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not delete the role." });
    setMsg({ kind: "ok", text: `Deleted "${role.name}".` });
    load();
  };

  if (!roles)
    return loadError ? (
      <Notice kind="err" onRetry={load}>
        {loadError}
      </Notice>
    ) : (
      <Loading />
    );

  // What an edit changes, for the confirmation: every holder gets it at once.
  const editing = draft?.id ? roles.find((r) => r.id === draft.id) ?? null : null;
  const added = editing && draft ? draft.permissions.filter((p) => !editing.permissions.includes(p)) : [];
  const dropped = editing && draft ? editing.permissions.filter((p) => !draft.permissions.includes(p)) : [];

  return (
    <div>
      <PageHeader
        title="Roles"
        sub="What each kind of administrator may do. Built-in roles are fixed; make a custom role for anything else. Items marked sensitive also ask for a fresh authenticator code each time."
        actions={
          manage && !draft ? (
            <button
              type="button"
              className={btn.primary}
              onClick={() => {
                setMsg(null);
                setDraft({ id: null, name: "", description: "", permissions: [] });
              }}
            >
              New role
            </button>
          ) : undefined
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadError && (
        <Notice kind="err" onRetry={load}>
          Could not refresh the roles: {loadError}
        </Notice>
      )}

      {draft && (
        <div ref={formRef} className="scroll-mt-4">
          <Panel className="mb-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // An edit reaches every holder at once: confirm it first. A new role has no holders yet.
                if (editing) setSaving(true);
                else save();
              }}
            >
              <h2 className="text-base font-semibold text-white">{draft.id ? `Edit "${editing?.name ?? draft.name}"` : "New role"}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm text-zinc-300">
                  Name
                  <input ref={nameRef} required maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} mt-1`} />
                </label>
                <label className="text-sm text-zinc-300">
                  Description
                  <input maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${field} mt-1`} />
                </label>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {permissionGroups().map((g) => (
                  <fieldset key={g.group} className="min-w-0">
                    <legend className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">{g.group}</legend>
                    {g.items.map((p) => (
                      <label key={p.key} className={`mt-1.5 flex items-start gap-2 text-sm ${mine(p.key) ? "text-zinc-200" : "text-zinc-400"}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-cyan-500"
                          disabled={!mine(p.key)}
                          checked={draft.permissions.includes(p.key)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              permissions: e.target.checked ? [...draft.permissions, p.key] : draft.permissions.filter((x) => x !== p.key),
                            })
                          }
                        />
                        <span>
                          {p.label}
                          {"sensitive" in p && p.sensitive && (
                            <span className="ml-1">
                              <Badge tone="amber">sensitive</Badge>
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
              {!me.isOwner && <p className="mt-3 text-xs text-zinc-400">Greyed-out permissions are ones your own role does not have, so you cannot give them.</p>}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="submit" disabled={busy || !draft.name.trim() || !draft.permissions.length} className={btn.primary}>
                  {busy ? "Saving…" : "Save role"}
                </button>
                <button type="button" className={btn.ghost} onClick={() => setDraft(null)} disabled={busy}>
                  Cancel
                </button>
                {!busy && (!draft.name.trim() || !draft.permissions.length) && (
                  <span className="text-xs text-zinc-400">{!draft.name.trim() ? "Give the role a name." : "Choose at least one permission."}</span>
                )}
              </div>
            </form>
          </Panel>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {roles.map((r) => (
          <Panel key={r.id} className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">
                  {r.name} {r.builtIn ? <Badge>built-in</Badge> : <Badge tone="cyan">custom</Badge>}
                </h2>
                {r.description && <p className="mt-0.5 text-xs text-zinc-400">{r.description}</p>}
                <p className="mt-1 text-xs text-zinc-400">
                  {r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"} ·{" "}
                  {r.memberCount > 0 ? (
                    <Link href={`/admin/team?role=${encodeURIComponent(r.id)}`} className="text-cyan-300 hover:underline">
                      {admins(r.memberCount)}
                    </Link>
                  ) : (
                    admins(0)
                  )}
                </p>
              </div>
              {manage && !r.builtIn && (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    className={btn.ghost}
                    aria-label={`Edit ${r.name}`}
                    onClick={() => {
                      setMsg(null);
                      setDraft({ id: r.id, name: r.name, description: r.description, permissions: r.permissions });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={btn.danger}
                    aria-label={`Delete ${r.name}`}
                    onClick={() => {
                      setMsg(null);
                      setDeleting(r);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(open === r.id ? null : r.id)}
              aria-expanded={open === r.id}
              aria-controls={`role-perms-${r.id}`}
              className="mt-2 text-xs text-cyan-300 underline decoration-dotted underline-offset-2"
            >
              {open === r.id ? "Hide permissions" : "Show permissions"}
              <span className="sr-only"> of {r.name}</span>
            </button>
            {open === r.id && (
              <ul id={`role-perms-${r.id}`} className="mt-2 space-y-0.5 text-xs text-zinc-300">
                {r.permissions.map((p) => (
                  <li key={p}>• {label.get(p) ?? p}</li>
                ))}
              </ul>
            )}
          </Panel>
        ))}
      </div>

      {saving && draft && editing && (
        <Confirm
          title={`Save the changes to "${editing.name}"?`}
          body={
            <>
              <p>
                {editing.memberCount > 0
                  ? `${admins(editing.memberCount)} hold this role and get the change at once.`
                  : "Nobody holds this role yet; whoever is given it gets these permissions."}
              </p>
              {(added.length > 0 || dropped.length > 0) && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {added.map((p) => (
                    <li key={p} className="text-emerald-300">
                      + {label.get(p) ?? p}
                    </li>
                  ))}
                  {dropped.map((p) => (
                    <li key={p} className="text-red-300">
                      − {label.get(p) ?? p}
                    </li>
                  ))}
                </ul>
              )}
            </>
          }
          confirmLabel="Save role"
          onCancel={() => setSaving(false)}
          onConfirm={() => save()}
        />
      )}

      {deleting &&
        (deleting.memberCount > 0 ? (
          // Still held: the server refuses, so the dialog refuses too, with the way forward.
          <Dialog title={`"${deleting.name}" cannot be deleted yet`} onClose={() => setDeleting(null)}>
            <p className="mt-1 text-sm text-zinc-400">
              {admins(deleting.memberCount)} still hold it. Give them another role first, then delete it.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Link href={`/admin/team?role=${encodeURIComponent(deleting.id)}`} className={btn.ghost}>
                See who holds it
              </Link>
              <button type="button" className={btn.primary} onClick={() => setDeleting(null)}>
                Close
              </button>
            </div>
          </Dialog>
        ) : (
          <Confirm
            title={`Delete "${deleting.name}"?`}
            body="Nobody holds this role. This cannot be undone."
            confirmLabel="Delete role"
            danger
            typeToConfirm="delete"
            onCancel={() => setDeleting(null)}
            onConfirm={() => remove(deleting)}
          />
        ))}
    </div>
  );
}
