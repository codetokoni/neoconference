import { expect, test } from "@playwright/test";

/**
 * Smoke suite for the three URLs anyone can hit without a Clerk
 * session — the ones an event organiser hands out to participants,
 * viewers, and broadcasters.
 *
 * These are the pages that break most visibly under a bad deploy
 * (a redirect loop, a 500 on SSR, a client-side crash on hydration)
 * and the ones where breakage is most public. Cheap to run, high
 * signal — this is the minimum bar every PR should clear.
 */

test.describe("public pages", () => {
  test("/video/join?room=neoconf renders the code-entry form", async ({ page }) => {
    const response = await page.goto("/video/join?room=neoconf");
    expect(response?.status(), "join page must respond 2xx").toBeLessThan(400);

    // The page renders JoinFlow, which asks for a code and a name.
    // Match on the aria label / placeholder that JoinFlow uses so
    // the test isn't fragile to copy tweaks.
    await expect(page.getByRole("heading", { name: /join the event/i })).toBeVisible();
    // At least one code-shaped input must exist.
    const codeInput = page.getByPlaceholder(/QAEX-07|528401|code/i).or(
      page.getByLabel(/code/i),
    );
    await expect(codeInput.first()).toBeVisible();
  });

  test("/video/dashboard?room=neoconf renders the programme feed player", async ({ page }) => {
    const response = await page.goto("/video/dashboard?room=neoconf");
    expect(response?.status()).toBeLessThan(400);

    // The dashboard mounts SimulcastPlayer which contains a <video>
    // element for the programme feed. If that's not on the page
    // we've regressed something structural.
    await expect(page.locator("video").first()).toBeAttached();
  });

  test("/video/studio?room=neoconf is public and mounts the studio console", async ({ page }) => {
    // Studio was made intentionally auth-free in PR #171 — this test
    // is the regression guard for that decision. A future change
    // that adds an auth gate would fail here and require an explicit
    // choice, not a silent lockout.
    const response = await page.goto("/video/studio?room=neoconf");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: /push the feed|studio/i })).toBeVisible();
    // Studio-specific UI: at least one "Go live" or camera-picker
    // control should be present.
    await expect(
      page.getByRole("button", { name: /go live|start|camera/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
