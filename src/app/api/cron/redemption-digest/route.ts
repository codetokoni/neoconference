// src/app/api/cron/redemption-digest/route.ts
//
// Daily digest of invite redemptions, grouped by owner. Triggered by Vercel
// Cron (configured in vercel.json). Auth requires either a valid Vercel
// cron header (CRON_SECRET) or local invocation in dev.
//
// No-op when:
//   - RESEND_API_KEY is missing (mail not configured)
//   - eventStore is not KV-backed (cannot enumerate)
//   - no events have recentRedemptions in the lookback window

import { NextResponse, type NextRequest } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { isMailConfigured, sendMail } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

function isAuthed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If unset, only allow when Vercel marks the request as cron-driven.
    return req.headers.get("x-vercel-cron") === "1";
  }
  const auth = req.headers.get("authorization") || "";
  return auth === ("Bearer " + secret);
}

type Redemption = { token: string; redeemedAt: string; userId?: string; name?: string };

type EventRow = {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  recentRedemptions?: Redemption[];
};

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMailConfigured()) return NextResponse.json({ ok: true, skipped: "mail_not_configured" });

  let events: EventRow[] = [];
  try {
    const list = await (eventStore as unknown as { listAll?: () => Promise<EventRow[]> }).listAll?.();
    events = Array.isArray(list) ? list : [];
  } catch {
    return NextResponse.json({ ok: true, skipped: "enumerate_failed" });
  }

  const cutoff = Date.now() - LOOKBACK_MS;
  const byOwner = new Map<string, { events: EventRow[]; count: number }>();
  for (const ev of events) {
    const recent = (ev.recentRedemptions || []).filter((r) => {
      const t = Date.parse(r.redeemedAt || "");
      return Number.isFinite(t) && t >= cutoff;
    });
    if (recent.length === 0) continue;
    const slot = byOwner.get(ev.ownerId) || { events: [], count: 0 };
    slot.events.push({ ...ev, recentRedemptions: recent });
    slot.count += recent.length;
    byOwner.set(ev.ownerId, slot);
  }

  const sent: { ownerId: string; ok: boolean; reason?: string }[] = [];
  for (const [ownerId, slot] of byOwner) {
    const to = process.env["DIGEST_TO_" + ownerId];
    if (!to) {
      sent.push({ ownerId, ok: false, reason: "no_recipient" });
      continue;
    }
    const lines2 = slot.events.map((ev) => {
      const evName = ev.name || ev.slug;
      const items = (ev.recentRedemptions || []).map((r) => {
        const who = r.name || r.userId || r.token.slice(0, 8);
        return "  - " + who + " (" + r.redeemedAt + ")";
      });
      return evName + "\n" + items.join("\n");
    });
    const text = "NeoConference daily digest\n\n" + slot.count + " redemption" + (slot.count === 1 ? "" : "s") + " in the last 24h:\n\n" + lines2.join("\n\n");
    const r = await sendMail({
      to,
      subject: "NeoConference — " + slot.count + " new redemption" + (slot.count === 1 ? "" : "s") + " today",
      text,
    });
    sent.push({ ownerId, ok: r.ok, reason: r.ok ? undefined : r.error });
  }

  return NextResponse.json({ ok: true, owners: sent.length, sent });
}
