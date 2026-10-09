// src/lib/espeesTrace.ts
//
// What happened when eSPees sent a buyer back. The return and fail routes
// answer every outcome with a 303, and the request log strips the query, so
// before this a purchase that never landed left no trace of why: production
// had no payment record and nothing said whether the nonce was unknown, the
// checkout already resolved, or Clerk refused. Each request now logs one
// line saying which branch it took.
//
// Never logged: the nonce itself (it is the bearer token for the upgrade)
// or any query value. Only the parameter names eSPees sent, so we can see
// whether it adds its own.

const NONCE = /^[0-9a-f]{48}/i;

export type NonceShape = "ok" | "trimmed" | "missing" | "malformed";

/**
 * The checkout nonce from the URL. billingStore mints 48 hex characters; if
 * eSPees appends something to the URL we gave it (e.g. "?ref=…" after our
 * "?nonce=…", which a query parser reads as part of the nonce), the leading
 * 48 are still ours and still have to match a pending record.
 */
export function readNonce(url: URL): { nonce: string; shape: NonceShape } {
  const raw = (url.searchParams.get("nonce") || "").trim();
  if (!raw) return { nonce: "", shape: "missing" };
  const m = raw.match(NONCE);
  if (!m) return { nonce: raw, shape: "malformed" };
  return { nonce: m[0].toLowerCase(), shape: m[0].length === raw.length ? "ok" : "trimmed" };
}

export function traceEspees(
  route: "return" | "fail",
  outcome: string,
  url: URL,
  shape: NonceShape,
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  console.info(
    JSON.stringify({
      tag: `espees-${route}`,
      outcome,
      nonce: shape,
      queryKeys: [...new Set(url.searchParams.keys())],
      ...extra,
    }),
  );
}
