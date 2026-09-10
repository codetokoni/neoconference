import { expect, test } from "@playwright/test";

/**
 * The moderator + admin surfaces went through a lot of
 * public/gated churn (PRs #171, #172, #175). Encode the current
 * intended posture as tests so the next "make this public" or
 * "make this admin only" change makes an intentional choice
 * instead of accidentally flipping a policy the org decided on.
 *
 * Test the redirects, not the target pages — the target pages need
 * Clerk sessions and this suite runs anonymous.
 */

test.describe("auth walls", () => {
  test("/video/room/moderate bounces anonymous users to /sign-in", async ({ page }) => {
    // Follow the redirect chain but don't error on the intermediate
    // 3xx. Clerk sends the user to /sign-in with a redirect_url that
    // brings them back after auth.
    const response = await page.goto("/video/room/moderate?room=neoconf");
    // We should end up on the sign-in page, not the moderator hub.
    await expect(page).toHaveURL(/\/sign-in/);
    expect(response?.status()).toBeLessThan(500);
  });

  test("/video/room bounces anonymous users away from the admin hub", async ({ page }) => {
    // The admin hub is doubly gated: Clerk auth + video-admin email
    // allowlist. Anonymous should hit the outer auth wall first.
    await page.goto("/video/room?room=neoconf");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("public /api/video/status accepts anonymous callers", async ({ request }) => {
    // Baseline that we haven't accidentally locked down the read-only
    // status endpoint the audience-facing dashboard polls. Without
    // this the OFF AIR badge and the "N watching" chip go dark for
    // every unauthed viewer.
    const r = await request.get("/api/video/status?room=neoconf");
    expect(r.status()).toBeLessThan(400);
    const body = await r.json();
    expect(body.ok).toBeTruthy();
  });
});
