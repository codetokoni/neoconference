import { expect, test } from "@playwright/test";

/**
 * /api/version is what makes a stale deployment visible.
 *
 * A Vercel production deployment can build, pass every check and report
 * success while the alias stays pinned to an older deployment. Nothing
 * errors; the only symptom is that merged code does not run, which reads
 * like a code bug and costs hours to chase.
 *
 * scripts/check-deploy.mjs compares this endpoint against the commit you
 * merged. These tests guard the endpoint itself — if it stops answering
 * anonymously, the check stops working and we are blind again in exactly
 * the way this was built to prevent. The middleware matcher does not
 * exclude API routes, so protecting it is a one-line mistake away.
 */

test.describe("deployment version", () => {
  test("/api/version answers anonymously with a commit", async ({ request }) => {
    const response = await request.get("/api/version");

    expect(
      response.status(),
      "/api/version must be public — a deploy check that needs credentials is one nobody runs",
    ).toBe(200);

    const body = await response.json();

    // sha is null in a local dev run, where Vercel's build vars are absent.
    // Against a real deployment it must be present, or the check has
    // nothing to compare and would pass vacuously.
    if (body.env && body.env !== "development") {
      expect(
        body.sha,
        "a deployed build must report the commit it came from",
      ).toBeTruthy();
    }

    expect(body).toHaveProperty("deploymentId");
    expect(body).toHaveProperty("env");
  });

  test("/api/version is never cached", async ({ request }) => {
    // A cached answer would report the previous deployment and defeat the
    // whole point — the check would confirm a stale alias as healthy.
    const response = await request.get("/api/version");
    const cacheControl = response.headers()["cache-control"] ?? "";
    expect(cacheControl).toContain("no-store");
  });
});
