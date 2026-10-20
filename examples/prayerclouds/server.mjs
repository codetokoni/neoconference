// examples/prayerclouds/server.mjs — a sample PrayerClouds adapter.
//
// What a partner website adds so /zone/<ZONE> shows that zone's NeoLinguaMeet
// meeting, each visitor joining under their own name. Node 18+, no
// dependencies:
//
//   NLM_PARTNER_KEY=nlm_pk_…  SITE_ORIGIN=http://localhost:4000  node server.mjs
//
// Two pieces, both on the partner's own site:
//   GET  /zone/:zone                      the zone page, with the widget script
//   POST /api/prayer-meeting/session      called by the widget; asks
//                                         NeoLinguaMeet for a one-time code
//                                         for THIS signed-in visitor
//
// The secret key stays here, on the server. The browser only ever sees a
// two-minute, single-use code. Replace currentUser() with your own session
// lookup; everything else can stay as it is.

import { createServer } from "node:http";

const KEY = process.env.NLM_PARTNER_KEY || "";
const NLM = (process.env.NLM_ORIGIN || "https://neolinguameet.com").replace(/\/+$/, "");
/** This site's origin exactly as the browser sees it; it must be approved in NeoLinguaMeet's admin. */
const SITE_ORIGIN = (process.env.SITE_ORIGIN || "http://localhost:4000").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 4000);
/** Let visitors without an account in, by name (the integration must allow guests too). */
const GUESTS = process.env.ALLOW_GUESTS === "1";

if (!KEY) {
  console.error("Set NLM_PARTNER_KEY (from NeoLinguaMeet admin > Integrations > Partner zones).");
  process.exit(1);
}

/**
 * The signed-in PrayerClouds user, or null. REPLACE THIS with your own
 * session check (cookie, JWT, framework auth). The sample trusts a demo
 * cookie "demo_user=<id>|<name>" so it can run on its own.
 */
function currentUser(req) {
  const m = /(?:^|;\s*)demo_user=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [id, name] = decodeURIComponent(m[1]).split("|");
  return id && name ? { id, name } : null;
}

const ZONE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** POST /api/prayer-meeting/session?zone=FALF  ->  { code } | { error } */
async function session(req, res, url) {
  // Only this site's own pages may ask (the widget calls it same-origin).
  if (req.headers.origin && req.headers.origin !== SITE_ORIGIN) return send(res, 403, { error: { code: "forbidden", message: "Not from this site." } });
  const zone = url.searchParams.get("zone") || "";
  if (!ZONE_RE.test(zone)) return send(res, 400, { error: { code: "invalid_zone", message: "Unknown zone." } });

  const user = currentUser(req);
  let who;
  if (user) {
    who = { id: String(user.id), displayName: String(user.name).slice(0, 60) };
  } else if (GUESTS) {
    const body = await readJson(req);
    const name = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 60) : "";
    if (!name) return send(res, 401, { error: { code: "name_required", message: "Enter your name to join." } });
    who = { guest: true, displayName: name };
  } else {
    return send(res, 401, { error: { code: "sign_in_required", message: "Sign in to join the prayer meeting." } });
  }

  let r;
  try {
    r = await fetch(`${NLM}/api/partner/v1/join-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ zoneId: zone, origin: SITE_ORIGIN, user: who }),
    });
  } catch {
    return send(res, 502, { error: { code: "unreachable", message: "The meeting service is not reachable. Try again." } });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Pass NeoLinguaMeet's reason on (never the key); log it for yourselves.
    console.warn("[prayer-meeting] join-sessions", r.status, data?.error?.code);
    return send(res, r.status === 401 ? 502 : r.status, { error: data.error || { code: "failed", message: "Could not start the meeting." } });
  }
  return send(res, 200, { code: data.code, expiresAt: data.expiresAt, title: data.meeting?.title });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** GET /zone/:zone — your zone page; only the widget part matters. */
function zonePage(req, res, zone) {
  const user = currentUser(req);
  const endpoint = `/api/prayer-meeting/session?zone=${encodeURIComponent(zone)}`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(zone)} Prayer Meeting</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}#status{font-size:14px;color:#555;min-height:1.4em}</style>
</head><body>
<h1>${escapeHtml(zone)} Prayer Meeting</h1>
${
  user
    ? `<p>Signed in as <strong>${escapeHtml(user.name)}</strong></p>`
    : GUESTS
      ? `<form id="guest"><label>Your name <input name="name" maxlength="60" required></label> <button>Join as a guest</button></form>`
      : `<p><a href="/login?next=${encodeURIComponent(`/zone/${zone}`)}">Sign in</a> to join.</p>`
}
<p id="status"></p>
<div id="meeting"></div>
<script src="${NLM}/widget/v1.js"></script>
<script>
  const status = document.getElementById("status");
  const signedIn = ${user ? "true" : "false"};
  function start(guestName) {
    const widget = NeoLinguaMeetWidget.mount({
      container: "#meeting",
      sessionEndpoint: ${JSON.stringify(endpoint)},
      // A guest's name goes in the request body, never in the address.
      sessionBody: guestName ? { displayName: guestName } : undefined,
      height: "min(80vh, 720px)",
    });
    listen(widget);
  }
  const guest = document.getElementById("guest");
  if (signedIn) start();
  else if (guest) guest.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = new FormData(guest).get("name").trim();
    if (!name) return;
    guest.remove();
    start(name);
  });
  function listen(widget) {
  widget.on("ready", (e) => { status.textContent = "Joining as " + e.participant.name; });
  widget.on("waiting", (e) => { status.textContent = e.reason === "waiting_room" ? "Waiting to be let in…" : "Waiting for the host…"; });
  widget.on("joined", () => { status.textContent = "You are in the meeting."; });
  widget.on("left", () => { status.textContent = "You left the meeting."; });
  widget.on("meeting-ended", () => { status.textContent = "The meeting has ended."; });
  widget.on("permission-denied", (e) => { status.textContent = "Allow your " + e.device + " in the browser to be seen and heard."; });
  widget.on("error", (e) => { status.textContent = e.message || "Could not open the meeting."; });
  }
</script>
</body></html>`);
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", SITE_ORIGIN);
  const zone = /^\/zone\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (req.method === "GET" && zone && ZONE_RE.test(decodeURIComponent(zone))) return zonePage(req, res, decodeURIComponent(zone));
  if (req.method === "POST" && url.pathname === "/api/prayer-meeting/session") return session(req, res, url);
  if (req.method === "GET" && url.pathname === "/demo-login") {
    // Demo only: pretend to sign in. Your site has its own login.
    const id = url.searchParams.get("id") || "pc_demo";
    const name = url.searchParams.get("name") || "Demo Visitor";
    res.writeHead(302, { "set-cookie": `demo_user=${encodeURIComponent(`${id}|${name}`)}; Path=/; HttpOnly; SameSite=Lax`, location: url.searchParams.get("next") || "/zone/FALF" });
    return res.end();
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}).listen(PORT, () => console.log(`PrayerClouds sample on ${SITE_ORIGIN} (try /demo-login?name=Grace then /zone/FALF)`));
