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

Keep it running. On macOS, a `launchd` agent or simply `caffeinate -s npm run dev` in a terminal that stays open works. The server keeps listening only on 127.0.0.1, and the tunnel connects to that.

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
