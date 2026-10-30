# Hosting: always-on computer + Vercel for prompts

The whole system runs on one computer that never turns off: collecting, the queues, sending, tracking and the database (`.data/dev.db`). Vercel only serves the **Prompts page** and the **prompt API**, and forwards those calls to that computer.

```
browser / agent ──► geonode-prompts.vercel.app ──► tunnel (ngrok) ──► always-on computer :3000
                    (vercel/prompts: page + /api/prompts…, /api/keys…)     (npm run dev: everything)
```

**Guarantees:**
- **Vercel only lets prompt routes through.** Queues, sending and logs are never reachable through it.
- **Every call needs an API key.** The server checks it on every call. Requests that arrive through a tunnel or Vercel count as remote, even though they connect from the computer itself.
- **The dashboard stays private.** It (`/`) only opens on the computer itself.

## 1. On the always-on computer

```bash
git clone https://github.com/MattByy/reddit-review-private.git && cd reddit-review-private
cp .env.example .env.local      # ENGAIN_API_KEY, OPENROUTER_API_KEY, FEATHERLESS_API_KEY
npm run dev                      # http://127.0.0.1:3000, scheduled jobs on
```

**Copy `.data/dev.db` from the old computer before the first start** (with the server stopped on both). It holds the prompts (comments and replies are written by MiniMax-M3 on Featherless), the send history, and which threads we already posted in. Without it the server starts empty, with the built-in OpenRouter prompts, and it could post twice in a thread.

Keep it running. On macOS, a `launchd` agent or simply `caffeinate -s npm run dev` in a terminal that stays open works. The server keeps listening only on 127.0.0.1, and the tunnel connects to that.

**Auto-send** is off until you turn it on. On the dashboard, under settings, set **Auto-send per day** (for example 35). The server then sends that many a day by itself, spread over 9:00–17:00 Warsaw time. Each run sends one ready Queue 2 draft, or drafts the next Queue 1 item and sends it. No browser tab needs to stay open. Set it back to 0 to stop.

**Supabase mirror (optional).** To follow everything on a hosted page:
1. Run `supabase/schema.sql` once in the Supabase SQL editor.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the service role key) to `.env.local` and restart.

Every minute the server then copies Queue 1, Queue 2, new activity-log events and a status row (jobs, settings, counts) to Supabase. It only writes; nothing is read back, and the computer keeps working if Supabase is down. `GET /api/mirror` shows the last sync, and `POST /api/cron/mirror` syncs now. The tables have row level security with no policies, so only the service key can read them.

**Hosted monitor.** https://geonode-prompts.vercel.app shows Queue 1, Queue 2 (with the drafts), what was sent and its Engain status, the jobs and the activity log, read from the Supabase mirror. It refreshes every 30 seconds and warns when the computer has not synced for 3 minutes. Sign in with your username and password (`node scripts/monitor-user.cjs <username>` creates or resets one; it stores a scrypt hash in Supabase and signs that user out everywhere). Five wrong passwords from one connection lock it for 24 hours, and 20 from anywhere within an hour close the sign-in for an hour. Agents can instead send an **Everything** API key as a bearer token to `/api/monitor`; the mirror copies key hashes, so revoking a key works there too.

**Controls on the hosted page.** Turn the writer and auto-send on or off and change their numbers, press *Write one now*, *Send one now* or *Collect threads now*, or start **fast mode** (15 min: the writer runs every minute and the page updates every 10 s; sending is never faster than auto-send allows). Each click becomes a row in the Supabase `commands` table; the computer checks it every 10 seconds, applies it, logs it in the activity log and writes back the result. A command the computer has not picked up within 15 minutes expires instead of running later. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` on the Vercel project (set), not the tunnel.

## 2. Give it a public address (tunnel)

ngrok is installed on the dev Mac. A free account includes one fixed domain:

```bash
ngrok config add-authtoken <token from dashboard.ngrok.com>
ngrok http 3000 --url=<your-name>.ngrok-free.app
```

**Alternatives:**
- **Tailscale Funnel:** `tailscale funnel 3000` gives a fixed `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:3000` (a fixed address needs a named tunnel).

## 3. Point Vercel at it

The Vercel project **geonode-prompts** deploys `vercel/prompts` from `main`. Set its address once:

```bash
vercel env add PROMPTS_SERVER_URL production   # paste https://<your-name>.ngrok-free.app
vercel deploy --prod                            # or push to main
```

Until it is set, the page says "Not connected yet".

## 4. Keys

1. **Create your own key.** On the computer itself, open http://127.0.0.1:3000/prompts. Under **API keys**, create a key for yourself with **Everything** scope, so you can also manage keys from Vercel.
2. **Sign in on Vercel.** Open the Vercel URL and paste that key into **Sign in**. It is kept in that browser only.
3. **Agents:** create **Prompts only** keys for them. The guide is at `<vercel url>/docs/prompts-api`.
