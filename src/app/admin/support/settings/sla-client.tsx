"use client";

// src/app/admin/support/settings/sla-client.tsx — response-time targets per priority.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PRIORITY_LABEL, TICKET_PRIORITIES, type SlaConfig } from "@/lib/support/model";
import { errorText, useAdmin } from "../../AdminApi";
import { Confirm, LoadState, Notice, PageHeader, Panel, btn, field } from "../../ui";

type Msg = { kind: "ok" | "err" | "info"; text: string };

export default function SlaClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("support:write");
  const [sla, setSla] = useState<SlaConfig | null>(null);
  const [defaults, setDefaults] = useState<SlaConfig | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<{ sla: SlaConfig; defaults: SlaConfig }>("/api/admin/support/sla");
    if (!r.ok) return setLoadErr(errorText(r));
    setSla(r.data.sla);
    setDefaults(r.data.defaults);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setMsg(null);
    const r = await adminFetch<{ sla: SlaConfig }>("/api/admin/support/sla", { method: "PUT", json: sla });
    setAsking(false);
    if (!r.ok) return setMsg({ kind: "err", text: errorText(r) });
    setSla(r.data.sla);
    setMsg({ kind: "ok", text: "Targets saved. Every open ticket is measured against them from now on." });
  };

  return (
    <div>
      <Link href="/admin/support" className="text-sm text-cyan-300 hover:text-cyan-200">
        ← Tickets
      </Link>
      <PageHeader
        title="Response targets"
        sub="How quickly support should first reply, and resolve, by priority. Measured in hours from when the ticket was opened; the clock does not pause while waiting on the customer."
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {!write && <p className="mb-3 text-xs text-zinc-400">Changing the targets needs the support:write permission.</p>}
      <LoadState data={sla} error={loadErr} onRetry={load}>
        {(cur) => (
          <Panel className="max-w-xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setMsg(null);
                setAsking(true);
              }}
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[20rem] text-sm">
                  <thead className="text-left text-xs text-zinc-400">
                    <tr>
                      <th className="pb-2">Priority</th>
                      <th className="pb-2">First reply (hours)</th>
                      <th className="pb-2">Resolved (hours)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...TICKET_PRIORITIES].reverse().map((p) => (
                      <tr key={p}>
                        <td className="py-1.5 pr-3 text-zinc-200">{PRIORITY_LABEL[p]}</td>
                        {(["firstResponseHours", "resolutionHours"] as const).map((k) => (
                          <td key={k} className="py-1.5 pr-3">
                            <input
                              type="number"
                              min={0.25}
                              step={0.25}
                              disabled={!write}
                              aria-label={`${PRIORITY_LABEL[p]} ${k === "firstResponseHours" ? "first reply" : "resolution"} hours`}
                              value={cur[p][k]}
                              onChange={(e) => setSla({ ...cur, [p]: { ...cur[p], [k]: Number(e.target.value) } })}
                              className={field}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {write && (
                <div className="mt-3 flex flex-wrap justify-between gap-2">
                  <button
                    type="button"
                    className={btn.ghost}
                    disabled={!defaults}
                    onClick={() => {
                      if (!defaults) return;
                      setSla(defaults);
                      setMsg({ kind: "info", text: "The default targets are filled in. They are not saved yet: press Save targets to use them." });
                    }}
                  >
                    Restore defaults
                  </button>
                  <button type="submit" className={btn.primary} disabled={asking}>
                    Save targets
                  </button>
                </div>
              )}
            </form>
          </Panel>
        )}
      </LoadState>
      {asking && sla && (
        <Confirm
          title="Save the response targets?"
          body={
            <>
              Every open ticket is measured against them from now on, so tickets may become overdue (or stop being overdue) straight away:{" "}
              {[...TICKET_PRIORITIES]
                .reverse()
                .map((p) => `${PRIORITY_LABEL[p]} ${sla[p].firstResponseHours} h / ${sla[p].resolutionHours} h`)
                .join(", ")}
              .
            </>
          }
          confirmLabel="Save targets"
          onConfirm={save}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
