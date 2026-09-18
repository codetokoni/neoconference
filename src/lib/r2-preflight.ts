// src/lib/r2-preflight.ts
//
// Tiny helper for the recording preflight endpoint — HEADs the R2/S3
// bucket root and reports whether the endpoint is reachable and the
// bucket exists. Does NOT touch objects; a real egress start will
// exercise the write path.
//
// Kept separate from src/lib/r2.ts so the diagnostic endpoint doesn't
// pull in the full S3 signer and its dependencies.

export interface PreflightSection {
  present: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

export async function r2Head(
  endpoint: string,
  bucket: string,
): Promise<PreflightSection> {
  // Endpoint should be shaped like https://<account>.r2.cloudflarestorage.com
  // — anything with a scheme + host is fine for a reachability check.
  try {
    const trimmed = endpoint.replace(/\/+$/, '');
    // Unauthenticated HEAD — most S3-compatible endpoints return 403
    // (bucket exists, listing denied) or 404 (missing). Both are
    // "reachable"; a network failure is what we care about.
    const url = trimmed + '/' + encodeURIComponent(bucket);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return {
      present: true,
      detail: {
        status: r.status,
        // 200/301/302 = ok, 403 = auth-required (still reachable),
        // 404 = bucket missing (name mismatch)
        interpretation:
          r.status === 200 || r.status === 301 || r.status === 302 || r.status === 307
            ? 'ok'
            : r.status === 403
              ? 'reachable, unauthenticated head refused'
              : r.status === 404
                ? 'bucket_not_found'
                : 'unexpected',
      },
    };
  } catch (err) {
    return {
      present: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
