"use client";

// Administrator roles: the built-in ones (read-only) and custom roles made
// from the permission catalog. A change reaches every holder at once.

import { useCallback, useEffect, useState } from "react";
import { ADMIN_PERMISSIONS, permissionGroups, type AdminPermission } from "@/lib/admin/catalog";
import { useAdmin } from "../AdminApi";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

type Role = { id: string; name: string; description: string; permissions: AdminPermission[]; builtIn: boolean; memberCount: number };
type Draft = { id: string | null; name: string; description: string; permissions: AdminPermission[] };

const label = new Map<string, string>(ADMIN_PERMISSIONS.map((p) => [p.key, p.label]));

export default function RolesClient() {
  const { me, can, adminFetch } = useAdmin();
  const manage = can("roles:manage");
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ roles: Role[] }>("/api/admin/roles");
    if (r.ok) setRoles(r.data.roles);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load roles." });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

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
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not save the role." });
    setMsg({ kind: "ok", text: draft.id ? `Saved "${draft.name}". Everyone with this role has the change now.` : `Created "${draft.name}".` });
    setDraft(null);
    load();
  };

  const remove = async (role: Role) => {
    setDeleting(null);
    const r = await adminFetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not delete the role." });
    setMsg({ kind: "ok", text: `Deleted "${role.name}".` });
    load();
  };

  if (!roles) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;

  return (
    <div>
      <PageHeader
        title="Roles"
        sub="What each kind of administrator may do. Built-in roles are fixed; make a custom role for anything else. Items marked sensitive also ask for a fresh authenticator code each time."
        actions={
          manage && !draft ? (
            <button type="button" className={btn.primary} onClick={() => setDraft({ id: null, name: "", description: "", permissions: [] })}>
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

      {draft && (
        <Panel className="mb-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <h2 className="text-base font-semibold text-white">{draft.id ? `Edit "${draft.name}"` : "New role"}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-zinc-300">
                Name
                <input required maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} mt-1`} />
              </label>
              <label className="text-sm text-zinc-300">
                Description
                <input maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${field} mt-1`} />
              </label>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {permissionGroups().map((g) => (
                <fieldset key={g.group}>
                  <legend className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">{g.group}</legend>
                  {g.items.map((p) => (
                    <label key={p.key} className={`mt-1.5 flex items-start gap-2 text-sm ${mine(p.key) ? "text-zinc-200" : "text-zinc-600"}`}>
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
            {!me.isOwner && <p className="mt-3 text-xs text-zinc-500">Greyed-out permissions are ones your own role does not have, so you cannot give them.</p>}
            <div className="mt-4 flex gap-2">
              <button type="submit" disabled={busy || !draft.name.trim() || !draft.permissions.length} className={btn.primary}>
                {busy ? "Saving…" : "Save role"}
              </button>
              <button type="button" className={btn.ghost} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {roles.map((r) => (
          <Panel key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  {r.name} {r.builtIn ? <Badge>built-in</Badge> : <Badge tone="cyan">custom</Badge>}
                </h2>
                {r.description && <p className="mt-0.5 text-xs text-zinc-400">{r.description}</p>}
                <p className="mt-1 text-xs text-zinc-500">
                  {r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"} · {r.memberCount} administrator{r.memberCount === 1 ? "" : "s"}
                </p>
              </div>
              {manage && !r.builtIn && (
                <div className="flex shrink-0 gap-1.5">
                  <button type="button" className={btn.ghost} onClick={() => setDraft({ id: r.id, name: r.name, description: r.description, permissions: r.permissions })}>
                    Edit
                  </button>
                  <button type="button" className={btn.danger} onClick={() => setDeleting(r)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
            <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="mt-2 text-xs text-cyan-300 underline decoration-dotted underline-offset-2">
              {open === r.id ? "Hide permissions" : "Show permissions"}
            </button>
            {open === r.id && (
              <ul className="mt-2 space-y-0.5 text-xs text-zinc-300">
                {r.permissions.map((p) => (
                  <li key={p}>• {label.get(p) ?? p}</li>
                ))}
              </ul>
            )}
          </Panel>
        ))}
      </div>

      {deleting && (
        <Confirm
          title={`Delete "${deleting.name}"?`}
          body={deleting.memberCount ? `${deleting.memberCount} administrator(s) still hold it; give them another role first.` : "Nobody holds this role. This cannot be undone."}
          confirmLabel="Delete role"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        />
      )}
    </div>
  );
}
