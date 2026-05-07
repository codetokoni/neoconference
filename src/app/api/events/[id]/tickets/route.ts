// src/app/api/events/[id]/tickets/route.ts
//
// Owner-only ticket-tier CRUD. Only the host can edit pricing - buyers go
// through /api/events/[id]/checkout, which reads the active tiers off the
// event and creates a Stripe Checkout Session.
//
// PUT /api/events/<id>/tickets
//   body: { tickets: TicketTier[] }
//   Replaces the entire tickets array with a sanitized copy. Preserves any
//   sold counts that match by id (so editing a label can never zero a sale).

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import type { TicketTier } from '@/types/event';

export const runtime = 'nodejs';

const KNOWN_CURRENCIES = new Set(['usd', 'eur', 'gbp', 'cad', 'aud', 'ngn', 'inr', 'jpy', 'brl', 'mxn', 'zar', 'kes']);

function slugifyId(label: string, idx: number): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return base ? base + '-' + (idx + 1) : 'tier-' + (idx + 1);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (ev.ownerUserId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.tickets)) {
    return NextResponse.json({ error: 'invalid_body', message: 'tickets must be an array' }, { status: 400 });
  }

  const existingById = new Map<string, TicketTier>();
  for (const t of ev.tickets || []) existingById.set(t.id, t);

  const cleaned: TicketTier[] = [];
  for (let i = 0; i < body.tickets.length; i++) {
    const raw = body.tickets[i] as Partial<TicketTier> & { id?: string };
    const label = (raw.label || '').toString().slice(0, 80).trim();
    if (!label) continue;
    const priceCents = Math.max(0, Math.floor(Number(raw.priceCents) || 0));
    let currency = (raw.currency || 'usd').toString().toLowerCase().slice(0, 3);
    if (!KNOWN_CURRENCIES.has(currency)) currency = 'usd';
    const id = raw.id && /^[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : slugifyId(label, i);
    const capacity = typeof raw.capacity === 'number' && raw.capacity > 0 ? Math.floor(raw.capacity) : undefined;
    const description = raw.description ? raw.description.toString().slice(0, 240) : undefined;
    const active = raw.active !== false;
    const sold = existingById.get(id)?.sold || 0;
    cleaned.push({ id, label, priceCents, currency, capacity, sold, description, active });
  }

  await eventStore.update(ev.id, { tickets: cleaned });
  return NextResponse.json({ tickets: cleaned });
}
