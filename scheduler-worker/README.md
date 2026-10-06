# scheduler-worker

Every 30 seconds it calls `POST /api/internal/dispatch` on the site, which sends the group-meeting reminders and rings that are due. It has no dependencies and no open ports.

## On the droplet

Run each line on its own. Multi-line pastes and heredocs over a PowerShell SSH session drop lines, so every step here is a single line.

1. Get the code:

   ```
   cd /opt/neoconference && git pull
   ```

2. Create `scheduler-worker/.env`. Type the secret yourself on the droplet; never paste it into a chat. It must be the same value as `DISPATCH_SECRET` in Vercel.

   ```
   cp scheduler-worker/.env.example scheduler-worker/.env
   ```

   ```
   nano scheduler-worker/.env
   ```

   Set `DISPATCH_SECRET=` to the secret, then save with Ctrl+O, Enter and Ctrl+X.

3. Start it:

   ```
   docker compose -f scheduler-worker/docker-compose.yml up -d --build
   ```

4. Check that it ticks. Expect one line about every 30 seconds, like `ok 180ms {"ran":0,"skipped":0,"errors":0}`:

   ```
   docker logs -f neo-scheduler
   ```

   - `HTTP 401` means the secret doesn't match Vercel's `DISPATCH_SECRET`.
   - `failed: ...` means the droplet can't reach the site.

## Update

```
cd /opt/neoconference && git pull && docker compose -f scheduler-worker/docker-compose.yml up -d --build
```

## Stop

```
docker compose -f scheduler-worker/docker-compose.yml down
```
