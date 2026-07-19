import { NextResponse } from 'next/server';
import { ApiError } from './apiAuth';

export interface RateInfo {
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Standard success envelope for all /api/v1 responses.
 */
export function apiSuccess(data: unknown, rate?: RateInfo, status = 200): NextResponse {
  const res = NextResponse.json({ data }, { status });
  applyRateHeaders(res, rate);
  return res;
}

/**
 * Standard error envelope. Accepts an ApiError or any thrown value.
 */
export function apiFailure(err: unknown, rate?: RateInfo): NextResponse {
  if (err instanceof ApiError) {
    const res = NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status }
    );
    applyRateHeaders(res, rate);
    return res;
  }

  // Unexpected error: do not leak internals.
  console.error('[api/v1] unhandled error', err);
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'An unexpected error occurred.' } },
    { status: 500 }
  );
}

function applyRateHeaders(res: NextResponse, rate?: RateInfo): void {
  if (!rate) return;
  res.headers.set('X-RateLimit-Limit', String(rate.limit));
  res.headers.set('X-RateLimit-Remaining', String(rate.remaining));
  res.headers.set('X-RateLimit-Reset', String(rate.reset));
}

/**
 * Parse and validate a JSON body, throwing a 400 ApiError when malformed.
 */
export async function parseJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, 'invalid_body', 'Request body must be valid JSON.');
  }
}
