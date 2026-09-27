/**
 * The `message` of whatever was thrown, or undefined — exactly what
 * `e?.message` read when catch bindings were typed `any`, without the `any`.
 *
 * Deliberately no fallback: each caller keeps its own `|| "..."` so the text
 * people see is unchanged.
 */
export function errorMessage(e: unknown): string | undefined {
  if (e === null || e === undefined) return undefined;
  const m = (e as { message?: unknown }).message;
  return typeof m === "string" ? m : undefined;
}

/**
 * The first entry of a Clerk error's `errors` list, or undefined — what
 * `err?.errors?.[0]` read when the binding was `any`.
 */
export function firstClerkError(
  e: unknown
): { code?: string; message?: string; longMessage?: string } | undefined {
  if (e === null || e === undefined) return undefined;
  const list = (e as { errors?: unknown }).errors;
  return Array.isArray(list) ? list[0] : undefined;
}
