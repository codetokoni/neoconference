# neo-translation-worker

Pulls the programme audio of one NeoConference room from AMS via HLS,
transcribes with Deepgram Live, translates each utterance into every
configured target language via DeepL, and broadcasts the results over
Server-Sent Events. Clients (`/video/dashboard`, `/video/join`)
subscribe and speak the captions with browser TTS.

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
nano .env      # fill in DEEPGRAM_API_KEY, DEEPL_API_KEY, adjust ROOM
docker compose up -d --build
docker compose logs -f translator
```

Expected startup log:

```
[worker] room=neoconf langs=fr,es,pt,ar source=en
[worker] source=https://ingest.streamlab.cloud/LiveApp/streams/neoconf-video.m3u8
[sse] listening on :8080
[deepgram] open
```

## Verify

Curl a language stream — you should see server-sent events as sentences
land:

```bash
curl -N http://localhost:8080/translations/neoconf/fr
```

Set the client env var so browsers know where to subscribe:

```
NEXT_PUBLIC_TRANSLATION_SSE=https://<your-tls-host>
```

## Second room

Run a second container with `ROOM=hslhs` (and a different host port, or
a second droplet). Each worker covers one room's programme audio.
