// src/app/api/stripe/webhook/route.ts
//
// POST /api/stripe/webhook
//
// Stripe -> NeoConference webhook handler.
// Verifies the Stripe-Signature header (HMAC-SHA256 over t.<rawBody>) using
// STRIPE_WEBHOOK_SECRET, then handles 'checkout.session.completed'.
//
// On successful checkout it:
//   - Loads the event by metadata.eventId
//   - Adds (or upgrades) a RoleAssignment with role='ticket-holder', preApproved=true
//   - Increments tickets[<tierId>].sold
//
// Configure in Stripe dashboard: send 'checkout.session.completed' to
//   https://neoconference.vercel.app/api/stripe/webhook
// and copy the resulting whsec_... into STRIPE_WEBHOOK_SECRET.

import { NextRequest, NextResponse } from 'next/server';
import { eventStore } from '@/lib/eventStore';
import { verifyWebhook } from '@/lib/stripe';
import type { NeoEvent, RoleAssignment } from '@/types/event';

export const runtime = 'nodejs';

type StripeEvent = {
  type: string;
  data: { object: StripeSession };
};

type StripeSession = {
  id: string;
  payment_status?: string;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null };
  amount_total?: number;
  currency?: string;
  metadata?: Record<string, string>;
};

function applyTicketSale(prev: NeoEvent, session: StripeSession): NeoEvent {
  const md = session.metadata || {};
  const tierId = md.tierId || '';
  const buyerUserId = md.buyerUserId || '';
  const email = session.customer_email || session.customer_details?.email || '';
  const name = session.customer_details?.name || '';

  const identifier = buyerUserId || email || ('stripe-' + session.id);

  // Upsert RoleAssignment - bump existing entry to ticket-holder if missing/lesser.
  const roles = [...(prev.roles || [])];
  const existingIdx = roles.findIndex((r) => r.identifier === identifier || (email && r.identifier === email));
  const roleEntry: RoleAssignment = {
    identifier,
    role: 'ticket-holder',
    label: name || email || undefined,
    preApproved: true,
  };
  if (existingIdx >= 0) {
    // Don't downgrade hosts/cohosts/speakers.
    const cur = roles[existingIdx];
    if (cur.role === 'viewer' || cur.role === 'ticket-holder') {
      roles[existingIdx] = { ...cur, ...roleEntry, identifier: cur.identifier };
    } else {
      // Higher role wins; just ensure preApproved stays true.
      roles[existingIdx] = { ...cur, preApproved: true };
    }
  } else {
    roles.push(roleEntry);
  }

  // Increment sold count for the matching tier.
  const tickets = (prev.tickets || []).map((t) =>
    t.id === tierId ? { ...t, sold: (t.sold || 0) + 1 } : t
  );

  return {
    ...prev,
    roles,
    tickets,
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  const evt = (await verifyWebhook(rawBody, sig)) as StripeEvent | null;
  if (!evt) {
    // Either signature failed or webhook secret not configured.
    return NextResponse.json({ error: 'invalid_signature_or_unconfigured' }, { status: 400 });
  }

  if (evt.type !== 'checkout.session.completed') {
    return NextResponse.json({ ok: true, ignored: evt.type });
  }

  const session = evt.data.object;
  if (session.payment_status && session.payment_status !== 'paid') {
    return NextResponse.json({ ok: true, skipped: session.payment_status });
  }

  const eventId = session.metadata?.eventId;
  if (!eventId) {
    return NextResponse.json({ error: 'missing_event_metadata' }, { status: 400 });
  }

  const ev = await eventStore.byId(eventId);
  if (!ev) {
    return NextResponse.json({ error: 'event_not_found' }, { status: 404 });
  }

  await eventStore.update(ev.id, (prev) => applyTicketSale(prev, session));
  return NextResponse.json({ ok: true, eventId: ev.id });
}
