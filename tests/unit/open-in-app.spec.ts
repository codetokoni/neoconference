import { test, expect } from "@playwright/test";
import { appIntentUrl } from "../../src/components/OpenInAppButton";

// The "Open in the NeoConference app" link: an Android intent for the
// meeting's page, which the app claims, that falls back to where the person
// already is when the app is not installed.
test("opens the meeting page in the app, falling back to this page", () => {
  const url = appIntentUrl("falf", "https://www.neoconference.app/falf");
  expect(url).toBe(
    "intent://www.neoconference.app/e/falf#Intent;scheme=https;package=app.neoconference;" +
      "S.browser_fallback_url=https%3A%2F%2Fwww.neoconference.app%2Ffalf;end"
  );
});
