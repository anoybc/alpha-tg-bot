// ⚡ ALPHA Worker — Railway Express Server v3
// Multi-card rotation: tries cards sequentially, stops on first hit.

import express                                          from 'express';
import { processCheckout }                              from './lib/autofill.js';
import { validateProxy, getNextProxy, runHealthCheck }  from './lib/proxy-manager.js';
import { supabase }                                     from './lib/supabase.js';
import { sendResult, sendAttemptUpdate, sendMessage, maskNumber } from './lib/telegram.js';

const app           = express();
const WORKER_SECRET = process.env.WORKER_SECRET;

// Single-flight guard: only one checkout at a time (prevents Chromium pile-up
// and out-of-memory on small instances).
let _busy = false;

app.use(express.json({ limit: '4mb' }));

// ── Auth ──────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    console.warn('[Auth] Rejected — bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, service: '⚡ ALPHA Worker v5', ts: Date.now() }));

// ── POST /validate-proxy ──────────────────────────────────────────────────────
app.post('/validate-proxy', auth, async (req, res) => {
  const { proxy, telegram_id } = req.body;
  if (!proxy?.host || !proxy?.port) return res.status(400).json({ valid: false, error: 'Missing host/port' });

  console.log(`[ValidateProxy] Testing ${proxy.host}:${proxy.port} for user ${telegram_id}`);
  const result = await validateProxy(proxy);

  if (result.valid) {
    try {
      await supabase.from('proxies').insert({
        telegram_id,
        host           : proxy.host,
        port           : proxy.port,
        username       : proxy.username || null,
        password       : proxy.password || null,
        country        : result.country,
        city           : result.city,
        isp            : result.isp,
        ip             : result.ip,
        valid          : true,
        active         : true,
        fail_count     : 0,
        last_validated : new Date().toISOString(),
      });
    } catch (e) {
      console.error('[ValidateProxy] DB error:', e.message);
    }

    console.log(`[ValidateProxy] ✅ Saved ${proxy.host}:${proxy.port} (${result.country})`);
  } else {
    console.log(`[ValidateProxy] ❌ Dead: ${result.error}`);
  }

  res.json(result);
});

// ── Hard timing wrapper: guarantees an await never hangs forever ──────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

// ── POST /process-checkout ────────────────────────────────────────────────────
// Body: { checkout_url, cards: [...], telegram_id, chat_id }
// "cards" is an ordered array; worker tries each in sequence until a hit.
// Responds 200 immediately so Vercel (10 s limit) doesn't time out.
app.post('/process-checkout', auth, async (req, res) => {
  const { checkout_url, cards, card, telegram_id, chat_id } = req.body;
  console.log('[Worker] /process-checkout received for user', telegram_id);

  // Support legacy single-card calls too
  const cardList = Array.isArray(cards) && cards.length
    ? cards
    : card ? [card] : [];

  if (!checkout_url || !cardList.length) {
    return res.status(400).json({ error: 'Missing checkout_url or cards' });
  }

  // Reject if another checkout is already running
  if (_busy) {
    res.json({ ok: true });
    sendMessage(chat_id, '⏳ Worker is busy with another checkout. Try again in a minute.').catch(() => {});
    return;
  }

  _busy = true;

  // Acknowledge immediately — Railway processes async with no timeout
  res.json({ ok: true });

  // ── Async rotation loop ────────────────────────────────────────────────────
  ;(async () => {
    const total      = cardList.length;
    const proxy      = await getNextProxy(telegram_id);
    const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';

    console.log(`[Worker] ${total} card(s) | proxy: ${proxyLabel} | url: ${checkout_url}`);

    let attemptNum = 0;

    for (const card of cardList) {
      attemptNum++;
      const masked = maskNumber(card.number);
      const isLast = attemptNum === total;

      console.log(`[Worker] Card ${attemptNum}/${total}: ${masked}`);

      // ── Run Playwright checkout ──────────────────────────────────────────
      let result;
      try {
        result = await withTimeout(
          processCheckout({ url: checkout_url, card, proxy }),
          75000,
          'Checkout'
        );
      } catch (err) {
        console.error(`[Worker] processCheckout threw/timed out:`, err.message);
        result = { status: 'error', message: err.message, screenshot: null, url: checkout_url };
      }

      // ── Log every attempt to Supabase ────────────────────────────────────
      try {
        await supabase.from('hits').insert({
          telegram_id,
          checkout_url,
          card_bin  : card.number.slice(0, 6),
          card_last4: card.number.slice(-4),
          status    : result.status,
          response_text: result.message,
          proxy_used: proxyLabel,
        });
      } catch (e) {
        console.warn('[Worker] Hit log error:', e.message);
      }

      // ── HIT → send final result and stop ────────────────────────────────
      if (result.status === 'hit') {
        console.log(`[Worker] ✅ HIT on card ${attemptNum}/${total}`);
        await sendResult(chat_id, result, {
          cardNum  : attemptNum,
          total,
          masked,
          expiry   : card.expiry,
          proxy    : proxy ? proxyLabel : null,
          exhausted: false,
        });
        return;
      }

      // ── DECLINE / ERROR — not last card → notify + continue ─────────────
      if (!isLast) {
        console.log(`[Worker] ${result.status} on card ${attemptNum}/${total} — trying next`);

        await sendAttemptUpdate(chat_id, {
          attemptNum,
          total,
          masked,
          expiry : card.expiry,
          status : result.status,
          message: result.message,
        });

        // Also mark proxy as failed if the error looks proxy-related
        if (proxy && result.status === 'error' && /proxy|connect|ECONNREFUSED|timeout/i.test(result.message)) {
          const newFails = (proxy.fail_count || 0) + 1;
          try {
            await supabase.from('proxies')
              .update({ fail_count: newFails, active: newFails < 3 })
              .eq('id', proxy.id);
          } catch {}
        }

        // Brief pause before next attempt (avoid hammering the checkout server)
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Last card, still not a hit → send final exhausted result ─────────
      console.log(`[Worker] All ${total} card(s) exhausted — final: ${result.status}`);
      await sendResult(chat_id, result, {
        cardNum  : attemptNum,
        total,
        masked,
        expiry   : card.expiry,
        proxy    : proxy ? proxyLabel : null,
        exhausted: total > 1,
      });
    }
  })().catch(async err => {
    console.error('[Worker] Unhandled rotation error:', err);
    try {
      await sendMessage(chat_id, `❌ <b>Worker error:</b> ${err.message || 'Unknown error'}`);
    } catch {}
  }).finally(() => {
    _busy = false;
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ ALPHA Worker v3 on port ${PORT}`);
  runHealthCheck().catch(e => console.error('[HealthCheck]', e.message));
  setInterval(() => runHealthCheck().catch(e => console.error('[HealthCheck]', e.message)), 60 * 60 * 1000);
});
