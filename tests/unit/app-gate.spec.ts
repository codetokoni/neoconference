import { test, expect } from "@playwright/test";
import { appOpenUrl, backToPage, gateExempt, isAndroid, meetingSlugFromPath, noAppFallback, shouldAutoOpen } from "../../src/lib/appGate";

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

test("open-in-app comes back to the page, not the store, when the app does not open", () => {
  // People who had the app were sent to the store every time a link did not
  // open it; a failed open now returns to the page, marked noapp.
  const back = backToPage("https://www.neoconference.app/hscrusade");
  expect(back).toBe("https://www.neoconference.app/hscrusade?noapp=1");
  const meeting = appOpenUrl("hscrusade", back);
  expect(meeting).toContain("intent://www.neoconference.app/e/hscrusade#Intent;scheme=https;package=app.neoconference;");
  expect(meeting).toContain("S.browser_fallback_url=" + encodeURIComponent(back));
  const app = appOpenUrl(null, back);
  // Not a page's meeting: the app's home, through a link Chrome may hand to
  // it (BROWSABLE). The MAIN/LAUNCHER intent it used never opened the app.
  expect(app).toBe(
    "intent://www.neoconference.app/app/auth#Intent;scheme=https;package=app.neoconference;S.browser_fallback_url=" +
      encodeURIComponent(back) +
      ";end",
  );
  expect(app).not.toContain("LAUNCHER");
  expect(app).not.toContain("lwappstore");
});

test("no Download screen: a phone without the app goes straight to sign-in, back to its page", () => {
  // Signed out, a meeting link: sign in, then on to the meeting.
  expect(noAppFallback("https://www.neoconference.app/hscrusade", false)).toBe(
    "https://www.neoconference.app/sign-in?redirect_url=%2Fhscrusade&noapp=1",
  );
  expect(noAppFallback("https://www.neoconference.app/e/falf?x=1", false)).toBe(
    "https://www.neoconference.app/sign-in?redirect_url=%2Fe%2Ffalf%3Fx%3D1&noapp=1",
  );
  // The home page: plain sign-in.
  expect(noAppFallback("https://www.neoconference.app/", false)).toBe("https://www.neoconference.app/sign-in?noapp=1");
  // Signed in, or already on sign-in: stay on the page.
  expect(noAppFallback("https://www.neoconference.app/hscrusade", true)).toBe(
    "https://www.neoconference.app/hscrusade?noapp=1",
  );
  expect(noAppFallback("https://www.neoconference.app/sign-in?redirect_url=%2Fhscrusade", false)).toBe(
    "https://www.neoconference.app/sign-in?redirect_url=%2Fhscrusade&noapp=1",
  );
  for (const signedIn of [false, true]) {
    expect(noAppFallback("https://www.neoconference.app/hscrusade", signedIn)).not.toContain("lwappstore");
  }
});

test("every Android visit tries the app once per tab, but not back from a failed try or in an app's browser", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 16; SM-S921B) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";
  expect(shouldAutoOpen({ triedThisTab: false, search: "", userAgent: chrome })).toBe(true);
  // Already tried in this tab, or back from a failed try: show the choices.
  expect(shouldAutoOpen({ triedThisTab: true, search: "", userAgent: chrome })).toBe(false);
  expect(shouldAutoOpen({ triedThisTab: false, search: "?noapp=1", userAgent: chrome })).toBe(false);
  // An app's built-in browser (WebView) cannot open intent links.
  expect(shouldAutoOpen({ triedThisTab: false, search: "", userAgent: chrome.replace("SM-S921B)", "SM-S921B; wv)") })).toBe(false);
});
