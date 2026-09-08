# neo-translation-worker

Pulls the programme audio of any NeoConference room from AMS via HLS,
transcribes with Deepgram Live, translates each utterance into every
configured target language via DeepL, and broadcasts the results over
Server-Sent Events. Clients (`/video/dashboard`, `/video/join`)
subscribe and speak the captions with browser TTS.

**One process serves many rooms.** A room's pipeline (ffmpeg →
Deepgram → DeepL → SSE) is spun up lazily the first time any
subscriber asks for `/translations/<room>/<lang>`, and torn down
after `IDLE_GRACE_MS` (default 60s) once the last subscriber leaves.
Rooms nobody is listening to don't burn Deepgram or DeepL credits,
and adding a new room to the app needs no worker-side config — only
that a real programme feed exists at
`AMS_HTTP/streams/<room>-video.m3u8`.

Phase 1: captions + browser TTS.
Phase 2 (next PR): ElevenLabs voices, publish translated audio into the
AMS booth channels so it drops into the language rail natively.

## Requirements

- Deepgram API key (Nova-2 model)
- DeepL API key (Free tier ends in `:fx`)
- A host with `docker` + a public HTTPS endpoint in front of port 8080
  (Caddy, Cloudflare tunnel, or nginx + Let's Encrypt).
- Same droplet the captions worker runs on is fine — no port conflict.

## Deploy

```bash
ssh root@164.92.164.191
git clone https://github.com/codetokoni/neoconference.git
cd neoconference/translation-worker
cp .env.example .env
nano .env      # fill in DEEPGRAM_API_KEY, DEEPL_API_KEY
docker compose up -d --build
docker compose logs -f translator
```

Expected startup log — the supervisor is up, but no room pipeline has
been started yet (that happens on first subscriber):

```
[sse] listening on :8080
[worker] multi-room, langs=fr,es,pt,ar source=en idleGrace=60000ms
```

The first time someone opens `/video/join?room=neoconf` and the
browser subscribes to `/translations/neoconf/fr`, the worker logs:

```
[worker][neoconf] starting pipeline source=https://ingest.streamlab.cloud/LiveApp/streams/neoconf-video.m3u8
[deepgram][neoconf] open
```

60 seconds after the last tab for that room closes:

```
[worker][neoconf] idle, teardown in 60000ms
[worker][neoconf] stopped
```

## Verify

Curl a language stream. The pipeline starts on the first subscriber,
so keep the connection open — you should see the `retry:` header
immediately, then `data:` lines as sentences are translated:

```bash
curl -N http://localhost:8080/translations/neoconf/fr
curl -N http://localhost:8080/translations/hslhs/fr
```

Set the client env var so browsers know where to subscribe:

```
NEXT_PUBLIC_TRANSLATION_SSE=https://<your-tls-host>
```

One env var, one URL, every room.

## Migrating from the single-room version

If you previously had `ROOM=neoconf` in `.env`, it's no longer read
and can be deleted. Nothing else changes — same port, same SSE URL
shape, same client env var. The worker just serves any room the
browser asks for now, instead of only the one it was booted with.
