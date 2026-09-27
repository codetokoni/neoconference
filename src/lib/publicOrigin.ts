// src/lib/publicOrigin.ts
//
// The origin an outside service can call this deployment back on, or
// undefined when there is none. Deepgram posts transcripts back here.

export function publicOrigin(req: Request): string | undefined {
  // Preview deployments sit behind Vercel's deployment protection, which
  // would turn the callback away; they wait inline instead.
  if (process.env.VERCEL_ENV === 'preview') return undefined;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (!host) return undefined;
  // Nothing outside can reach a developer's machine.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return undefined;
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  return proto + '://' + host;
}
