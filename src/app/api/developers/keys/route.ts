import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { kv } from '@vercel/kv';
import { randomBytes, randomUUID } from 'crypto';
import { hashKey, type ApiKeyRecord, type ApiPlan } from '@/lib/apiAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public metadata about a key (never includes the raw secret or its hash).
interface KeyMeta {
  id: string;
  name: string;
  plan: ApiPlan;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  maskedKey: string;
}

/**
 * GET /api/developers/keys
 * List the signed-in user's API keys (metadata only).
 */
export async function GET() {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const ids = await kv.smembers(`apikeys:user:${userId}`);
  const metas = await Promise.all(
    ids.map((id) => kv.get<KeyMeta>(`apikey:meta:${id}`))
  );
  const keys = metas.filter((m): m is KeyMeta => Boolean(m) && !m!.revoked);
  return NextResponse.json({ data: keys });
}

/**
 * POST /api/developers/keys
 * Mint a new API key. Returns the raw key ONCE. Body: { name: string }
 */
export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { name?: string; plan?: ApiPlan } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const name = (body.name || 'Default key').slice(0, 60);

  // Resolve the user's plan from KV (set elsewhere by billing). Default to free.
  const plan = (await kv.get<ApiPlan>(`plan:user:${userId}`)) || 'free';

  const id = randomUUID();
  const raw = `nc_live_${randomBytes(24).toString('hex')}`;
  const hash = hashKey(raw);

  const record: ApiKeyRecord = {
    id,
    ownerUserId: userId,
    name,
    plan,
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
  };

  const meta: KeyMeta = {
    id,
    name,
    plan,
    createdAt: record.createdAt,
    lastUsedAt: null,
    revoked: false,
    maskedKey: `nc_live_...${raw.slice(-4)}`,
  };

  await kv.set(`apikey:${hash}`, record);
  await kv.set(`apikey:meta:${id}`, meta);
  await kv.set(`apikey:hash:${id}`, hash);
  await kv.sadd(`apikeys:user:${userId}`, id);

  // The raw key is returned exactly once.
  return NextResponse.json({ data: { ...meta, key: raw } }, { status: 201 });
}

/**
 * DELETE /api/developers/keys?id=<keyId>
 * Revoke a key (marks revoked; does not hard-delete audit metadata).
 */
export async function DELETE(req: NextRequest) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  }

  const meta = await kv.get<KeyMeta>(`apikey:meta:${id}`);
  const hash = await kv.get<string>(`apikey:hash:${id}`);
  const owns = await kv.sismember(`apikeys:user:${userId}`, id);
  if (!meta || !owns) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  meta.revoked = true;
  await kv.set(`apikey:meta:${id}`, meta);
  if (hash) {
    const record = await kv.get<ApiKeyRecord>(`apikey:${hash}`);
    if (record) {
      record.revoked = true;
      await kv.set(`apikey:${hash}`, record);
    }
  }

  return NextResponse.json({ data: { id, revoked: true } });
}
