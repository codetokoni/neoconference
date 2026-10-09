"use client";

// Automation rules: each rule's status, last and next run, its execution
// history, a dry-run preview, and (with automation:write) create, edit,
// pause, resume and Run now. Sensitive runs ask for a fresh code through
// adminFetch. The rule search, status filter and sort are kept in the
// address bar.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Time, adminZone, errorText, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, EmptyLine, FilterBar, Labeled, LoadState, Notice, PageHeader, Pager, Panel, btn, field, useClientTable, useUrlFilters } from "../ui";

type Schedule =
  | { type: "cron"; expr: string }
  | { type: "every"; unit: "minutes" | "hours" | "days"; n: number; at?: string; minute?: number; anchorDay?: string };
type Condition = { kind: string; days?: number[]; pct?: number };
type Action = {
  kind: string;
  channels?: { email: boolean; inApp: boolean; push?: boolean };
  message?: { title: string; body: string; severity: string; url: string };
  sendKind?: string;
  audience?: Record<string, unknown>;
  report?: { days: number; tables: string[]; to: string };
  jobs?: string[];
  target?: string;
};
type Options = { quietHours: { start: string; end: string } | null; maxPerRun: number; cooldownHours: number; failureThreshold: number };
type Counts = { targets: number; done: number; already: number; cooling: number; deferred: number; skipped: number; failed: number };
type Item = { key: string; label: string; outcome: string; detail?: string };
type Detail = { runId: string; slot: number | null; counts: Counts; errors: { target: string; message: string }[]; items: Item[]; note?: string };
type State = {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOutcome: string | null;
  lastSummary: string | null;
  lastError: string | null;
  failureStreak: number;
  failing: boolean;
};
type RuleRow = {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused";
  health: "active" | "paused" | "failing";
  schedule: Schedule;
  timezone: string;
  condition: Condition | null;
  action: Action;
  options: Options;
  replaces: string | null;
  builtIn: string | null;
  summary: string;
  scheduleText: string;
  state: State;
  nextRunAt: number | null;
  upcoming: number[];
  updatedAt: number;
  updatedBy: string;
};
type HistoryRun = {
  id: string;
  trigger: string;
  actor: string;
  startedAt: number;
  durationMs?: number;
  outcome: string;
  summary?: string;
  error?: string;
  detail: Detail | null;
};
type Meta = {
  actions: { kind: string; label: string; description: string }[];
  conditions: { kind: string; label: string; unit: string; action: string }[];
  reportTables: string[];
  jobs: { name: string; label: string }[];
  replaceable: { name: string; label: string; schedule: string | null }[];
  purgeTargets: { id: string; label: string }[];
  minuteSteps: number[];
  hourSteps: number[];
  stepUpRecipients: number;
  adminTimezone: string | null;
};
type Draft = {
  id: string | null;
  name: string;
  description: string;
  timezone: string;
  schedule: Schedule;
  condition: Condition | null;
  action: Action;
  options: Options;
  replaces: string | null;
  audienceKind: "everyone" | "plans" | "users";
  audiencePlans: string;
  audienceUsers: string;
  /** The reminder's days as typed ("7, 3, 1"), parsed when the rule is sent. */
  conditionDays: string;
};

const PLANS = ["free", "starter", "pro", "business", "enterprise"];

const healthTone = { active: "green", paused: "zinc", failing: "red" } as const;
const outcomeTone = (o: string | null | undefined) =>
  o === "ok" || o === "done" ? "green" : o === "failed" || o === "abandoned" ? "red" : o === "running" || o === "locked" ? "amber" : "zinc";

/** True when the browser knows this IANA zone name ("Africa/Lagos"). */
function validZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function toDraft(r: RuleRow | null, zone?: string | null): Draft {
  if (!r) {
    return {
      id: null,
      name: "",
      description: "",
      timezone: zone || adminZone(),
      schedule: { type: "every", unit: "days", n: 1, at: "09:00" },
      condition: { kind: "trial_ends_in", days: [3] },
      action: { kind: "reminder", channels: { email: true, inApp: true } },
      options: { quietHours: null, maxPerRun: 500, cooldownHours: 0, failureThreshold: 3 },
      replaces: null,
      audienceKind: "everyone",
      audiencePlans: "free",
      audienceUsers: "",
      conditionDays: "3",
    };
  }
  const a = (r.action.audience ?? {}) as { kind?: string; plans?: string[]; users?: string[] };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    timezone: r.timezone,
    schedule: r.schedule,
    condition: r.condition,
    action: r.action,
    options: r.options,
    replaces: r.replaces,
    audienceKind: a.kind === "users" ? "users" : a.kind === "filter" ? "plans" : "everyone",
    audiencePlans: (a.plans ?? ["free"]).join(", "),
    audienceUsers: (a.users ?? []).join("\n"),
    conditionDays: (r.condition?.days ?? []).join(", "),
  };
}

function fromDraft(d: Draft) {
  const condition = d.condition && d.condition.days !== undefined ? { ...d.condition, days: numList(d.conditionDays) } : d.condition;
  const action: Action = { ...d.action };
  if (action.kind === "announcement") {
    action.audience =
      d.audienceKind === "everyone"
        ? { kind: "everyone" }
        : d.audienceKind === "plans"
          ? { kind: "filter", plans: d.audiencePlans.split(/[\s,]+/).filter(Boolean) }
          : { kind: "users", users: d.audienceUsers.split(/[\s,]+/).filter(Boolean) };
  }
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name,
    description: d.description,
    timezone: d.timezone,
    schedule: d.schedule,
    condition: action.kind === "reminder" ? condition : null,
    action,
    options: d.options,
    replaces: d.replaces,
  };
}

const numList = (s: string) =>
  s
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);

type Ask = { rule: RuleRow; kind: "delete" | "run" | "pause" | "resume" };

const SORTS: Record<string, string> = { name: "Name", next: "Next run", last: "Last run", health: "Health" };

export default function AutomationClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("automation:write");
  const filters = useUrlFilters({ q: "", health: "", sort: "name" });
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ ruleId: string | null; detail: Detail | null; error?: string; stepUp?: { needed: boolean; reach: number | null; reason: string | null } } | null>(null);
  const [confirm, setConfirm] = useState<Ask | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ rules: RuleRow[]; meta: Meta }>("/api/admin/automation");
    if (r.ok) {
      setRules(r.data.rules);
      setMeta(r.data.meta);
      setLoadErr(null);
    } else setLoadErr(`Could not load the rules. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search).get("rule");
    if (q) setOpen(q);
  }, [load]);

  // Every write goes through here: a refusal shows the server's sentence,
  // a success its own; a run that finished but failed (200 with ok:false)
  // is shown as an error with the run's summary.
  const act = async (label: string, url: string, init: RequestInit & { json?: unknown }, done: (data: Record<string, unknown>) => string) => {
    setBusy(label);
    setMsg(null);
    const r = await adminFetch<Record<string, unknown>>(url, init);
    setBusy(null);
    if (!r.ok) {
      setMsg({ kind: "err", text: errorText(r) });
      return null;
    }
    setMsg({ kind: r.data.ok === false ? "err" : "ok", text: done(r.data) });
    await load();
    return r.data;
  };

  const setStatus = (rule: RuleRow, status: "active" | "paused") =>
    act(`status:${rule.id}`, `/api/admin/automation/${encodeURIComponent(rule.id)}/status`, { method: "POST", json: { status } }, () =>
      status === "active" ? `Resumed "${rule.name}".` : `Paused "${rule.name}".${rule.replaces ? ` ${rule.replaces} runs on its own cron again.` : ""}`,
    );

  const runNow = (rule: RuleRow) =>
    act(`run:${rule.id}`, `/api/admin/automation/${encodeURIComponent(rule.id)}/run`, { method: "POST" }, (d) => {
      const run = d.run as HistoryRun | undefined;
      setOpen(rule.id);
      return run ? `"${rule.name}" ran: ${run.summary ?? run.outcome}${d.error ? ` — ${String(d.error)}` : ""}` : String(d.message ?? "Ran.");
    });

  const remove = (rule: RuleRow) =>
    act(`del:${rule.id}`, `/api/admin/automation/${encodeURIComponent(rule.id)}`, { method: "DELETE" }, () => `Deleted "${rule.name}".`);

  const previewSaved = async (rule: RuleRow) => {
    setBusy(`preview:${rule.id}`);
    setMsg(null);
    const r = await adminFetch<{ preview: Detail; error?: string; stepUp: { needed: boolean; reach: number | null; reason: string | null } }>(
      `/api/admin/automation/${encodeURIComponent(rule.id)}/preview`,
      { method: "POST" },
    );
    setBusy(null);
    if (!r.ok && !r.data.preview) return setMsg({ kind: "err", text: `Could not preview. ${errorText(r)}` });
    setPreview({ ruleId: rule.id, detail: r.data.preview, error: r.data.error, stepUp: r.data.stepUp });
  };

  const previewDraft = async () => {
    if (!draft) return;
    setBusy("preview:draft");
    setMsg(null);
    const r = await adminFetch<{ preview: Detail; error?: string; stepUp: { needed: boolean; reach: number | null; reason: string | null } }>("/api/admin/automation/preview", {
      method: "POST",
      json: fromDraft(draft),
    });
    setBusy(null);
    if (!r.ok && !r.data.preview) return setMsg({ kind: "err", text: `Could not preview. ${errorText(r)}` });
    setPreview({ ruleId: null, detail: r.data.preview, error: r.data.error, stepUp: r.data.stepUp });
  };

  const save = async (activate: boolean) => {
    if (!draft) return;
    const body = { ...fromDraft(draft), ...(draft.id ? {} : { status: activate ? "active" : "paused" }) };
    const data = await act(
      "save",
      draft.id ? `/api/admin/automation/${encodeURIComponent(draft.id)}` : "/api/admin/automation",
      { method: draft.id ? "PATCH" : "POST", json: body },
      () => (draft.id ? `Saved "${draft.name}".` : `Created "${draft.name}"${activate ? "" : " (paused)"}.`),
    );
    if (data) {
      setDraft(null);
      setPreview(null);
    }
  };

  const needle = filters.value.q.trim().toLowerCase();
  const shown = rules
    ? rules.filter((r) => (!filters.value.health || r.health === filters.value.health) && (!needle || `${r.name} ${r.description} ${r.summary}`.toLowerCase().includes(needle)))
    : null;
  const sortKey = SORTS[filters.value.sort] ? filters.value.sort : "name";
  const table = useClientTable(
    shown,
    (r, k) => (k === "next" ? r.nextRunAt : k === "last" ? r.state.lastRunAt : k === "health" ? ({ failing: 0, active: 1, paused: 2 } as const)[r.health] : r.name),
    { key: sortKey, dir: sortKey === "last" ? "desc" : "asc" },
  );
  const { onSort } = table;
  useEffect(() => {
    // Keep the table's sort in step with the address bar.
    onSort(sortKey, sortKey === "last" ? "desc" : "asc");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey]);

  const purges = (r: RuleRow) => r.action.kind === "purge";

  return (
    <div>
      <PageHeader
        title="Automation"
        sub="Rules that run on a schedule: reminders, announcements, plan changes, reports and maintenance. Each runs once per period per person, under a lock, and alerts the owner and ops admins when it keeps failing."
        actions={
          write && !draft && meta ? (
            <button type="button" className={btn.primary} onClick={() => (setDraft(toDraft(null, meta.adminTimezone)), setPreview(null))}>
              New rule
            </button>
          ) : undefined
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <LoadState data={rules && meta ? { rules, meta } : null} error={loadErr} onRetry={load}>
        {({ rules: all, meta: m }) => (
          <>
            {draft && (
              <Editor
                draft={draft}
                meta={m}
                busy={busy}
                onChange={setDraft}
                onCancel={() => (setDraft(null), setPreview(null))}
                onPreview={previewDraft}
                onSave={save}
              />
            )}
            {preview && preview.ruleId === null && draft && <PreviewPanel preview={preview} onClose={() => setPreview(null)} />}

            {all.length === 0 ? (
              <Empty>No rules yet.</Empty>
            ) : (
              <>
                {all.length > 5 && (
                  <FilterBar active={filters.active} onClear={filters.reset}>
                    <Labeled label="Search" className="min-w-[12rem] flex-1">
                      <input type="search" className={field} value={filters.value.q} placeholder="Name or description" onChange={(e) => filters.set({ q: e.target.value })} />
                    </Labeled>
                    <Labeled label="Health">
                      <select className={`${field} w-auto`} value={filters.value.health} onChange={(e) => filters.set({ health: e.target.value })}>
                        <option value="">Any</option>
                        <option value="active">Active</option>
                        <option value="failing">Failing</option>
                        <option value="paused">Paused</option>
                      </select>
                    </Labeled>
                    <Labeled label="Sort by">
                      <select className={`${field} w-auto`} value={sortKey} onChange={(e) => filters.set({ sort: e.target.value })}>
                        {Object.entries(SORTS).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </Labeled>
                  </FilterBar>
                )}
                {table.total === 0 && <EmptyLine>No rules match these filters.</EmptyLine>}
                {write && draft && <p className="mb-2 text-xs text-zinc-400">Edit is off on the rules below until the rule being edited is saved or cancelled.</p>}
                <div className="space-y-3">
                  {table.visible.map((r) => (
                    <Panel key={r.id} className={`min-w-0 ${r.health === "failing" ? "border-red-500/40" : ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-semibold text-white">{r.name}</h2>
                            <Badge tone={healthTone[r.health]}>{r.health}</Badge>
                            {r.builtIn && <Badge>built-in</Badge>}
                            {r.replaces && <Badge tone="cyan">replaces cron {r.replaces}</Badge>}
                          </div>
                          <p className="mt-1 text-sm text-zinc-400">{r.summary}</p>
                          <p className="mt-1 text-xs text-zinc-400">
                            <span className="text-zinc-400">Schedule: </span>
                            {r.scheduleText}
                          </p>
                          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-zinc-400 sm:grid-cols-3">
                            <div>
                              <dt className="inline text-zinc-400">Last run: </dt>
                              <dd className="inline">
                                {r.state.lastRunAt ? (
                                  <>
                                    <Time ts={r.state.lastRunAt} /> <Badge tone={outcomeTone(r.state.lastOutcome)}>{r.state.lastOutcome}</Badge>
                                  </>
                                ) : (
                                  "never"
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt className="inline text-zinc-400">Next run: </dt>
                              <dd className="inline">{r.status === "paused" ? "paused" : <Time ts={r.nextRunAt} />}</dd>
                            </div>
                            <div>
                              <dt className="inline text-zinc-400">Failures in a row: </dt>
                              <dd className="inline">
                                {r.state.failureStreak} / {r.options.failureThreshold}
                              </dd>
                            </div>
                          </dl>
                          {r.upcoming.length > 1 && (
                            <p className="mt-1 text-xs text-zinc-400">
                              Then:{" "}
                              {r.upcoming.slice(1).map((t, i) => (
                                <Fragment key={t}>
                                  {i ? ", " : ""}
                                  <Time ts={t} />
                                </Fragment>
                              ))}
                            </p>
                          )}
                          {r.state.lastSummary && <p className="mt-1 text-xs text-zinc-300">Last result: {r.state.lastSummary}</p>}
                          {r.state.lastError && <p className="mt-1 break-words text-xs text-red-300">Last error: {r.state.lastError}</p>}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className={btn.ghost} disabled={!!busy} aria-label={`Preview: ${r.name}`} onClick={() => previewSaved(r)}>
                            {busy === `preview:${r.id}` ? "Previewing…" : "Preview"}
                          </button>
                          <button
                            type="button"
                            className={btn.ghost}
                            onClick={() => setOpen(open === r.id ? null : r.id)}
                            aria-expanded={open === r.id}
                            aria-label={`History: ${r.name}`}
                          >
                            History
                          </button>
                          {write && (
                            <>
                              <button
                                type="button"
                                className={purges(r) ? btn.danger : btn.warn}
                                disabled={!!busy}
                                aria-label={`Run now: ${r.name}`}
                                onClick={() => setConfirm({ rule: r, kind: "run" })}
                              >
                                {busy === `run:${r.id}` ? "Running…" : "Run now"}
                              </button>
                              {r.status === "active" ? (
                                <button type="button" className={btn.ghost} disabled={!!busy} aria-label={`Pause: ${r.name}`} onClick={() => setConfirm({ rule: r, kind: "pause" })}>
                                  {busy === `status:${r.id}` ? "Pausing…" : "Pause"}
                                </button>
                              ) : (
                                <button type="button" className={btn.ghost} disabled={!!busy} aria-label={`Resume: ${r.name}`} onClick={() => setConfirm({ rule: r, kind: "resume" })}>
                                  {busy === `status:${r.id}` ? "Resuming…" : "Resume"}
                                </button>
                              )}
                              <button
                                type="button"
                                className={btn.ghost}
                                disabled={!!draft}
                                aria-label={`Edit: ${r.name}`}
                                onClick={() => (setDraft(toDraft(r)), setPreview(null))}
                              >
                                Edit
                              </button>
                              {!r.builtIn && (
                                <button type="button" className={btn.danger} disabled={!!busy} aria-label={`Delete: ${r.name}`} onClick={() => setConfirm({ rule: r, kind: "delete" })}>
                                  {busy === `del:${r.id}` ? "Deleting…" : "Delete"}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {preview && preview.ruleId === r.id && <PreviewPanel preview={preview} onClose={() => setPreview(null)} />}
                      {open === r.id && <History key={r.state.lastRunAt ?? 0} ruleId={r.id} ruleName={r.name} />}
                    </Panel>
                  ))}
                </div>
                {table.total > 25 && <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} noun="rule" />}
              </>
            )}
          </>
        )}
      </LoadState>

      {confirm && (
        <Confirm
          title={
            confirm.kind === "delete"
              ? `Delete "${confirm.rule.name}"?`
              : confirm.kind === "run"
                ? `Run "${confirm.rule.name}" now?`
                : confirm.kind === "pause"
                  ? `Pause "${confirm.rule.name}"?`
                  : `Resume "${confirm.rule.name}"?`
          }
          body={
            confirm.kind === "delete"
              ? "The rule stops and is removed. Its run history stays on the Jobs page."
              : confirm.kind === "run"
                ? purges(confirm.rule)
                  ? "It deletes data now, as its schedule would, under the same lock. What it removes cannot be brought back. Use Preview first to see what it would remove."
                  : "It runs at once, as its schedule would, under the same lock. People it already reached this period are not reached again. Use Preview to see who it would reach."
                : confirm.kind === "pause"
                  ? `It stops running on its schedule until resumed.${confirm.rule.replaces ? ` It has taken over the ${confirm.rule.replaces} cron, so that cron runs on its own again.` : ""}`
                  : `It runs on its schedule again (${confirm.rule.scheduleText}).${confirm.rule.replaces ? ` It takes over the ${confirm.rule.replaces} cron, which stops its own runs.` : ""}${purges(confirm.rule) ? " It deletes data, so it asks for a fresh authenticator code." : ""}`
          }
          confirmLabel={confirm.kind === "delete" ? "Delete" : confirm.kind === "run" ? "Run now" : confirm.kind === "pause" ? "Pause" : "Resume"}
          danger={confirm.kind === "delete" || (confirm.kind === "run" && purges(confirm.rule))}
          typeToConfirm={confirm.kind === "delete" ? "delete" : confirm.kind === "run" && purges(confirm.rule) ? "purge" : undefined}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            if (c.kind === "delete") await remove(c.rule);
            else if (c.kind === "run") await runNow(c.rule);
            else await setStatus(c.rule, c.kind === "pause" ? "paused" : "active");
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

function PreviewPanel({
  preview,
  onClose,
}: {
  preview: { detail: Detail | null; error?: string; stepUp?: { needed: boolean; reach: number | null; reason: string | null } };
  onClose: () => void;
}) {
  const d = preview.detail;
  return (
    <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-3" role="region" aria-label="Dry-run preview">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-cyan-100">Preview — nothing was sent or changed</p>
        <button type="button" onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-100" aria-label="Close preview">
          ✕
        </button>
      </div>
      {preview.error && <p className="mt-1 text-sm text-red-300">{preview.error}</p>}
      {preview.stepUp?.needed && <p className="mt-1 text-xs text-amber-300">Needs a fresh authenticator code to run: {preview.stepUp.reason}</p>}
      {d && (
        <>
          <p className="mt-1 text-xs text-zinc-300">
            Found {d.counts.targets}: would act on {d.items.filter((i) => i.outcome === "would_do").length}, already done {d.counts.already}, in cooldown {d.counts.cooling}, left for later {d.counts.deferred}.
            {d.note ? ` ${d.note}` : ""}
          </p>
          {d.items.length > 0 && <Items items={d.items} />}
        </>
      )}
    </div>
  );
}

function Items({ items }: { items: Item[] }) {
  return (
    <div className="mt-2 max-h-64 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-zinc-400">
          <tr>
            <th className="py-1 pr-3 font-normal">Who / what</th>
            <th className="py-1 pr-3 font-normal">Outcome</th>
            <th className="py-1 font-normal">Detail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.key} className="border-t border-white/5 text-zinc-300">
              <td className="py-1 pr-3">{i.label}</td>
              <td className="py-1 pr-3">
                <Badge tone={i.outcome === "would_do" ? "cyan" : outcomeTone(i.outcome)}>{i.outcome.replace("_", " ")}</Badge>
              </td>
              <td className="py-1 text-zinc-400">{i.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The server sends a rule's latest 30 runs.
const HISTORY_SENT = 30;

function History({ ruleId, ruleName }: { ruleId: string; ruleName: string }) {
  const { adminFetch } = useAdmin();
  const [runs, setRuns] = useState<HistoryRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await adminFetch<{ history: HistoryRun[] }>(`/api/admin/automation/${encodeURIComponent(ruleId)}`);
    if (r.ok) {
      setRuns(r.data.history);
      setErr(null);
    } else setErr(`Could not load the history. ${errorText(r)}`);
  }, [adminFetch, ruleId]);
  useEffect(() => {
    load();
  }, [load]);
  const table = useClientTable(runs, (r) => r.startedAt, { key: "startedAt", dir: "desc", pageSize: 10 });
  return (
    <div className="mt-3" role="region" aria-label={`Execution history of ${ruleName}`}>
      <LoadState data={runs} error={err} onRetry={load}>
        {() =>
          table.total === 0 ? (
            <EmptyLine>No runs yet.</EmptyLine>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="text-zinc-400">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Started</th>
                      <th className="py-1 pr-3 font-normal">By</th>
                      <th className="py-1 pr-3 font-normal">Outcome</th>
                      <th className="py-1 pr-3 font-normal">Done</th>
                      <th className="py-1 pr-3 font-normal">Already</th>
                      <th className="py-1 pr-3 font-normal">Failed</th>
                      <th className="py-1 font-normal">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.visible.map((r) => (
                      <Fragment key={r.id}>
                        <tr className="border-t border-white/5 text-zinc-300">
                          <td className="whitespace-nowrap py-1 pr-3">
                            <Time ts={r.startedAt} />
                          </td>
                          <td className="py-1 pr-3">{r.trigger === "automation" ? "schedule" : `${r.trigger} · ${r.actor}`}</td>
                          <td className="py-1 pr-3">
                            <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
                          </td>
                          <td className="py-1 pr-3">{r.detail?.counts.done ?? "—"}</td>
                          <td className="py-1 pr-3">{r.detail?.counts.already ?? "—"}</td>
                          <td className="py-1 pr-3">{r.detail?.counts.failed ?? "—"}</td>
                          <td className="py-1">
                            <span className={r.error ? "break-words text-red-300" : "text-zinc-400"}>{r.error ?? r.summary ?? ""}</span>
                            {r.detail && r.detail.items.length > 0 && (
                              <button
                                type="button"
                                className="ml-2 text-cyan-300 hover:underline"
                                aria-expanded={show === r.id}
                                aria-label={`${show === r.id ? "Hide details" : "Details"} of the run started ${fmtTime(r.startedAt)}`}
                                onClick={() => setShow(show === r.id ? null : r.id)}
                              >
                                {show === r.id ? "hide" : "details"}
                              </button>
                            )}
                          </td>
                        </tr>
                        {show === r.id && r.detail && (
                          <tr>
                            <td colSpan={7}>
                              {r.detail.errors.length > 0 && (
                                <ul className="my-1 list-disc pl-5 text-red-300">
                                  {r.detail.errors.map((e, i) => (
                                    <li key={i}>
                                      {e.target}: {e.message}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <Items items={r.detail.items} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} sizes={[10, 25, 50]} noun="run" />
              {table.total >= HISTORY_SENT && <p className="mt-1 text-[11px] text-zinc-400">Only the latest {HISTORY_SENT} runs are listed here.</p>}
            </>
          )
        }
      </LoadState>
    </div>
  );
}

function Editor({
  draft,
  meta,
  busy,
  onChange,
  onCancel,
  onPreview,
  onSave,
}: {
  draft: Draft;
  meta: Meta;
  busy: string | null;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onPreview: () => void;
  onSave: (activate: boolean) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setAction = (patch: Partial<Action>) => set({ action: { ...draft.action, ...patch } });
  const setOptions = (patch: Partial<Options>) => set({ options: { ...draft.options, ...patch } });
  const s = draft.schedule;
  const condMeta = useMemo(() => meta.conditions.find((c) => c.kind === draft.condition?.kind), [meta.conditions, draft.condition?.kind]);
  const pctCondition = draft.condition?.kind === "meeting_cap" || draft.condition?.kind === "recording_hours";
  const L = "block text-sm text-zinc-300";
  const zoneOk = validZone(draft.timezone);
  const blocked = !draft.name.trim() ? "Give the rule a name." : !zoneOk ? "Fix the timezone first." : null;
  // Opening the editor (new rule or Edit) moves focus to it, so keyboard and
  // screen-reader users land where the form is rather than on the list.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [draft.id]);

  return (
    <Panel className="mb-4">
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold text-white outline-none">
        {draft.id ? `Edit rule: ${draft.name}` : "New rule"}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className={L}>
          Name
          <input className={`${field} mt-1`} value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className={L}>
          Timezone
          <input
            className={`${field} mt-1`}
            value={draft.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
            placeholder="Africa/Lagos"
            aria-invalid={!zoneOk}
            aria-describedby="automation-tz-help"
            list="automation-tz-list"
          />
          <datalist id="automation-tz-list">
            {[...new Set([adminZone(), meta.adminTimezone, "UTC"].filter((z): z is string => !!z))].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <span id="automation-tz-help" className={`mt-1 block text-xs ${zoneOk ? "text-zinc-400" : "text-amber-300"}`}>
            {zoneOk ? "An IANA zone name, e.g. Africa/Lagos or Europe/London." : `"${draft.timezone}" is not a timezone this browser knows. Use an IANA name such as Africa/Lagos.`}
          </span>
        </label>
        <label className={`${L} sm:col-span-2`}>
          Description
          <input className={`${field} mt-1`} value={draft.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-zinc-200">When</legend>
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <select
            aria-label="Schedule type"
            className={`${field} w-auto`}
            value={s.type === "cron" ? "cron" : s.unit}
            onChange={(e) => {
              const v = e.target.value;
              set({
                schedule:
                  v === "cron"
                    ? { type: "cron", expr: "0 9 * * *" }
                    : v === "minutes"
                      ? { type: "every", unit: "minutes", n: 15 }
                      : v === "hours"
                        ? { type: "every", unit: "hours", n: 1, minute: 0 }
                        : { type: "every", unit: "days", n: 1, at: "09:00" },
              });
            }}
          >
            <option value="minutes">Every N minutes</option>
            <option value="hours">Every N hours</option>
            <option value="days">Every N days</option>
            <option value="cron">Cron expression</option>
          </select>
          {s.type === "cron" ? (
            <input aria-label="Cron expression" className={`${field} w-56 max-w-full font-mono`} value={s.expr} onChange={(e) => set({ schedule: { type: "cron", expr: e.target.value } })} />
          ) : s.unit === "minutes" ? (
            <select aria-label="Minutes" className={`${field} w-auto`} value={s.n} onChange={(e) => set({ schedule: { ...s, n: Number(e.target.value) } })}>
              {meta.minuteSteps.map((n) => (
                <option key={n} value={n}>
                  every {n} min
                </option>
              ))}
            </select>
          ) : s.unit === "hours" ? (
            <>
              <select aria-label="Hours" className={`${field} w-auto`} value={s.n} onChange={(e) => set({ schedule: { ...s, n: Number(e.target.value) } })}>
                {meta.hourSteps.map((n) => (
                  <option key={n} value={n}>
                    every {n} h
                  </option>
                ))}
              </select>
              <label className="text-xs text-zinc-400">
                at minute past the hour
                <input type="number" min={0} max={59} className={`${field} ml-1 w-20`} value={s.minute ?? 0} onChange={(e) => set({ schedule: { ...s, minute: Number(e.target.value) } })} />
              </label>
            </>
          ) : (
            <>
              <input aria-label="Every how many days" type="number" min={1} max={90} className={`${field} w-20`} value={s.n} onChange={(e) => set({ schedule: { ...s, n: Number(e.target.value) } })} />
              <label className="text-xs text-zinc-400">
                at
                <input type="time" className={`${field} ml-1 w-28`} value={s.at ?? "09:00"} onChange={(e) => set({ schedule: { ...s, at: e.target.value } })} />
              </label>
            </>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-400">On the clock of the timezone above. A time skipped by a daylight-saving change runs just after it; a time that happens twice runs once.</p>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-zinc-200">What it does</legend>
        <select
          aria-label="Action"
          className={`${field} mt-1 w-auto max-w-full`}
          value={draft.action.kind}
          onChange={(e) => {
            const kind = e.target.value;
            const base: Action =
              kind === "reminder"
                ? { kind, channels: { email: true, inApp: true } }
                : kind === "announcement"
                  ? { kind, channels: { email: false, inApp: true, push: false }, message: { title: "", body: "", severity: "info", url: "" }, sendKind: "announcement" }
                  : kind === "report"
                    ? { kind, report: { days: 7, tables: ["summary"], to: "owner" } }
                    : kind === "maintenance"
                      ? { kind, jobs: meta.jobs.slice(0, 1).map((j) => j.name) }
                      : kind === "purge"
                        ? { kind, target: meta.purgeTargets[0]?.id }
                        : { kind };
            set({ action: base, condition: kind === "reminder" ? draft.condition ?? { kind: "trial_ends_in", days: [3] } : null });
          }}
        >
          {meta.actions.map((a) => (
            <option key={a.kind} value={a.kind} disabled={a.kind === "purge" && !meta.purgeTargets.length}>
              {a.label}
              {a.kind === "purge" && !meta.purgeTargets.length ? " (nothing to purge)" : ""}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-400">{meta.actions.find((a) => a.kind === draft.action.kind)?.description}</p>

        {draft.action.kind === "reminder" && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs text-zinc-400">
              When
              <select
                className={`${field} mt-1 w-auto max-w-full`}
                value={draft.condition?.kind}
                onChange={(e) => {
                  const k = e.target.value;
                  const days = k === "payment_failed" ? [1, 3] : [7, 3, 1];
                  // A new condition starts from its own default days, never the old ones.
                  set(
                    k === "meeting_cap" || k === "recording_hours"
                      ? { condition: { kind: k, pct: k === "meeting_cap" ? 80 : 90 } }
                      : { condition: { kind: k, days }, conditionDays: days.join(", ") },
                  );
                }}
              >
                {meta.conditions.map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-400">
              {condMeta?.unit ?? (pctCondition ? "Percent" : "Days")}
              {pctCondition ? (
                <input type="number" min={10} max={100} className={`${field} mt-1 w-24`} value={draft.condition?.pct ?? 80} onChange={(e) => set({ condition: { ...draft.condition!, pct: Number(e.target.value) } })} />
              ) : (
                <input className={`${field} mt-1 w-32`} value={draft.conditionDays} onChange={(e) => set({ conditionDays: e.target.value })} />
              )}
            </label>
            <Channels value={draft.action.channels!} onChange={(channels) => setAction({ channels })} />
          </div>
        )}

        {draft.action.kind === "announcement" && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input aria-label="Title" placeholder="Title" className={field} value={draft.action.message?.title ?? ""} onChange={(e) => setAction({ message: { ...draft.action.message!, title: e.target.value } })} />
            <input aria-label="Link (a path on this site)" placeholder="/pricing" className={field} value={draft.action.message?.url ?? ""} onChange={(e) => setAction({ message: { ...draft.action.message!, url: e.target.value } })} />
            <textarea aria-label="Message" placeholder="Message" rows={3} className={`${field} sm:col-span-2`} value={draft.action.message?.body ?? ""} onChange={(e) => setAction({ message: { ...draft.action.message!, body: e.target.value } })} />
            <label className="text-xs text-zinc-400">
              Audience
              <select className={`${field} mt-1`} value={draft.audienceKind} onChange={(e) => set({ audienceKind: e.target.value as Draft["audienceKind"] })}>
                <option value="everyone">Everyone</option>
                <option value="plans">Accounts on plans…</option>
                <option value="users">These accounts…</option>
              </select>
            </label>
            {draft.audienceKind === "plans" && (
              <label className="text-xs text-zinc-400">
                Plans ({PLANS.join(", ")})
                <input className={`${field} mt-1`} value={draft.audiencePlans} onChange={(e) => set({ audiencePlans: e.target.value })} />
              </label>
            )}
            {draft.audienceKind === "users" && (
              <label className="text-xs text-zinc-400">
                Emails or user ids
                <textarea rows={2} className={`${field} mt-1`} value={draft.audienceUsers} onChange={(e) => set({ audienceUsers: e.target.value })} />
              </label>
            )}
            <Channels value={draft.action.channels!} push onChange={(channels) => setAction({ channels })} />
          </div>
        )}

        {draft.action.kind === "report" && (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-400">
              Days covered
              <input type="number" min={1} max={92} className={`${field} mt-1 w-20`} value={draft.action.report?.days ?? 7} onChange={(e) => setAction({ report: { ...draft.action.report!, days: Number(e.target.value) } })} />
            </label>
            <fieldset className="text-xs text-zinc-400">
              <legend>Tables</legend>
              {meta.reportTables.map((t) => (
                <label key={t} className="mr-3 inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={draft.action.report?.tables.includes(t) ?? false}
                    onChange={(e) => {
                      const cur = draft.action.report!.tables;
                      setAction({ report: { ...draft.action.report!, tables: e.target.checked ? [...cur, t] : cur.filter((x) => x !== t) } });
                    }}
                  />
                  {t}
                </label>
              ))}
            </fieldset>
            <label className="text-xs text-zinc-400">
              To
              <select className={`${field} mt-1 w-auto`} value={draft.action.report?.to} onChange={(e) => setAction({ report: { ...draft.action.report!, to: e.target.value } })}>
                <option value="owner">The owner</option>
                <option value="owner_and_ops">The owner and ops admins</option>
              </select>
            </label>
          </div>
        )}

        {draft.action.kind === "maintenance" && (
          <fieldset className="mt-2 text-xs text-zinc-400">
            <legend>Jobs (only those safe to run again)</legend>
            {meta.jobs.map((j) => (
              <label key={j.name} className="mr-4 inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={draft.action.jobs?.includes(j.name) ?? false}
                  onChange={(e) => {
                    const cur = draft.action.jobs ?? [];
                    setAction({ jobs: e.target.checked ? [...cur, j.name] : cur.filter((x) => x !== j.name) });
                  }}
                />
                {j.label}
              </label>
            ))}
          </fieldset>
        )}

        {draft.action.kind === "purge" && (
          <select aria-label="Purge target" className={`${field} mt-2 w-auto max-w-full`} value={draft.action.target} onChange={(e) => setAction({ target: e.target.value })}>
            {meta.purgeTargets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-zinc-200">Limits</legend>
        <div className="mt-1 flex flex-wrap items-end gap-3 text-xs text-zinc-400">
          <label>
            Quiet hours from
            <input type="time" className={`${field} mt-1 w-28`} value={draft.options.quietHours?.start ?? ""} onChange={(e) => setOptions({ quietHours: e.target.value ? { start: e.target.value, end: draft.options.quietHours?.end ?? "07:00" } : null })} />
          </label>
          <label>
            Quiet hours to
            <input type="time" className={`${field} mt-1 w-28`} value={draft.options.quietHours?.end ?? ""} disabled={!draft.options.quietHours} onChange={(e) => setOptions({ quietHours: { start: draft.options.quietHours!.start, end: e.target.value } })} />
          </label>
          <label>
            At most per run
            <input type="number" min={1} max={5000} className={`${field} mt-1 w-24`} value={draft.options.maxPerRun} onChange={(e) => setOptions({ maxPerRun: Number(e.target.value) })} />
          </label>
          <label>
            Cooldown per person (hours)
            <input type="number" min={0} className={`${field} mt-1 w-24`} value={draft.options.cooldownHours} onChange={(e) => setOptions({ cooldownHours: Number(e.target.value) })} />
          </label>
          <label>
            Alert after failures in a row
            <input type="number" min={1} max={20} className={`${field} mt-1 w-20`} value={draft.options.failureThreshold} onChange={(e) => setOptions({ failureThreshold: Number(e.target.value) })} />
          </label>
          <label className="min-w-0">
            Takes over cron
            <select className={`${field} mt-1 w-auto max-w-full`} value={draft.replaces ?? ""} onChange={(e) => set({ replaces: e.target.value || null })}>
              <option value="">none</option>
              {meta.replaceable.map((j) => (
                <option key={j.name} value={j.name}>
                  {j.label} ({j.schedule} UTC)
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          Set a start time for quiet hours to choose when they end. Quiet hours hold a reminder, announcement or report until they end. A rule that takes over a cron stops that
          cron&apos;s own runs while the rule is active. Reaching more than {meta.stepUpRecipients} people asks for a fresh authenticator code.
        </p>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {blocked && <span className="text-xs text-amber-300">{blocked}</span>}
        <button type="button" className={btn.ghost} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={btn.ghost} disabled={!!busy || !zoneOk} onClick={onPreview}>
          {busy === "preview:draft" ? "Previewing…" : "Preview"}
        </button>
        {draft.id ? (
          <button type="button" className={btn.primary} disabled={!!busy || !!blocked} onClick={() => onSave(false)}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        ) : (
          <>
            <button type="button" className={btn.ghost} disabled={!!busy || !!blocked} onClick={() => onSave(false)}>
              {busy === "save" ? "Saving…" : "Create paused"}
            </button>
            <button type="button" className={btn.primary} disabled={!!busy || !!blocked} onClick={() => onSave(true)}>
              {busy === "save" ? "Saving…" : "Create and start"}
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}

function Channels({ value, push, onChange }: { value: { email: boolean; inApp: boolean; push?: boolean }; push?: boolean; onChange: (v: { email: boolean; inApp: boolean; push?: boolean }) => void }) {
  return (
    <fieldset className="text-xs text-zinc-400">
      <legend>Channels</legend>
      <label className="mr-3 inline-flex items-center gap-1">
        <input type="checkbox" checked={value.email} onChange={(e) => onChange({ ...value, email: e.target.checked })} /> Email
      </label>
      <label className="mr-3 inline-flex items-center gap-1">
        <input type="checkbox" checked={value.inApp} onChange={(e) => onChange({ ...value, inApp: e.target.checked })} /> Bell
      </label>
      {push && (
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={!!value.push} onChange={(e) => onChange({ ...value, push: e.target.checked })} /> Push
        </label>
      )}
    </fieldset>
  );
}
