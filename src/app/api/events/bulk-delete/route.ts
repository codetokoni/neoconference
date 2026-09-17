// src/app/api/events/bulk-delete/route.ts
//
// Owner-or-admin bulk event delete. Same guarantees as
// /api/events/delete but takes an array of slugs and iterates.
// Typed-confirm gate is a fixed sentinel ("DELETE") instead of the
// per-event slug — for bulk operations, forcing the operator to type
// N unique slugs would be worse UX than a single explicit sentinel.
//
// POST body: { slugs: string[], confirm: "DELETE" }
//   200 { ok: true, deleted: string[], failed: { slug, reason }[] }
//   400 invalid_json | missing_slugs | confirm_mismatch | too_many
//   401 unauthenticated
//
// Ownership is enforced per slug — a caller can pass a mix of events
// they own and events they don't; the ones they don't own come back in
// `failed` with reason "forbidden" and the rest still delete. That
// matches how the operator's mental model works ("delete these test
// meetings, skip anything that isn't mine") better than an all-or-
// nothing atomic gate.
//
// Recording files in R2 are intentionally NOT deleted, same as the
// single-event endpoint.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { assertOwnerOrAdmin } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BULK = 200;
const CONFIRM_SENTINEL = 'DELETE';

interface BulkDeleteBody {
  slugs?: unknown;
  confirm?: unknown;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: BulkDeleteBody;
  try {
    body = (await req.json()) as BulkDeleteBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body.confirm !== 'string' || body.confirm.trim().toUpperCase() !== CONFIRM_SENTINEL) {
    return NextResponse.json({ error: 'confirm_mismatch' }, { status: 400 });
  }

  if (!Array.isArray(body.slugs) || body.slugs.length === 0) {
    return NextResponse.json({ error: 'missing_slugs' }, { status: 400 });
  }
  if (body.slugs.length > MAX_BULK) {
    return NextResponse.json({ error: 'too_many', max: MAX_BULK }, { status: 400 });
  }

  const slugs = Array.from(
    new Set(
      body.slugs
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .map((s) => s.trim().toLowerCase()),
    ),
  );

  const deleted: string[] = [];
  const failed: { slug: string; reason: string }[] = [];

  for (const slug of slugs) {
    const ev = await eventStore.bySlug(slug);
    if (!ev) {
      failed.push({ slug, reason: 'not_found' });
      continue;
    }
    const check = await assertOwnerOrAdmin(ev, userId);
    if (!check.ok) {
      failed.push({ slug, reason: 'forbidden' });
      continue;
    }
    try {
      const ok = await eventStore.delete(ev.id);
      if (ok) {
        deleted.push(slug);
      } else {
        failed.push({ slug, reason: 'delete_failed' });
      }
    } catch (e) {
      failed.push({
        slug,
        reason: e instanceof Error ? e.message : 'delete_failed',
      });
    }
  }

  return NextResponse.json({ ok: true, deleted, failed });
}
