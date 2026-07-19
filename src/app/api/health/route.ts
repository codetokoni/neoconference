import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const START = Date.now();

/**
 * GET /api/health
 *
 * Public response is intentionally minimal — it only confirms liveness and
 * does NOT reveal which secrets/integrations are configured (previously an
 * information-disclosure risk). A detailed per-service report is returned
 * only when a caller presents HEALTH_CHECK_TOKEN via
 * `Authorization: Bearer <token>` or `?token=`.
 */

type CheckStatus = 'ok' | 'missing';

function has(name: string): CheckStatus {
  const v = process.env[name];
  return v && v.length > 0 ? 'ok' : 'missing';
}

export async function GET(req: NextRequest) {
  const base = {
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - START) / 1000),
  };

  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.nextUrl.searchParams.get('token') ||
    '';
  const expected = process.env.HEALTH_CHECK_TOKEN;

  if (!expected || provided !== expected) {
    return NextResponse.json(base);
  }

  const services = {
    clerk: {
      publishableKey: has('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'),
      secretKey: has('CLERK_SECRET_KEY'),
    },
    livekit: {
      url: has('NEXT_PUBLIC_LIVEKIT_URL'),
      apiKey: has('LIVEKIT_API_KEY'),
      apiSecret: has('LIVEKIT_API_SECRET'),
    },
    storage: {
      accessKey: has('S3_ACCESS_KEY'),
      secretKey: has('S3_SECRET_KEY'),
      endpoint: has('S3_ENDPOINT'),
      bucket: has('S3_BUCKET'),
      region: has('S3_REGION'),
    },
    kv: {
      restApiUrl: has('KV_REST_API_URL'),
      restApiToken: has('KV_REST_API_TOKEN'),
    },
  };

  return NextResponse.json({ ...base, services });
}
