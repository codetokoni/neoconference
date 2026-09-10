import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config.
 *
 * By default we hit the deployed production URL — the smoke tests
 * here are non-mutating and read-only, so they're safe to run against
 * a live site and immediately answer "did this PR break something
 * users see." In CI we override `PLAYWRIGHT_BASE_URL` with the Vercel
 * preview URL for the PR under test so the check gates the deploy
 * that produced it.
 *
 * For fully-local development, run `next dev` on port 3000 in one
 * terminal and `PLAYWRIGHT_BASE_URL=http://localhost:3000 npx
 * playwright test` in another. Playwright respects that env and
 * skips starting a webServer of its own — assumes you know what's
 * running.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // 60s hard cap so a hung network probe doesn't wedge CI.
  timeout: 60_000,
  // Retry once on CI because Vercel preview deploys can be cold
  // on first hit; locally, a flake is a flake and we want to see it.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "https://www.neoconference.app",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Every navigation gets 20s to load — plenty for a Vercel cold
    // start plus a fresh KV round trip.
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
