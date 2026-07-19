import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { kv } from '@vercel/kv';

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
  return { ctx, rate };
}
