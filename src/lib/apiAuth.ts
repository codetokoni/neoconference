import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { activity } from '@/lib/activity';
import { kv } from '@/lib/kv';
import { getPlanForUserId } from '@/lib/plan';

export type ApiPlan = 'free' | 'starter' | 'pro' | 'business' | 'enterprise';

export interface ApiKeyRecord {
  id: string;
  ownerUserId: string;
  name: string;
  plan: ApiPlan;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface AuthContext {
  key: ApiKeyRecord;
  hash: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RATE_LIMITS: Record<ApiPlan, number> = {
  free: 60,
  starter: 120,
  pro: 300,
  business: 600,
  enterprise: 2000,
};

const PLAN_CACHE_SECONDS = 60;

/**
 * The account's plan, from the same source the website uses
 * (getPlanForUserId: Clerk publicMetadata, admins as business), cached for
 * a minute so a busy API client does not ask Clerk on every request.
 */
export async function currentPlan(userId: string): Promise<ApiPlan> {
  const cacheKey = `apiplan:${userId}`;
  try {
    const cached = await kv.get<ApiPlan>(cacheKey);
    if (cached) return cached;
  } catch {
    /* fall through to the source */
  }
  const plan = await getPlanForUserId(userId);
  try {
    await kv.set(cacheKey, plan, { ex: PLAN_CACHE_SECONDS });
  } catch {
    /* uncached is still correct */
  }
  return plan;
}

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function authenticate(req: NextRequest): Promise<AuthContext> {
  const raw = extractBearer(req);
  if (!raw) {
    throw new ApiError(401, 'missing_api_key', 'Provide an API key via the Authorization: Bearer header.');
  }
  if (!raw.startsWith('nc_live_') && !raw.startsWith('nc_test_')) {
    throw new ApiError(401, 'invalid_api_key', 'Malformed API key.');
  }

  const hash = hashKey(raw);
  const record = await kv.get<ApiKeyRecord>(`apikey:${hash}`);
  if (!record) {
    throw new ApiError(401, 'invalid_api_key', 'API key not recognized.');
  }
  if (record.revoked) {
    throw new ApiError(401, 'revoked_api_key', 'This API key has been revoked.');
  }
  // The owner's plan as it is now, not as it was when the key was made.
  // The stored plan came from a KV key nothing writes, so every key was
  // 'free' — a paying customer's key capped at free limits — and it never
  // followed an upgrade or a downgrade.
  record.plan = await currentPlan(record.ownerUserId);

  try {
    record.lastUsedAt = Date.now();
    await kv.set(`apikey:${hash}`, record);
  } catch {
    /* ignore */
  }

  return { key: record, hash };
}

export async function enforceRateLimit(ctx: AuthContext): Promise<{ limit: number; remaining: number; reset: number }> {
  const limit = RATE_LIMITS[ctx.key.plan] ?? RATE_LIMITS.free;
  const windowSeconds = 60;
  const now = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(now / windowSeconds);
  const bucket = `ratelimit:${ctx.hash}:${windowId}`;

  const count = await kv.incr(bucket);
  if (count === 1) {
    await kv.expire(bucket, windowSeconds);
  }

  const reset = (windowId + 1) * windowSeconds;
  const remaining = Math.max(0, limit - count);

  if (count > limit) {
    throw new ApiError(429, 'rate_limited', `Rate limit of ${limit} requests/min exceeded.`);
  }

  return { limit, remaining, reset };
}

export async function requireApiKey(req: NextRequest): Promise<{
  ctx: AuthContext;
  rate: { limit: number; remaining: number; reset: number };
}> {
  const ctx = await authenticate(req);
  const rate = await enforceRateLimit(ctx);
  // Counted against the key's owner (no log line each: see activity.ts).
  await activity.record('api.call', { account: ctx.key.ownerUserId });
  return { ctx, rate };
}
