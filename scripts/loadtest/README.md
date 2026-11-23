# Big-meeting load test

Checks whether a phone stays in a churning meeting of about 270 people. It runs
twice: once receiving every stream, which is what the site did before
big-meeting receiving, and once with big-meeting receiving
(`src/lib/bigMeeting.ts`, `src/components/conference/bigMeetingSubscriptions.ts`).
In the second run the phone receives only unmuted microphones and the cameras
on screen.

The crowd comes from `lk load-test`. The "phones" are headless Chromium pages at
phone size, with the CPU slowed 4×. Each phone runs `phone.ts`, which uses the
site's own `startReceiving`, so the test measures the real code.

## Files

- `big-meeting-loadtest.sh`: installs the LiveKit CLI, Node and Playwright,
  then runs the test and prints `==== RESULTS`.
- `phone.ts`: the phone page's code.
- `big-meeting-phone.js`: `phone.ts` bundled with livekit-client. It is built,
  not committed.

## Running it

1. Build the phone bundle in the repo:

   ```
   npm run loadtest:build
   ```

2. Create a throwaway Ubuntu 24.04 droplet on DigitalOcean (CPU-Optimized,
   32 vCPU, about $1.30 an hour). Copy `scripts/loadtest/` to it.
   A laptop is not enough: the crowd needs about 20 cores.
3. On the droplet, as root, set the LiveKit project's details and run:

   ```
   export LIVEKIT_URL=wss://<project>.livekit.cloud
   export LIVEKIT_API_KEY=<key>
   export LIVEKIT_API_SECRET=<secret>
   bash big-meeting-loadtest.sh
   ```

   It joins a room called `loadtest-<time>` and takes about 15 minutes. The
   simulated people count against the project's 1,000 places, so run it when
   no big meeting is on.
4. Keep everything after `==== RESULTS`, then delete the droplet.

Optional settings: `STEADY=200 CAMS=20 BATCH=10 PHONES=3 SECONDS=180 CPU=4`.
For each mode the results show the phones' join time, whether they were still
in the meeting at the end, reconnects and drops, the tracks received, and how
long the page was busy per minute.
