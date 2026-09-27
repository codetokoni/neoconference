// src/lib/slugWinners.ts
//
// Hide records whose slug now belongs to a different event.
//
// A slug resolves to exactly one event, and joining goes by slug — so an
// orphan left over from the adoption race (see createIfSlugFree) looks like
// a separate meeting in a list but opens the winner's room when tapped.
// Listing it is worse than omitting it. The web dashboard and the app's
// list (/api/events/mine) both go through this; the dashboard used to skip
// it and showed one room four times.
//
// Nothing is deleted: these records still hold their own chat and
// recordings, and a slug lookup only happens for slugs that actually appear
// more than once, so the common case costs no extra reads.
//
// Kept apart from eventStore so it can be tested without a KV client.

export async function withoutSupersededSlugs<T extends { id: string; slug: string }>(
  all: T[],
  /** The id the slug index points at now, or null when it points nowhere. */
  currentIdFor: (slug: string) => Promise<string | null>
): Promise<T[]> {
  const bySlugCount = new Map<string, number>();
  for (const ev of all) {
    bySlugCount.set(ev.slug, (bySlugCount.get(ev.slug) ?? 0) + 1);
  }
  // Array.from rather than spreading the iterator: this project's tsconfig
  // targets below es2015 and rejects iterating a Map directly.
  const contested = Array.from(bySlugCount.keys()).filter(
    (slug) => (bySlugCount.get(slug) ?? 0) > 1
  );

  const winners = new Map<string, string>();
  await Promise.all(
    contested.map(async (slug) => {
      const id = await currentIdFor(slug);
      if (id) winners.set(slug, id);
    })
  );

  return all.filter((ev) => {
    const winner = winners.get(ev.slug);
    return winner === undefined || winner === ev.id;
  });
}
