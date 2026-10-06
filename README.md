# NeoConference

The next generation of virtual classrooms. HD video meetings with recording, live captions, AI transcription, and shareable event pages — built for educators.

Live at: https://neoconference.vercel.app

## Tech Stack

- Next.js 14 (App Router) + TypeScript + TailwindCSS
- LiveKit Cloud (WebRTC SFU + Egress recording)
- Clerk (authentication)
- Vercel KV (Redis) for chat, events, invites, transcripts, share tokens
- Cloudflare R2 (S3-compatible) for recording storage
- OpenAI Whisper (optional) for AI transcription
- Stripe (optional) for paid event monetization
- Vercel (hosting + Cron)

## Features (shipped)

- HD video and audio meetings powered by LiveKit
- Cloud recording → MP4 stored on Cloudflare R2 with signed download links
- Live captions and post-meeting AI transcripts
- Raise hand, reactions, in-room chat, spotlight overlay
- Shareable event pages with QR codes and short links
- Public sharing pages for transcripts, recordings and event highlights
- Stripe-based paid event tickets and per-owner email digests (cron)
- Collaborative whiteboard with pen, eraser, colors and live multi-user sync
- Live polls with vote tallies (2-6 options, end-poll, real-time updates)
- Admin dashboard, role-based access, mobile-polished room UI

## Roadmap

- Breakout rooms
- Waiting room and host approval flow

## Status

🚧 In active development

## Groups: wiring

Environment variables (Vercel, Production and Preview):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key (`npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | VAPID private key from the same pair |
| `VAPID_SUBJECT` | `mailto:info@neoconference.app` |
| `DISPATCH_SECRET` | long random string; the same value in `scheduler-worker/.env` on the droplet |

Without the three VAPID variables, push is skipped. Without `DISPATCH_SECRET`, `/api/internal/dispatch` refuses every caller, so no reminders or rings go out.

Scheduler on the droplet (one line at a time):

```
cd /opt/neoconference && git pull
cp scheduler-worker/.env.example scheduler-worker/.env
nano scheduler-worker/.env
docker compose -f scheduler-worker/docker-compose.yml up -d --build
docker logs -f neo-scheduler
```

In `nano`, set `DISPATCH_SECRET=`. The container publishes no ports. Details: `scheduler-worker/README.md`.

Post-deploy checks: `npm run test:postdeploy`. The lifecycle test also needs `CLERK_SECRET_KEY`, `DISPATCH_SECRET`, `E2E_OWNER_USER_ID`, `E2E_MEMBER_USER_ID` and `E2E_ABSENT_USER_ID`.
