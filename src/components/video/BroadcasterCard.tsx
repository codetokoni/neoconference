"use client";

import { useEffect, useState } from "react";

interface Endpoints {
  streamId: string;
  whipUrl: string;
  rtmpServer: string;
  rtmpKey: string;
  rtmpFull: string;
  srtUrl: string | null;
}

/**
 * Pro-broadcaster publish endpoints for a room's programme feed.
 *
 * Two rows: WHIP (paste-as-Server, no separate key) and RTMP
 * (Server + Stream Key split for OBS's "Custom" service). SRT
 * appears only when NEXT_PUBLIC_AMS_SRT is configured.
 *
 * Nothing is fetched — everything comes from AMS_HTTP + the room
 * slug and is derived on the client. Small copy pill next to each
 * field with tick feedback, same pattern the join / streaming /
 * moderator link cards use.
 */
export default function BroadcasterCard({ endpoints }: { endpoints: Endpoints }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
        Pro broadcaster — OBS / vMix
      </span>

      <div className="flex flex-col gap-2 rounded-md border border-white/12 bg-[#0B1319] p-3">
        <Row label="WHIP · Server URL" value={endpoints.whipUrl} hint="OBS 30+ · Service: WHIP" />
        <Row label="RTMP · Server" value={endpoints.rtmpServer} hint="OBS · Service: Custom" />
        <Row label="RTMP · Stream Key" value={endpoints.rtmpKey} hint="Same as streamId" mono />
        {endpoints.srtUrl && (
          <Row label="SRT · URL" value={endpoints.srtUrl} hint="Requires SRT ingest on the AMS host" />
        )}
      </div>

      <p className="text-xs text-white/60">
        Push a fully-mixed programme (graphics package, lower thirds, PIP,
        transitions) from OBS / vMix / a hardware encoder. Use{" "}
        <b>WHIP</b> for sub-second latency on OBS 30+ / vMix 27+; fall
        back to <b>RTMP</b> for older tools. The room slug is the
        credential — treat these URLs like a stream key.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => setCopied(true),
      () => {
        /* clipboard blocked — value is still visible for manual copy */
      },
    );
  };
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45">
        {label}
      </span>
      <button
        type="button"
        onClick={copy}
        title={hint}
        className={
          "inline-flex w-full items-center gap-2 rounded border border-white/10 bg-black/30 px-2 py-1 text-left hover:bg-white/[0.04] " +
          (mono ? "font-mono" : "")
        }
      >
        <span className="min-w-0 flex-1 truncate text-xs text-white">{value || "—"}</span>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/60">
          {copied ? "copied" : "copy"}
        </span>
      </button>
    </div>
  );
}
