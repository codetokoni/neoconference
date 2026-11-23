#!/usr/bin/env bash
# Big-meeting load test: does a phone survive a churning 270-person meeting
# when it receives everything (the site before big-meeting receiving), and
# with big-meeting receiving (only unmuted microphones and on-screen cameras)?
#
# Run on a throwaway Ubuntu 24.04 machine (DigitalOcean CPU-Optimized, 32 vCPU),
# as root, with your LiveKit project's details in the environment:
#
#   export LIVEKIT_URL=wss://<your-project>.livekit.cloud
#   export LIVEKIT_API_KEY=<key>
#   export LIVEKIT_API_SECRET=<secret>
#   bash big-meeting-loadtest.sh
#
# big-meeting-phone.js must sit next to this script (build it in the repo with
# `npm run loadtest:build`, see README.md): it is the site's own
# big-meeting receiver (src/components/conference/bigMeetingSubscriptions.ts)
# bundled with livekit-client, so "selective" phones run the real fix.
#
# It joins a room named loadtest-<time> on that project, so run it when no big
# meeting is on (the simulated people count against the project's 1,000).
# Takes about 15 minutes. Paste back everything after "==== RESULTS".
# Knobs (optional): STEADY=200 CAMS=20 BATCH=10 PHONES=3 SECONDS=180 CPU=4
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/big-meeting-phone.js" ] || { echo "big-meeting-phone.js must be next to this script"; exit 1; }
: "${LIVEKIT_URL:?set LIVEKIT_URL}" "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}" "${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}"

if ! command -v lk >/dev/null; then curl -sSL https://get.livekit.io/cli | bash; fi
if ! command -v node >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; fi
mkdir -p /opt/bigmeeting && cd /opt/bigmeeting
if [ ! -d node_modules/playwright ]; then
  npm init -y >/dev/null
  npm i --silent playwright@1.63.0 livekit-server-sdk@2.15.2
  npx playwright install --with-deps chromium >/dev/null
fi
cp "$HERE/big-meeting-phone.js" phone.js

cat > phone.html <<'HTML'
<!doctype html><html><head><meta name=viewport content="width=device-width"><style>
body{margin:0;background:#000}#scroller{position:absolute;inset:0;overflow-y:auto}
#grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 12px 16px}
.tile{height:120px;background:#222;border-radius:12px;overflow:hidden}.tile video{width:100%;height:100%;object-fit:cover}
</style></head><body><div id=scroller><div id=grid></div></div>
<script src="phone.js"></script></body></html>
HTML

cat > run.mjs <<'JS'
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { AccessToken } from "livekit-server-sdk";
const { LIVEKIT_URL: URL_WS, LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET } = process.env;
const ROOM = "loadtest-" + Date.now();
const STEADY = +(process.env.STEADY || 200), CAMS = +(process.env.CAMS || 20), BATCH = +(process.env.BATCH || 10);
const PHONES = +(process.env.PHONES || 3), SECONDS = +(process.env.SECONDS || 180), CPU = +(process.env.CPU || 4);
const kids = [];
const lk = (args) => { const k = spawn("lk", ["load-test", "--url", URL_WS, "--api-key", KEY, "--api-secret", SECRET, "--room", ROOM, ...args], { stdio: "ignore" }); kids.push(k); return k; };
const stop = () => { for (const k of kids) try { k.kill("SIGINT"); } catch {} };
process.on("exit", stop); process.on("SIGINT", () => process.exit(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (id) => { const at = new AccessToken(KEY, SECRET, { identity: id, name: id }); at.addGrant({ room: ROOM, roomJoin: true, canSubscribe: true, canPublish: true }); return at.toJwt(); };

console.log(`room ${ROOM}: ${STEADY} microphones and ${CAMS} cameras joining…`);
lk(["--audio-publishers", String(STEADY), "--video-publishers", String(CAMS), "--video-resolution", "low", "--num-per-second", "20", "--duration", "40m", "--identity-prefix", "steady"]);
await sleep(Math.max(20, STEADY / 15) * 1000);
let n = 0;
const churn = setInterval(() => lk(["--audio-publishers", String(BATCH), "--num-per-second", "5", "--duration", "20s", "--identity-prefix", `churn${n++}x`]), 4000);
await sleep(15000);
console.log("crowd in, people joining and leaving about", (BATCH / 4).toFixed(1), "a second");

const results = {};
for (const mode of ["all", "selective"]) {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
  const pages = [];
  for (let i = 0; i < PHONES; i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
    await page.goto(`${pathToFileURL(process.cwd() + "/phone.html").href}?mode=${mode}&url=${encodeURIComponent(URL_WS)}&token=${encodeURIComponent(await token(`phone-${mode}-${i}`))}`, { waitUntil: "commit", timeout: 120000 });
    pages.push(page);
  }
  const t0 = Date.now(); let last = [];
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(15000);
    const el = Math.round((Date.now() - t0) / 1000);
    const st = await Promise.all(pages.map((p) => p.evaluate(() => ({ ...window.__s, log: undefined })).catch(() => null)));
    st.forEach((x, i) => x && console.log(mode.padEnd(9), `phone ${i}`, String(el).padStart(4) + "s", "in", x.connected, "join ms", x.joinMs, "others", x.remote, "audio", x.audioSubs, "video", x.videoSubs, "busy ms", Math.round(x.blockedMs - (last[i]?.blockedMs || 0)), "reconnecting", x.reconnecting, "dropped", x.disconnected));
    last = st;
  }
  const final = await Promise.all(pages.map((p) => p.evaluate(() => window.__s).catch(() => null)));
  results[mode] = final.map((x) => x && { joinMs: x.joinMs, inAtEnd: x.connected, reconnecting: x.reconnecting, dropped: x.disconnected, audio: x.audioSubs, video: x.videoSubs, others: x.remote, busyMsPerMin: Math.round((x.blockedMs / SECONDS) * 60), events: x.log.slice(0, 8) });
  await browser.close();
}
clearInterval(churn);
console.log("\n==== RESULTS");
console.log(JSON.stringify({ room: ROOM, steady: STEADY, cams: CAMS, churnPerSecond: BATCH / 4, cpuSlowdown: CPU, seconds: SECONDS, results }, null, 1));
stop(); process.exit(0);
JS

node run.mjs
