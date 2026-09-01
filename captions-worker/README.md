# NeoConference captions worker

LiveKit Agent that transcribes room audio via Deepgram and publishes
`TranscriptionSegment`s back into the room. Answers dispatches sent to
the `neo-captions` agent name — the same one the NeoConference Next.js
app's `/api/livekit/captions/dispatch` route already targets. Nothing on
the app side changes.

**Why this exists** — the previous captions worker was deployed on
Railway; a trial expiration wiped the project (and the source with it,
since it was never pushed to GitHub). This is a fresh implementation you
own, in this repo, deployable to any host.

---

## What it does, in one loop

1. Registers with LiveKit as `neo-captions`.
2. When dispatched into a room, joins as an agent-kind participant.
3. Waits for a data-channel message `{ type: "captions", enabled: true }`
   from the host (`CaptionsToggle` on the app side sends this).
4. Opens a Deepgram Live stream per subscribed audio track, feeds PCM
   frames in, publishes transcripts back as LiveKit transcription
   segments. `LiveCaptions` and `LiveTranslation` on the app side already
   consume these.
5. Reacts to tracks arriving/leaving after captions were enabled, and to
   the enable toggle flipping off/on again.
6. Rebroadcasts the current state every 15s so late joiners catch up.

Everything the NeoConference Next.js app expects (agent name, data-
channel protocol, `TranscriptionReceived` shape) is preserved.

---

## Required env

Copy `.env.example` to `.env` and fill:

| Var | What it is |
|---|---|
| `LIVEKIT_URL` | `wss://…` for your LiveKit project (same value as the Next.js app's `NEXT_PUBLIC_LIVEKIT_URL`) |
| `LIVEKIT_API_KEY` | Same key the Next.js app uses |
| `LIVEKIT_API_SECRET` | Same secret |
| `DEEPGRAM_API_KEY` | From <https://console.deepgram.com/> |
| `AGENT_NAME` | Optional. Defaults to `neo-captions` — matches the Next.js dispatch route |
| `DEEPGRAM_MODEL` | Optional. Defaults to `nova-2` |
| `DEEPGRAM_LANGUAGE` | Optional. `multi` auto-detects; set `en` / `es` / … for a single-language room |

---

## Deploy option A — Docker Compose (recommended)

Works on any Linux host with Docker. Steps assume you're on the target
droplet as root.

```bash
# 1. Get the code onto the box
git clone https://github.com/codetokoni/neoconference.git /opt/neoconference
cd /opt/neoconference/captions-worker

# 2. Config
cp .env.example .env
nano .env    # fill LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, DEEPGRAM_API_KEY

# 3. Build + run
docker compose up -d --build

# 4. Watch logs
docker compose logs -f
```

Expect to see:

```
[neo-captions] registered as agent 'neo-captions'
```

Then in the LiveKit dashboard's **Agents** page, `neo-captions` should
show `Workers: 1` and status `READY` within a few seconds. Toggle CC on
in a room and captions should flow.

Restarts survive reboots because of `restart: unless-stopped`.

---

## Deploy option B — systemd (no Docker)

For a plain Ubuntu box without Docker:

```bash
# 1. Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential python3

# 2. Get the code
git clone https://github.com/codetokoni/neoconference.git /opt/neoconference
cp -r /opt/neoconference/captions-worker /opt/neoconference-captions-worker
cd /opt/neoconference-captions-worker

# 3. Install + build
npm ci
npm run build

# 4. Config
cp .env.example .env
nano .env

# 5. Install the unit
cp deploy/systemd/neo-captions.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now neo-captions
systemctl status neo-captions
journalctl -u neo-captions -f
```

---

## Deploy option C — Railway (once you're back on it)

Railway auto-detects Node + Dockerfile. Point it at the
`captions-worker` subdirectory of this repo:

1. New Service → Deploy from GitHub Repo → pick `codetokoni/neoconference`.
2. Service settings → **Root Directory**: `captions-worker`.
3. Variables → paste in the four required env vars.
4. Deploy.

---

## Retiring the mystery worker

Once this worker shows up in the LiveKit dashboard as **READY**:

1. Go to LiveKit → Agents → the `neo-captions` card.
2. On the agent detail page, check the **Workers** table. There should
   be **two** workers listed briefly — the mystery one, and yours.
   Yours is the one that started most recently.
3. In whatever hosting platform the mystery worker actually runs on
   (still TBD — see the debugging thread), stop or delete it.
4. The Workers table will drop back to 1, and future dispatches only hit
   your new worker.

**Do not delete the agent registration itself** — that's what the app's
dispatch route talks to. Delete only the underlying worker process.

---

## Troubleshooting

**Agent doesn't show up in the LiveKit dashboard**
- `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` wrong. `docker compose logs`
  shows the exact registration error.
- Firewall blocking outbound wss. Test with
  `curl -v https://<your-livekit-host>`.

**Agent registered but CC pill stays cyan "NO CAPTIONS"**
- No transcripts arriving. Almost certainly Deepgram-side:
  - `DEEPGRAM_API_KEY` invalid → `journalctl -u neo-captions` will show
    a 401 from Deepgram.
  - Deepgram pay-as-you-go balance at $0 → 402. Add credit at
    <https://console.deepgram.com/>.

**Agent joins but Resource Load stays 0%**
- Enable message never arrived. Confirm the host clicked CC ON and the
  data broadcast reached the worker (`[neo-captions] enabled=true` in
  logs). If the worker never logs that, look at the client — the
  `CaptionsToggle` broadcast may be silently failing.

**Two workers competing for jobs**
- The old worker is still running somewhere. See "Retiring the mystery
  worker" above.

---

## Local dev

```bash
npm install
cp .env.example .env
npm run dev   # watches src/agent.ts, reconnects on save
```

Test dispatch from the LiveKit Cloud console: **Agents → neo-captions →
Test in Console**.
