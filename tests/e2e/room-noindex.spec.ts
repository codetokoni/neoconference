import { expect, test } from "@playwright/test";

/**
 * Meeting rooms stay out of search results.
 *
 * Any unclaimed top-level address is rewritten to a room page so the first
 * signed-in visitor can claim it, which made every made-up URL an
 * indexable 200. The home page is the control: it must stay indexable, or
 * the check below would pass for a site-wide noindex too.
 *
 * Signed-out GETs only; nothing is claimed or created.
 */

const NOINDEX = /<meta name="robots" content="noindex/;

test.describe("robots", () => {
  test("an unclaimed short address is not indexable", async ({ request }) => {
    const res = await request.get("/zz-noindex-probe-" + Date.now().toString(36));
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(NOINDEX);
  });

  test("a room page is not indexable", async ({ request }) => {
    const res = await request.get("/room/zz-noindex-probe?event=zz-noindex-probe");
    expect(res.status()).toBeLessThan(400);
    expect(await res.text()).toMatch(NOINDEX);
  });

  test("the home page stays indexable", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(NOINDEX);
  });
});
