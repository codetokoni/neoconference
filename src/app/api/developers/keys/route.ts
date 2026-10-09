import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { kv } from '@/lib/kv';
import { currentPlan, type ApiKeyRecord, type ApiPlan } from '@/lib/apiAuth';
import { mintApiKey } from '@/lib/platform/apiKeys';
import { featureDecision, featureRefusal } from '@/lib/platform/features';

/** Live (unrevoked) keys one account may hold at once. */
const MAX_ACTIVE_KEYS = 10;

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
  const { userId } = await auth();
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
  const { userId } = await auth();
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

  // A bounded number of live keys per account; revoked ones do not count.
  const ids = (await kv.smembers(`apikeys:user:${userId}`)) as string[];
  if (ids.length > 0) {
    const metas = await Promise.all(ids.map((kid) => kv.get<KeyMeta>(`apikey:meta:${kid}`)));
    const active = metas.filter((m) => m && !m.revoked).length;
    if (active >= MAX_ACTIVE_KEYS) {
      return NextResponse.json(
        {
          error: 'too_many_keys',
          message: `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`,
        },
        { status: 409 }
      );
    }
  }

  // The plan as the website sees it. Shown with the key; requests use the
  // plan current at the time (apiAuth.authenticate), not this snapshot.
  // It used to come from a KV key nothing writes, so it was always 'free'.
  const plan: ApiPlan = await currentPlan(userId);

  // Feature controls (admin): no new keys while the API is off for this account.
  const api = await featureDecision('developer_api', { userId, plan });
  if (!api.enabled) return featureRefusal(api);

  const { meta: stored, raw } = await mintApiKey({ userId, name, plan });
  // The owner's own id is for the admin index, not this response.
  const { ownerUserId: _owner, ...meta } = stored;

  // The raw key is returned exactly once.
  return NextResponse.json({ data: { ...meta, key: raw } }, { status: 201 });
}

/**
 * DELETE /api/developers/keys?id=<keyId>
 * Revoke a key (marks revoked; does not hard-delete audit metadata).
 */
export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
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
