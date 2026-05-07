// src/app/api/events/[id]/checkout/route.ts
//
// POST /api/events/<id>/checkout
//   body: { tierId: string, email?: string }
//
// Creates a Stripe Checkout Session for the requested tier and returns its
// hosted URL. The client should redirect the buyer to that URL.
//
// On payment success, /api/stripe/webhook will:
//   1. Look up the event by metadata.eventId
//   2. Append a RoleAssignment with role='ticket-holder', preApproved=true
//   3. Increment tickets[].sold
//
// Auth: signed-in users get their userId persisted as buyerUserId; anonymous
// buyers can still purchase but only get email-based role grant.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { createCheckoutSession, isStripeConfigured } from '@/lib/stripe';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: 'stripe_unconfigured', message: 'STRIPE_SECRET_KEY is not set on the server.' },
      { status: 503 }
    );
  }

  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const tierId = (body?.tierId || '').toString().trim();
  if (!tierId) return NextResponse.json({ error: 'tierId_required' }, { status: 400 });

  const tier = (ev.tickets || []).find((t) => t.id === tierId && t.active);
  if (!tier) return NextResponse.json({ error: 'tier_not_found' }, { status: 404 });

  if (typeof tier.capacity === 'number' && (tier.sold || 0) >= tier.capacity) {
    return NextResponse.json({ error: 'sold_out' }, { status: 409 });
  }

  // Best-effort: get email from Clerk session, else from request body.
  const { userId } = await auth();
  let email: string | undefined = (body?.email || '').toString().trim() || undefined;
  if (userId && !email) {
    try {
      const u = await currentUser();
      email = u?.primaryEmailAddress?.emailAddress || u?.emailAddresses?.[0]?.emailAddress;
    } catch {
      // ignore - email is optional
    }
  }

  try {
    const session = await createCheckoutSession({
      eventId: ev.id,
      eventSlug: ev.slug,
      eventName: ev.name,
      tierId: tier.id,
      tierLabel: tier.label,
      priceCents: tier.priceCents,
      currency: tier.currency,
      customerEmail: email,
      buyerUserId: userId || undefined,
    });
    return NextResponse.json({ url: session.url, id: session.id });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: 'stripe_failed', message: e instanceof Error ? e.message : 'unknown' },
      { status: 502 }
    );
  }
}
