// Run: npx tsx src/lib/__tests__/brandSwitch.smoke.ts
//
// NeoConference becomes NeoLinguaMeet at https://neolinguameet.com (owner,
// 2026-10-19) by one setting, NEXT_PUBLIC_PRIMARY_DOMAIN. This runs the
// site's own code with the switch on: the redirects from the old domain,
// the links it builds, the names it shows, and what must NOT move (the
// old domain's API, app links and KingsChat identities). With it off,
// nothing changes — every other smoke test runs that way.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.NEXT_PUBLIC_PRIMARY_DOMAIN = "neolinguameet.com";
// What Vercel holds today: the old address. The switch must win over it.
process.env.NEXT_PUBLIC_SITE_URL = "https://www.neoconference.app";

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const B = await import("../brand");
  const go = (url: string) => {
    const u = new URL(url);
    return B.legacyRedirect(u, u.host)?.toString() ?? null;
  };

  await t("the switch is on: NeoLinguaMeet at https://neolinguameet.com", () => {
    assert.equal(B.BRAND.name, "NeoLinguaMeet");
    assert.equal(B.BRAND.origin, "https://neolinguameet.com");
    assert.equal(B.BRAND.supportEmail, "info@neolinguameet.com");
    assert.equal(`${B.BRAND.nameHead}${B.BRAND.nameTail}`, "NeoLinguaMeet");
  });

  await t("old pages go to the new domain in one hop, path and query kept", () => {
    assert.equal(
      go("https://neoconference.app/video/join?room=global-men-crusade"),
      "https://neolinguameet.com/video/join?room=global-men-crusade",
    );
    assert.equal(go("https://www.neoconference.app/e/falf?x=1&y=two%20words"), "https://neolinguameet.com/e/falf?x=1&y=two%20words");
    assert.equal(go("https://www.neoconference.app/hscrusade"), "https://neolinguameet.com/hscrusade");
    assert.equal(go("https://www.neoconference.app/"), "https://neolinguameet.com/");
    assert.equal(go("https://www.neoconference.app/sign-in?redirect_url=%2Fdashboard"), "https://neolinguameet.com/sign-in?redirect_url=%2Fdashboard");
    // Not /app/…, only paths that merely start with the same letters.
    assert.equal(go("https://www.neoconference.app/apps"), "https://neolinguameet.com/apps");
  });

  await t("www.neolinguameet.com goes to the bare domain; the bare domain is served", () => {
    assert.equal(go("https://www.neolinguameet.com/pricing?plan=pro"), "https://neolinguameet.com/pricing?plan=pro");
    assert.equal(go("https://www.neolinguameet.com/api/version"), "https://neolinguameet.com/api/version");
    assert.equal(go("https://neolinguameet.com/pricing"), null);
    assert.equal(go("https://neolinguameet.com/"), null);
  });

  await t("the old domain keeps serving its API, App Link checks and the app's sign-in link", () => {
    for (const p of [
      "/api/livekit/token?room=x",
      "/api/livekit/webhook",
      "/api/auth/kingschat/callback?redirect_url=x",
      "/api/app/latest",
      "/.well-known/assetlinks.json",
      "/app/auth",
      "/app/auth?__clerk_ticket=abc",
    ]) {
      assert.equal(go("https://www.neoconference.app" + p), null, p);
      assert.equal(go("https://neoconference.app" + p), null, p);
    }
  });

  await t("the real middleware redirects as Vercel runs it, and lets the old API through", async () => {
    const { NextRequest } = await import("next/server");
    const middleware = (await import("../../middleware")).default as unknown as (
      req: InstanceType<typeof NextRequest>,
      ev: unknown,
    ) => Promise<Response | undefined>;
    const hit = async (url: string, init: { method?: string } = {}) => {
      const u = new URL(url);
      return middleware(new NextRequest(url, { ...init, headers: { host: u.host } }), { waitUntil() {} });
    };
    const moved = await hit("https://neoconference.app/video/join?room=global-men-crusade");
    assert.equal(moved?.status, 308);
    assert.equal(moved?.headers.get("location"), "https://neolinguameet.com/video/join?room=global-men-crusade");
    // A form or API client posting to www.neolinguameet.com keeps its method (308, not 301).
    const post = await hit("https://www.neolinguameet.com/support", { method: "POST" });
    assert.equal(post?.status, 308);
    assert.equal(post?.headers.get("location"), "https://neolinguameet.com/support");
    for (const p of ["/api/version", "/api/app/latest", "/app/auth"]) {
      const r = await hit("https://www.neoconference.app" + p);
      assert.notEqual(r?.status, 308, p);
      assert.equal(r?.headers.get("location") ?? null, null, p);
    }
    // The new domain itself is served (a public page, signed out).
    const home = await hit("https://neolinguameet.com/pricing");
    assert.notEqual(home?.status, 308);
  });

  await t("customers' own domains and previews are never redirected", () => {
    assert.equal(go("https://live.acme.com/"), null);
    assert.equal(go("https://neoconference-git-x.vercel.app/pricing"), null);
    assert.equal(go("http://localhost:3000/"), null);
  });

  await t("renamed but not moved (the default since 2026-10-20): the new name, the old address, nobody redirected", () => {
    const renamed = B.brandFor(undefined);
    assert.equal(renamed.name, "NeoLinguaMeet");
    assert.equal(renamed.tagline, "LinguaMeet by Neo");
    assert.equal(renamed.supportEmail, "info@neolinguameet.com");
    assert.equal(renamed.origin, "https://www.neoconference.app");
    assert.equal(renamed.domain, "neoconference.app");
    assert.equal(renamed.moved, false);
    const u = new URL("https://www.neoconference.app/video/join?room=x");
    assert.equal(B.legacyRedirect(u, u.host, renamed), null);
    assert.equal(B.legacyRedirect(new URL("https://www.neolinguameet.com/"), "www.neolinguameet.com", renamed), null);
  });

  await t("NEXT_PUBLIC_BRAND_NAME=neoconference puts the old name back; moving the address brings the new name anyway", () => {
    const back = B.brandFor(undefined, "neoconference");
    assert.equal(back.name, "NeoConference");
    assert.equal(back.tagline, null);
    assert.equal(back.origin, "https://www.neoconference.app");
    const moved = B.brandFor("neolinguameet.com", "neoconference");
    assert.equal(moved.name, "NeoLinguaMeet");
    assert.equal(moved.origin, "https://neolinguameet.com");
    assert.equal(moved.moved, true);
  });

  await t("links are built on the new domain, though Vercel still says the old one", () => {
    assert.equal(B.siteOrigin(), "https://neolinguameet.com");
    const fromOld = new Request("https://www.neoconference.app/api/events/create", { headers: { host: "www.neoconference.app" } });
    assert.equal(B.linkOrigin(fromOld), "https://neolinguameet.com");
    // A preview or local build still links to itself when nothing is set.
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      const preview = new Request("https://x.vercel.app/api/qr/a", { headers: { host: "neoconference-git-x.vercel.app" } });
      assert.equal(B.linkOrigin(preview), "https://neoconference-git-x.vercel.app");
      assert.equal(B.linkOrigin(fromOld), "https://neolinguameet.com");
    } finally {
      process.env.NEXT_PUBLIC_SITE_URL = saved;
    }
  });

  await t("the app update message points at the new domain", async () => {
    const R = await import("../appRelease");
    assert.equal(R.UPDATE_URL, "https://neolinguameet.com/download");
    assert.match(R.UPDATE_MESSAGE, /^A new version of NeoLinguaMeet is available.*neolinguameet\.com\/download/);
  });

  await t("both apps' sign-in links are accepted, and each is answered on its own", async () => {
    const A = await import("../app-callback");
    assert.equal(A.isAppCallback("https://www.neoconference.app/app/auth"), true);
    assert.equal(A.isAppCallback("https://neolinguameet.com/app/auth"), true);
    assert.equal(A.isAppCallback("https://evil.test/app/auth"), false);
    assert.equal(A.isAppCallback("https://neolinguameet.com/app/auth/x"), false);
    const oldApp = A.redirectToApp({ __clerk_ticket: "t" }, "https://www.neoconference.app/app/auth");
    assert.equal(oldApp.headers.get("location"), "https://www.neoconference.app/app/auth?__clerk_ticket=t");
    const newApp = A.redirectToApp({ __clerk_ticket: "t" }, "https://neolinguameet.com/app/auth");
    assert.equal(newApp.headers.get("location"), "https://neolinguameet.com/app/auth?__clerk_ticket=t");
    // Anything else falls back to the link every app version opens.
    const other = A.redirectToApp({ payment: "cancelled" }, "https://evil.test/app/auth");
    assert.equal(other.headers.get("location"), "https://www.neoconference.app/app/auth?payment=cancelled");
  });

  await t("phones still open the app through the host every app version claims", async () => {
    const G = await import("../appGate");
    assert.match(G.appOpenUrl("falf", "https://neolinguameet.com/falf?noapp=1"), /^intent:\/\/www\.neoconference\.app\/e\/falf#Intent;scheme=https;package=app\.neoconference;/);
    // A sign-in leading back to a meeting, on either domain, is that meeting.
    assert.equal(G.meetingForGate("/sign-in", "?redirect_url=" + encodeURIComponent("https://neolinguameet.com/testify")), "testify");
    assert.equal(G.meetingForGate("/sign-in", "?redirect_url=" + encodeURIComponent("https://www.neoconference.app/testify")), "testify");
    assert.equal(G.meetingForGate("/sign-in", "?redirect_url=" + encodeURIComponent("https://evil.test/testify")), null);
  });

  await t("a name or support address saved under the old brand reads as the new one; a chosen one stays", async () => {
    const M = await import("../platform/model");
    const legacy = M.withDefaults({
      branding: { platformName: "NeoConference", logoKey: null, logoType: null, logoVersion: 0 },
      contacts: { supportEmail: "info@neoconference.app", supportPhone: "", links: [] },
    });
    assert.equal(legacy.branding.platformName, "NeoLinguaMeet");
    assert.equal(legacy.contacts.supportEmail, "info@neolinguameet.com");
    const chosen = M.withDefaults({
      branding: { platformName: "Christ Embassy Online", logoKey: null, logoType: null, logoVersion: 0 },
      contacts: { supportEmail: "help@ce.org", supportPhone: "", links: [] },
    });
    assert.equal(chosen.branding.platformName, "Christ Embassy Online");
    assert.equal(chosen.contacts.supportEmail, "help@ce.org");
  });

  await t("KingsChat accounts keep their identity on the old domain", async () => {
    const src = (await import("node:fs")).readFileSync("src/lib/kc-signin.ts", "utf8");
    assert.match(src, /'@kc\.neoconference\.app'/);
  });

  await t("search engines and the API reference get the new name and address", async () => {
    const robots = (await import("../../app/robots")).default();
    assert.equal(robots.sitemap, "https://neolinguameet.com/sitemap.xml");
    const sitemap = await (await import("../../app/sitemap")).default();
    assert.ok(sitemap.some((e) => e.url === "https://neolinguameet.com/pricing"), JSON.stringify(sitemap.slice(0, 3)));
    assert.ok(sitemap.every((e) => e.url.startsWith("https://neolinguameet.com/")));
    const spec = (await (await import("../../app/openapi.json/route")).GET().json()) as {
      info: { title: string; description: string };
      servers: { url: string }[];
    };
    assert.equal(spec.info.title, "NeoLinguaMeet API");
    assert.equal(spec.servers[0].url, "https://neolinguameet.com/api/v1");
    assert.doesNotMatch(JSON.stringify(spec), /neoconference/i);
    const manifest = (await import("../../app/manifest")).default();
    assert.equal(manifest.name, "NeoLinguaMeet");
  });

  await t('the homepage leads with "LinguaMeet by Neo"; switched off it reads as before', async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { createElement } = React;
    // This runner compiles JSX to React.createElement (Next does not need the global).
    (globalThis as { React?: unknown }).React = React;
    const Headline = (await import("../../app/HomeHeadline")).default;
    const on = renderToStaticMarkup(createElement(Headline));
    assert.match(on, /<h1[^>]*>[\s\S]*LinguaMeet[\s\S]*by Neo\.[\s\S]*<\/h1>/);
    assert.match(on, /One meeting, every language\. NeoLinguaMeet translates your meetings live/);
    const off = renderToStaticMarkup(createElement(Headline, { brand: B.brandFor(undefined, "neoconference") }));
    assert.match(off, /One meeting\.[\s\S]*Every language\./);
    assert.match(off, /NeoConference translates your meetings live/);
    assert.doesNotMatch(off, /LinguaMeet/);
    assert.equal(B.siteTitle(), "NeoLinguaMeet — LinguaMeet by Neo, video meetings with live translation");
    assert.equal(B.siteTitle(B.brandFor(undefined, "neoconference")), "NeoConference — Video meetings with live translation");
    assert.equal(B.siteTitle(B.brandFor(undefined)), "NeoLinguaMeet — LinguaMeet by Neo, video meetings with live translation");
  });

  await t("the icons browsers fetch by fixed paths come from the NeoLinguaMeet set", async () => {
    const cfg = (await import("../../../next.config.mjs")).default as { redirects: () => Promise<{ source: string; destination: string }[]> };
    const r = await cfg.redirects();
    const to = Object.fromEntries(r.map((x) => [x.source, x.destination]));
    assert.equal(to["/favicon.ico"], "/brand/neolinguameet/favicon.ico");
    assert.equal(to["/icons/icon-512.png"], "/brand/neolinguameet/icon-512.png");
    assert.equal(to["/apple-touch-icon.png"], "/brand/neolinguameet/apple-touch-icon.png");
    const fs = await import("node:fs");
    for (const dest of Object.values(to)) assert.ok(fs.existsSync("public" + dest), dest);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
