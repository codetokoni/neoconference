"use client";

// "Turn on call alerts": asks for notification permission (only on a press),
// subscribes this browser and tells the server. Shows where things stand —
// on, blocked by the browser (and how to undo that), or not possible here.

import { useEffect, useState } from "react";
import { alertsState, isIos, turnAlertsOff, turnAlertsOn, type AlertsState } from "@/lib/pushClient";

function unblockSteps(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Tap the lock icon beside the address, then Permissions → Notifications → Allow.";
  if (/Firefox/i.test(ua)) return "Click the icon left of the address, then clear the Notifications block and reload.";
  if (/Edg\//.test(ua)) return "Click the lock icon beside the address, then set Notifications to Allow and reload.";
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari → Settings → Websites → Notifications, then allow this site.";
  return "Click the icon left of the address, then set Notifications to Allow and reload the page.";
}

export default function CallAlertsButton({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<AlertsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    alertsState()
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState("unsupported"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(fn: () => Promise<AlertsState>) {
    setBusy(true);
    setErr(null);
    try {
      const next = await fn();
      setState(next);
      if (next === "off") setErr("Call alerts could not be turned on. Please try again.");
    } catch {
      setErr("Call alerts could not be changed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;

  const box = "rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-sm";

  if (state === "ios-install") {
    return (
      <div className={box}>
        <p className="font-medium text-slate-100">Add NeoConference to your Home Screen to get call alerts</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
          <li>Tap the Share button {isIos() ? "(the square with an arrow)" : ""} in Safari.</li>
          <li>Choose <span className="text-slate-100">Add to Home Screen</span>, then <span className="text-slate-100">Add</span>.</li>
          <li>Open NeoConference from your Home Screen and turn call alerts on there.</li>
        </ol>
      </div>
    );
  }

  if (state === "unsupported" || state === "unavailable") {
    return compact ? null : (
      <div className={box}>
        <p className="text-slate-300">
          {state === "unsupported"
            ? "This browser can't receive call alerts. Try Chrome, Edge or Firefox, or the NeoConference app."
            : "Call alerts aren't available yet."}
        </p>
      </div>
    );
  }

  if (state === "blocked") {
    return (
      <div className={box}>
        <p className="font-medium text-amber-200">Call alerts are blocked by your browser</p>
        <p className="mt-1 text-slate-300">{unblockSteps()}</p>
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-1" : box + " space-y-2"}>
      {!compact ? (
        <p className="text-slate-300">
          {state === "on"
            ? "Call alerts are on in this browser. You'll be told when a group meeting starts or you're invited, even with the tab closed."
            : "Get told when a group meeting starts or you're invited — even with this tab closed."}
        </p>
      ) : null}
      {state === "on" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300">
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden /> Call alerts on
          </span>
          <button
            type="button"
            onClick={() => run(turnAlertsOff)}
            disabled={busy}
            className="px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-xs disabled:opacity-60"
          >
            {busy ? "…" : "Turn off"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => run(turnAlertsOn)}
          disabled={busy}
          className="px-4 py-2 rounded-full border border-cyan-400/50 text-cyan-100 hover:bg-cyan-500/15 transition text-sm disabled:opacity-60"
        >
          {busy ? "Turning on…" : "Turn on call alerts"}
        </button>
      )}
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
    </div>
  );
}
