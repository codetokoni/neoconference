import { test, expect } from "@playwright/test";
import { APP_STORE_URL, appOpenUrl, gateExempt, gateOffers, isAndroid, meetingSlugFromPath, shouldAutoOpen } from "../../src/lib/appGate";

/**
 * Android phones are asked to use the app (LoveWorld AppStore); iPhones and
 * computers keep the website, since the app is Android-only.
 */
test("only Android is asked for the app", () => {
  expect(isAndroid("Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36")).toBe(true);
  expect(isAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1")).toBe(false);
  expect(isAndroid("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36")).toBe(false);
  expect(isAndroid("")).toBe(false);
});

test("pages the app needs, or cannot do, stay open on Android", () => {
  for (const p of ["/app/auth", "/support", "/e/falf/replay", "/embed/falf", "/admin/events", "/sign-out"]) {
    expect(gateExempt(p), p).toBe(true);
  }
  // The live-event broadcast: the app has no participant-code join or
  // programme player, so these stay on the website (reported 8 Oct 2026).
  for (const p of ["/video/join", "/video/dashboard", "/video/room", "/video/studio"]) {
    expect(gateExempt(p, "?room=neoconf"), p).toBe(true);
  }
  // …but not a meeting whose short link merely starts with "video".
  expect(gateExempt("/videos")).toBe(false);
  // Signing in on the way to an operator page under /video/ (the
  // middleware sends a signed-out visitor there with redirect_url).
  const back = encodeURIComponent("https://www.neoconference.app/video/room/moderate?room=neoconf");
  expect(gateExempt("/sign-in", `?redirect_url=${back}`)).toBe(true);
  expect(gateExempt("/sign-in/factor-one", `?redirect_url=${back}`)).toBe(true);
  expect(gateExempt("/sign-up", "?redirect_url=%2Fvideo%2Frooms")).toBe(true);
  // The app's KingsChat sign-in falls back through /sign-in with a ticket.
  expect(gateExempt("/sign-in", "?__clerk_ticket=abc")).toBe(true);
  // Anything the app itself opened.
  expect(gateExempt("/", "?from=app")).toBe(true);
});

test("everything else on Android asks for the app", () => {
  for (const p of ["/", "/falf", "/e/falf", "/room/falf", "/dashboard", "/pricing", "/sign-in", "/explore"]) {
    expect(gateExempt(p), p).toBe(false);
  }
  // A sign-in going anywhere else, or to /video/ on someone else's site.
  expect(gateExempt("/sign-in", "?redirect_url=%2Fdashboard")).toBe(false);
  expect(gateExempt("/sign-in", "?redirect_url=" + encodeURIComponent("https://evil.test/video/join"))).toBe(false);
  expect(gateExempt("/sign-in", "?redirect_url=%2Fvideos")).toBe(false);
});

test("a meeting page opens that meeting in the app", () => {
  expect(meetingSlugFromPath("/e/global-partners")).toBe("global-partners");
  expect(meetingSlugFromPath("/room/abc", "?event=global-partners")).toBe("global-partners");
  expect(meetingSlugFromPath("/room/global-partners")).toBe("global-partners");
  expect(meetingSlugFromPath("/hscrusade")).toBe("hscrusade");
  // Real pages are not meetings.
  for (const p of ["/", "/pricing", "/dashboard", "/sign-in", "/support", "/app"]) {
    expect(meetingSlugFromPath(p), p).toBeNull();
  }
});

test("open-in-app falls back to the store when the app is missing", () => {
  const meeting = appOpenUrl("hscrusade");
  expect(meeting).toContain("intent://www.neoconference.app/e/hscrusade#Intent;scheme=https;package=app.neoconference;");
  expect(meeting).toContain("S.browser_fallback_url=" + encodeURIComponent(APP_STORE_URL));
  const app = appOpenUrl(null);
  expect(app).toContain("action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=app.neoconference;");
  expect(app).toContain(encodeURIComponent(APP_STORE_URL));
});

test("a phone that downloaded the app opens it, once per tab", () => {
  expect(shouldAutoOpen(true, false)).toBe(true);
  // Already tried in this tab: back here means it did not open; ask instead.
  expect(shouldAutoOpen(true, true)).toBe(false);
  // Never downloaded: the download screen.
  expect(shouldAutoOpen(false, false)).toBe(false);
});

test("download is offered only the first time; after that only opening the app", () => {
  expect(gateOffers(false)).toEqual({ download: true, open: true });
  // Downloaded before (or opened from the app): no download button again.
  expect(gateOffers(true)).toEqual({ download: false, open: true });
  // …and opening still reaches the store on a phone where the app is missing.
  expect(appOpenUrl(null)).toContain("S.browser_fallback_url=" + encodeURIComponent(APP_STORE_URL));
});
