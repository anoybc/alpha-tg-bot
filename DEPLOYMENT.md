# ⚡ ALPHA TG Bot — Full Deployment Guide

Step-by-step instructions to go from this folder to a working Telegram bot.

---

## 🗺️ The 4 Services at a Glance

| # | Service | Role | What you'll need from it |
|---|---------|------|--------------------------|
| 1 | **Supabase** | Database (cards, proxies, hits, sessions) | Project URL + service_role key |
| 2 | **Telegram** | Bot front-end | Bot token (from @BotFather) |
| 3 | **Railway** | Playwright worker (opens & fills checkouts) | Public URL after deploy |
| 4 | **Vercel** | Webhook (receives TG messages, routes jobs) | Public URL after deploy |

**Data flow:** Telegram → Vercel → Railway → Telegram (with Supabase on the side).

---

## ✅ Prerequisites

- [ ] GitHub account (free)
- [ ] Vercel account (free)
- [ ] Railway account (free)
- [ ] Supabase account (free)
- [ ] Telegram account

---

## STEP 1 — Supabase (Database)

1. Go to https://supabase.com → **New project**.
2. Pick any name, set a secure database password, choose a region close to you.
3. Wait ~2 min for the project to initialize.
4. In the left sidebar → **SQL Editor** → **New query**.
5. Copy the **entire** contents of `supabase/schema.sql` and paste it into the editor.
6. Click **Run** (or `Cmd/Ctrl + Enter`).
   - You should see "Success. No rows returned" (or similar) with no red errors.
7. In the left sidebar → **Project Settings** (gear icon) → **API**.
8. Copy these two values somewhere safe — you'll paste them later:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **service_role** key (long string starting with `eyJ...`, under "Project API keys")

> ⚠️ The **service_role** key bypasses all row-level security. Never commit it to a public repo. It only lives in env vars.

---

## STEP 2 — Create the Telegram Bot

1. Open Telegram, search for **@BotFather** (verified account).
2. Send `/newbot`.
3. Choose a name (e.g. `Alpha Checkout Bot`).
4. Choose a username — must end in `bot` (e.g. `alpha_checkout_bot`).
5. BotFather replies with a **token** that looks like `1234567890:AAH...`.
6. Copy this token — you'll paste it later.

> Keep the token secret. Anyone with it controls your bot.

---

## STEP 3 — GitHub (Store the Code)

You have two deployable folders. You can use **one repo** or **two**.

### Option A — One repo (recommended, simpler)

1. Create a new private repo, e.g. `alpha-tg-bot`.
2. Push the whole `alpha-tg-bot/` folder:

```bash
cd alpha-tg-bot
git init
git add .
git commit -m "ALPHA TG bot"
git remote add origin https://github.com/YOUR_USERNAME/alpha-tg-bot.git
git push -u origin main
```

3. Railway deploys from the `railway-worker/` subfolder.
4. Vercel deploys from the `vercel-webhook/` subfolder.

### Option B — Two repos

- Repo 1: `alpha-worker`  ← contents of `railway-worker/`
- Repo 2: `alpha-webhook` ← contents of `vercel-webhook/`

> **Private repo is strongly recommended** — the code contains your bot logic.

---

## STEP 4 — Deploy the Railway Worker

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Select your repo. If using one repo, set **Root Directory** to `railway-worker`.
   - Railway detects the `Dockerfile` automatically.
   - It uses the official Playwright image (~1.5 GB) — first build takes 5–10 min. Be patient.
3. When the build finishes, it tries to start but will show errors (missing env vars). That's expected — proceed to set variables.
4. In the service → **Variables** tab, add these:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Paste your bot token from Step 2 |
| `SUPABASE_URL` | Paste Project URL from Step 1 |
| `SUPABASE_SERVICE_KEY` | Paste service_role key from Step 1 |
| `WORKER_SECRET` | Generate one — run `openssl rand -hex 32` locally, or just type a long random string |

5. Railway automatically adds `PORT=3000` — do **not** change it.
6. Wait for the rebuild. You should see logs like:
   ```
   ⚡ ALPHA Worker v3 on port 3000
   [ProxyManager] Running health check…
   ```
7. Go to the service → **Settings** → **Generate Domain** (it's enabled by default).
8. Copy your public URL — looks like `https://alpha-worker-production.up.railway.app`.
   - **Save this** — you'll need it for Vercel in Step 5.

### Verify the worker is alive

Open in your browser:
```
https://YOUR-WORKER.up.railway.app/
```
You should see JSON: `{"ok":true,"service":"⚡ ALPHA Worker v3","ts":...}`

---

## STEP 5 — Deploy the Vercel Webhook

1. Go to https://vercel.com → **Add New → Project**.
2. Import the repo. If using one repo, set **Root Directory** to `vercel-webhook`.
   - Framework: **Other**
   - Build command: leave empty
   - Output directory: leave empty
3. Add **Environment Variables**:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Same bot token (Step 2) |
| `SUPABASE_URL` | Same as Railway (Step 1) |
| `SUPABASE_SERVICE_KEY` | Same as Railway (Step 1) |
| `WORKER_SECRET` | **The exact same string** you set on Railway (Step 4) |
| `RAILWAY_WORKER_URL` | Your Railway URL from Step 4 (no trailing slash) |

4. Click **Deploy**.
5. When done, copy your Vercel URL — `https://your-app.vercel.app`.

### Verify the webhook is alive

Open in your browser:
```
https://your-app.vercel.app/webhook
```
You should see `{"ok":true}` (a GET returns a health response).

---

## STEP 6 — Connect Telegram → Vercel

Run this ONE command (replace with your real values):

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-app.vercel.app/webhook"
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

---

## STEP 7 — Test Everything

1. Open your bot on Telegram → send **`/start`**.
   - You should see the welcome message.
2. Send **`/help`** — command list appears.
3. Set up a card:
   ```
   /card add 4111111111111111|12|26|123 Test Visa
   ```
   - Bot replies "✅ Card saved! ⭐ Auto-set as default".
4. Add a proxy (optional):
   ```
   /proxy add 1.2.3.4:8080:user:pass
   ```
   - Bot replies "🔄 Validating proxy..." then ✅ (if alive) or ❌ (if dead).
5. Build a rotation queue (optional):
   ```
   /queue set <ID-from-card-list>
   ```
6. Paste a **checkout URL**.
   - If you saved a default card → bot asks "Reply YES to use it".
   - Reply **YES**.
   - Bot says "⚡ Processing..." then returns a result within 15–30 s.
7. Check stats and history:
   ```
   /stats
   /history
   ```

---

## 🧪 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Bot doesn't reply at all | Webhook not set | Re-run Step 6 curl; check `getWebhookInfo` |
| `{"ok":true}` but no message | Wrong route | Confirm `vercel.json` has `/webhook` → `/api/webhook.js` |
| "Worker unreachable" | Railway URL wrong / worker crashed | Re-open Railway URL in browser; check `WORKER_SECRET` matches on both |
| "❌ Worker error" in chat | Playwright failed | Check Railway logs for the actual error |
| Build fails on Railway | Big image pull | Retry; first Playwright build is slow (5–10 min) |
| 401 Unauthorized from worker | `WORKER_SECRET` mismatch | Ensure **identical** value on Vercel + Railway |
| Supabase errors | Wrong key | Use **service_role** key, not anon key |
| Proxy always "dead" | Proxy is SOCKS-only | This build supports HTTP/HTTPS proxies; SOCKS not yet |

### Useful Telegram API checks

```bash
# Inspect webhook config
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"

# Force-delete webhook (if you need to retry)
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# Re-set it
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/webhook"
```

---

## 🔄 Updating After Code Changes

1. Push to GitHub (`git push`).
2. **Railway**: auto-redeploys on push (or click "Deploy").
3. **Vercel**: auto-redeploys on push.
4. If you changed `schema.sql`, re-run the new statements in Supabase SQL Editor.

---

## 🔐 Security Checklist

- [ ] Both repos are **private**
- [ ] `WORKER_SECRET` is a long random string, not guessable
- [ ] You used the **service_role** key only in env vars, never in code
- [ ] Bot token is not committed anywhere
- [ ] `cards` table stores full card numbers — ensure RLS is enabled (it is, via `schema.sql`)

---

## 📁 File Map

```
alpha-tg-bot/
├── supabase/schema.sql              → Step 1 (run in SQL Editor)
├── railway-worker/                  → Step 4 (Railway)
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js                    → orchestrator (multi-card rotation)
│   └── lib/
│       ├── autofill.js              → Playwright checkout filler
│       ├── checkout-detector.js
│       ├── proxy-manager.js         → validate/rotate/health-check
│       ├── supabase.js
│       └── telegram.js              → sends results + progress
├── vercel-webhook/                  → Step 5 (Vercel)
│   ├── vercel.json
│   ├── package.json
│   ├── api/webhook.js               → all bot commands + state machine
│   └── lib/
│       ├── cards.js                 → card storage + queue helpers
│       ├── supabase.js
│       └── telegram.js
├── .env.example                     → reference for env vars
├── README.md
└── DEPLOYMENT.md                    → this file
```
