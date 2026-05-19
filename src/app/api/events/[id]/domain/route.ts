// src/app/api/events/[id]/domain/route.ts
//
// Owner-only: bind / unbind a custom domain to an event. Validates the host
// is a sane FQDN, lowercases it, strips protocol/path, and persists onto the
// event. Middleware then resolves <host> to the matching event via slug lookup.
//
// POST /api/events/<id>/domain  body: { domain: string }
// DELETE /api/events/<id>/domain
//
// To activate, owner adds a CNAME on their DNS:
//   live.acme.com  CNAME  cname.vercel-dns.com
// and adds the domain inside Vercel project settings.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { assertOwnerOrAdmin } from '@/lib/roles';

export const runtime = 'nodejs';

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeDomain(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  let h = input.trim().toLowerCase();
  // Strip protocol
  h = h.replace(/^https?:\/\//, '');
  // Strip path
  h = h.split('/')[0];
  // Strip port
  h = h.split(':')[0];
  // Reject obvious garbage
  if (h.length < 4 || h.length > 253) return null;
  if (h.includes(' ')) return null;
  if (!HOST_RE.test(h)) return null;
  // Reject domains we own (avoid self-loops)
  if (h === 'neoconference.vercel.app') return null;
  if (h.endsWith('.vercel.app')) return null;
  return h;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const checkPost = await assertOwnerOrAdmin(ev, userId);
  if (!checkPost.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const domain = normalizeDomain(body?.domain || '');
  if (!domain) return NextResponse.json({ error: 'invalid_domain', message: 'Provide a valid hostname like live.acme.com (no path, no port).' }, { status: 400 });

  // Reject when another event already owns this domain (FCFS).
  const all = await eventStore.listAll();
  const conflict = all.find((e) => e.id !== ev.id && e.customDomain === domain);
  if (conflict) return NextResponse.json({ error: 'domain_taken', message: 'Another event is already bound to this domain.' }, { status: 409 });

  await eventStore.update(ev.id, { customDomain: domain });
  return NextResponse.json({
    domain,
    instructions: {
      cname: 'cname.vercel-dns.com',
      vercel: 'Add this domain in Vercel project settings then point your CNAME.',
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const checkDel = await assertOwnerOrAdmin(ev, userId);
  if (!checkDel.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  await eventStore.update(ev.id, { customDomain: undefined });
  return NextResponse.json({ ok: true });
}

