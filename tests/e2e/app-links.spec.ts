import { expect, test } from "@playwright/test";

/**
 * Android App Links verification.
 *
 * The mobile app's sign-in callback is https://www.neoconference.app/app/auth,
 * and Android only hands that URL to the app after fetching
 * /.well-known/assetlinks.json anonymously and matching it against the
 * certificate the installed app is signed with.
 *
 * This is worth a test because every way it breaks is silent. Re-protect that
 * path in middleware — easy to do, since the matcher's exclusion list covers
 * `js(?!on)` and so does not exclude .json — and the verifier gets a 404,
 * Android quietly stops trusting the app, and the link starts opening in a
 * browser. Nobody sees an error; sign-in just stops coming back to the app.
 *
 * Changing the release signing key breaks it the same silent way, which is
 * why the fingerprint is asserted rather than merely present.
 */

const PACKAGE = "app.neoconference";
// The SHA-256 of the release signing certificate. If this assertion fails
// after an intentional key change, update it here AND in
// public/.well-known/assetlinks.json — they have to agree or App Links die.
const FINGERPRINT =
  "27:D8:97:99:A4:94:5B:66:54:20:33:C6:69:C8:61:86:A7:CF:E4:05:60:79:52:0F:8C:34:4C:09:8F:1C:DD:D9";

test.describe("android app links", () => {
  test("assetlinks.json is publicly readable and names the app", async ({ request }) => {
    const response = await request.get("/.well-known/assetlinks.json");

    // Anonymous: Android's verifier carries no session. A redirect to
    // /sign-in counts as a failure just as much as a 404 does.
    expect(
      response.status(),
      "assetlinks.json must be public — if middleware protects it, App Links silently stop verifying",
    ).toBe(200);

    const statements = await response.json();
    expect(Array.isArray(statements)).toBe(true);

    const android = statements.find(
      (s: { target?: { namespace?: string; package_name?: string } }) =>
        s?.target?.namespace === "android_app" &&
        s?.target?.package_name === PACKAGE,
    );
    expect(android, `no statement for ${PACKAGE}`).toBeTruthy();
    expect(android.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(
      android.target.sha256_cert_fingerprints,
      "fingerprint must match the release signing certificate",
    ).toContain(FINGERPRINT);
  });

  test("/app/auth is reachable without a session", async ({ page }) => {
    // Where a sign-in started in the app comes back to. Reached before the
    // person has any web session, so it must not sit behind the auth wall.
    const response = await page.goto("/app/auth");
    expect(response?.status(), "/app/auth must respond 2xx").toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/sign-in/);
  });
});
