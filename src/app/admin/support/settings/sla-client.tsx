"use client";

// src/app/admin/support/settings/sla-client.tsx — response-time targets per priority.

import Link from "next/link";
import { useEffect, useState } from "react";
import { PRIORITY_LABEL, TICKET_PRIORITIES, type SlaConfig } from "@/lib/support/model";
import { useAdmin } from "../../AdminApi";
import { Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";

export default function SlaClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("support:write");
  const [sla, setSla] = useState<SlaConfig | null>(null);
  const [defaults, setDefaults] = useState<SlaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<{ sla: SlaConfig; defaults: SlaConfig }>("/api/admin/support/sla").then((r) => {
      if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
      setSla(r.data.sla);
      setDefaults(r.data.defaults);
    });
  }, [adminFetch]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await adminFetch<{ sla: SlaConfig }>("/api/admin/support/sla", { method: "PUT", json: sla });
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    setSla(r.data.sla);
    setOk("Targets saved. Every open ticket is measured against them from now on.");
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
      {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
      {ok && <Notice kind="ok" onClose={() => setOk(null)}>{ok}</Notice>}
      {!sla ? (
        <Loading />
      ) : (
        <Panel className="max-w-xl">
          <form onSubmit={save}>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
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
                          value={sla[p][k]}
                          onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], [k]: Number(e.target.value) } })}
                          className={field}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {write && (
              <div className="mt-3 flex justify-between gap-2">
                <button type="button" className={btn.ghost} onClick={() => defaults && setSla(defaults)}>
                  Restore defaults
                </button>
                <button type="submit" className={btn.primary}>
                  Save targets
                </button>
              </div>
            )}
          </form>
        </Panel>
      )}
    </div>
  );
}
