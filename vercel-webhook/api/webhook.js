// ⚡ ALPHA TG Bot — Vercel Webhook Handler v3
// New in v3: /queue command, multi-card rotation, waiting_confirm_queue state

import { supabase }                from '../lib/supabase.js';
import { sendMessage, sendTyping } from '../lib/telegram.js';
import {
  getDefaultCard, getCardById, getUserCards,
  saveCard, setDefaultCard, deleteCard,
  formatCard, maskNumber,
  getQueueRow, getQueueCards, setQueue,
  appendToQueue, removeFromQueue, clearQueue,
  resolveCardId,
} from '../lib/cards.js';

const WORKER_URL    = process.env.RAILWAY_WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseCard(text) {
  const t    = text.trim().replace(/\s+/g, ' ');
  const norm = t
    .replace(/^(\d{13,19})\s+(\d{1,2})[\/\s](\d{2,4})\s+(\d{3,4})$/, '$1|$2|$3|$4')
    .replace(/\s/g, '');

  const patterns = [
    /^(\d{13,19})\|(\d{1,2})\/(\d{2,4})\|(\d{3,4})$/,
    /^(\d{13,19})\|(\d{1,2})\|(\d{2,4})\|(\d{3,4})$/,
    /^(\d{13,19})\/(\d{1,2})\/(\d{2,4})\/(\d{3,4})$/,
  ];
  for (const re of patterns) {
    const m = norm.match(re);
    if (m) {
      const month = m[2].padStart(2, '0');
      const year  = m[3].length === 2 ? '20' + m[3] : m[3];
      return { number: m[1], month, year, cvc: m[4], expiry: `${month}/${year.slice(-2)}` };
    }
  }
  return null;
}

function parseProxy(text) {
  const p = text.trim().split(':');
  if (p.length === 4) return { host: p[0], port: +p[1], username: p[2], password: p[3] };
  if (p.length === 2) return { host: p[0], port: +p[1], username: null, password: null };
  return null;
}

function isCheckoutUrl(text) {
  try {
    const url = new URL(text.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return [/checkout/i, /\/pay\b/i, /\/order/i, /\/cart/i,
            /stripe\.com/i, /shopify/i, /squareup/i, /paypal/i,
            /\/payment/i, /\/buy/i].some(p => p.test(url.href));
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getSession(id) {
  const { data } = await supabase
    .from('sessions').select('*').eq('telegram_id', id).single();
  return data || { telegram_id: id, state: 'idle', checkout_url: null, pending_card_id: null };
}

async function setSession(id, state, checkoutUrl = null, pendingCardId = null) {
  await supabase.from('sessions').upsert({
    telegram_id     : id,
    state,
    checkout_url    : checkoutUrl,
    pending_card_id : pendingCardId,
    updated_at      : new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker call
// ─────────────────────────────────────────────────────────────────────────────

async function callWorker(path, body) {
  return fetch(`${WORKER_URL}${path}`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
    body   : JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Kick off a checkout — resets session, sends "processing" msg, fires worker
// cards = array (multi-rotation) or single card object (legacy)
// ─────────────────────────────────────────────────────────────────────────────

async function startCheckout({ chatId, userId, checkoutUrl, cards }) {
  const cardList = Array.isArray(cards) ? cards : [cards];
  const total    = cardList.length;

  await setSession(userId, 'idle');
  await sendTyping(chatId);

  const preview = cardList.map((c, i) =>
    `${i + 1}. 💳 <code>${maskNumber(c.number)}</code>  📅 ${c.expiry}`
  ).join('\n');

  await sendMessage(chatId,
    `⚡ <b>Processing${total > 1 ? ` (${total} cards in rotation)` : ''}...</b>\n\n` +
    `🔗 <code>${checkoutUrl.slice(0, 55)}${checkoutUrl.length > 55 ? '…' : ''}</code>\n\n` +
    `${preview}\n\n` +
    `⏳ Results incoming...`
  );

  callWorker('/process-checkout', {
    checkout_url : checkoutUrl,
    cards        : cardList,
    telegram_id  : userId,
    chat_id      : chatId,
  }).catch(async () => {
    await sendMessage(chatId, '❌ Worker unreachable. Please try again in a moment.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine best card source for a URL and return next state + message
// Priority: queue (≥1 card) → default card → ask for card
// ─────────────────────────────────────────────────────────────────────────────

async function buildCheckoutPrompt(userId, checkoutUrl) {
  const queueCards = await getQueueCards(userId);

  if (queueCards.length >= 1) {
    const list = queueCards.map((c, i) =>
      `${i + 1}. ${formatCard(c, { showDefault: false, index: null })}`.replace(/\n  /g, '  ')
    ).join('\n\n');

    return {
      state       : 'waiting_confirm_queue',
      pendingCardId: null,
      message     :
        `🔗 <b>Checkout detected!</b>\n\n` +
        `<code>${checkoutUrl}</code>\n\n` +
        `🔄 <b>Rotation queue (${queueCards.length} card${queueCards.length > 1 ? 's' : ''}):</b>\n\n` +
        `${list}\n\n` +
        `Reply <b>YES</b> to run all in sequence, or paste a single card to override.\n` +
        `Type /cancel to abort.`,
    };
  }

  const defaultCard = await getDefaultCard(userId);

  if (defaultCard) {
    return {
      state        : 'waiting_confirm',
      pendingCardId: defaultCard.id,
      message      :
        `🔗 <b>Checkout detected!</b>\n\n` +
        `<code>${checkoutUrl}</code>\n\n` +
        `⭐ <b>Default card:</b>\n${formatCard(defaultCard, { showDefault: false })}\n\n` +
        `Reply <b>YES</b> to use it, or paste a different card.\n` +
        `💡 Set a rotation queue with /queue to try multiple cards.\n\n` +
        `Type /cancel to abort.`,
    };
  }

  return {
    state        : 'waiting_card',
    pendingCardId: null,
    message      :
      `🔗 <b>Checkout detected!</b>\n\n` +
      `<code>${checkoutUrl}</code>\n\n` +
      `💳 Send your card:\n<code>NUMBER|MM|YY|CVC</code>\n\n` +
      `💡 Save cards with /card add, build a queue with /queue set.\n\n` +
      `Type /cancel to abort.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Help strings
// ─────────────────────────────────────────────────────────────────────────────

const CARD_HELP =
  `<b>💳 /card commands:</b>\n\n` +
  `/card add <code>NUMBER|MM|YY|CVC</code> [label]\n` +
  `/card list\n` +
  `/card default <code>ID</code>\n` +
  `/card del <code>ID</code>\n` +
  `/card clear\n\n` +
  `<i>ID = first 8 chars shown in /card list</i>`;

const QUEUE_HELP =
  `<b>🔄 /queue commands:</b>\n\n` +
  `/queue set <code>ID1 ID2 ID3 …</code>\n` +
  `  → Define rotation order. IDs from /card list.\n\n` +
  `/queue add <code>ID</code>\n` +
  `  → Append a card to the end of the queue.\n\n` +
  `/queue remove <code>ID</code>\n` +
  `  → Remove one card from the queue.\n\n` +
  `/queue list\n` +
  `  → Show current queue in order.\n\n` +
  `/queue clear\n` +
  `  → Delete the queue (falls back to default card).\n\n` +
  `<i>When a queue is active, every checkout URL you paste\n` +
  `tries cards 1→2→3→… stopping on the first hit.</i>`;

const CARD_FORMAT_HINT =
  `Format: <code>NUMBER|MM|YY|CVC</code>\n\nExamples:\n` +
  `<code>4111111111111111|12|25|123</code>\n` +
  `<code>4111111111111111|12/25|123</code>`;

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.json({ ok: true });
  const { message } = req.body;
  if (!message?.text) return res.json({ ok: true });

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text   = message.text.trim();

  // ── /start  /help ──────────────────────────────────────────────────────────
  if (/^\/(start|help)/.test(text)) {
    await sendMessage(chatId,
      `⚡ <b>ALPHA Bot</b> — Checkout Engine\n\n` +
      `<b>Paste a checkout URL</b> to start.\n\n` +
      `<b>Card management:</b>\n/card — save, list, set default, delete\n\n` +
      `<b>Multi-card rotation:</b>\n/queue — set an ordered list of cards to try\n` +
      `   until a hit (1→2→3→… stops on first hit)\n\n` +
      `<b>Proxies:</b>\n/proxy add <code>HOST:PORT:USER:PASS</code>\n` +
      `/proxy list  |  /proxy del <code>ID</code>\n\n` +
      `/cancel — reset session\n/stats — hit/decline counts\n/history — last 10 hits`
    );
    return res.json({ ok: true });
  }

  // ── /cancel ────────────────────────────────────────────────────────────────
  if (/^\/cancel/.test(text)) {
    await setSession(userId, 'idle');
    await sendMessage(chatId, '🔄 Session reset. Paste a checkout URL to start.');
    return res.json({ ok: true });
  }

  // ── /stats ─────────────────────────────────────────────────────────────────
  if (/^\/stats/.test(text)) {
    const { data } = await supabase.from('hits').select('status').eq('telegram_id', userId);
    if (!data?.length) {
      await sendMessage(chatId, '📊 No hits yet.');
      return res.json({ ok: true });
    }
    const hits     = data.filter(h => h.status === 'hit').length;
    const declines = data.filter(h => h.status === 'decline').length;
    const errors   = data.filter(h => h.status === 'error').length;
    await sendMessage(chatId,
      `📊 <b>Stats</b>\n\n✅ Hits: <b>${hits}</b>\n❌ Declines: <b>${declines}</b>\n` +
      `⚠️  Errors: <b>${errors}</b>\n────\n📦 Total: <b>${data.length}</b>`
    );
    return res.json({ ok: true });
  }

  // ── /history ──────────────────────────────────────────────────────────────
  if (/^\/history/.test(text)) {
    const { data } = await supabase
      .from('hits')
      .select('checkout_url, card_bin, card_last4, status, response_text, proxy_used, created_at')
      .eq('telegram_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!data?.length) {
      await sendMessage(chatId, '📜 No history yet. Paste a checkout URL to get started!');
      return res.json({ ok: true });
    }

    const STATUS_EMOJI = { hit: '✅', decline: '❌', error: '⚠️', unknown: '❓' };
    const STATUS_LABEL = { hit: 'HIT', decline: 'DECLINED', error: 'ERROR', unknown: 'UNKNOWN' };

    const entries = data.map((h, i) => {
      const emoji = STATUS_EMOJI[h.status] || '❓';
      const label = STATUS_LABEL[h.status] || 'UNKNOWN';
      const url   = h.checkout_url || '—';
      const urlShort = url.length > 42 ? url.slice(0, 42) + '…' : url;
      const card  = (h.card_bin && h.card_last4)
        ? `<code>${h.card_bin}</code>xxxx<code>${h.card_last4}</code>`
        : '—';
      const proxy = h.proxy_used && h.proxy_used !== 'direct' ? h.proxy_used : 'direct';
      const when  = h.created_at
        ? new Date(h.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '—';

      return (
        `${i + 1}. ${emoji} <b>${label}</b>
` +
        `   🔗 <code>${urlShort}</code>
` +
        `   💳 ${card}  🌐 ${proxy}  🕐 ${when}`
      );
    }).join('\n\n');

    await sendMessage(chatId, `<b>📜 Last ${data.length} Hits</b>\n\n${entries}`);
    return res.json({ ok: true });
  }

  // ── /queue ─────────────────────────────────────────────────────────────────
  if (/^\/queue/.test(text)) {
    const parts  = text.split(/\s+/);
    const subCmd = parts[1]?.toLowerCase();

    if (!subCmd) { await sendMessage(chatId, QUEUE_HELP); return res.json({ ok: true }); }

    // /queue set ID1 ID2 ID3 ...
    if (subCmd === 'set') {
      const rawIds = parts.slice(2);
      if (!rawIds.length) {
        await sendMessage(chatId,
          `❌ Provide at least one card ID.\n\nUse /card list to see IDs, then:\n` +
          `<code>/queue set ID1 ID2 ID3</code>`
        );
        return res.json({ ok: true });
      }

      // Resolve partial IDs → full UUIDs
      const resolved = [];
      const notFound = [];
      for (const partial of rawIds) {
        const fullId = await resolveCardId(userId, partial);
        if (fullId) resolved.push(fullId);
        else        notFound.push(partial);
      }

      if (!resolved.length) {
        await sendMessage(chatId, `❌ No matching cards found. Use /card list to see your IDs.`);
        return res.json({ ok: true });
      }

      await setQueue(userId, resolved);
      const qCards = await getQueueCards(userId);

      const preview = qCards.map((c, i) =>
        `${i + 1}. ${c.label ? `<b>${c.label}</b>` : 'Card'} — ` +
        `<code>${maskNumber(c.number)}</code>  📅 ${c.expiry}`
      ).join('\n');

      let msg = `✅ <b>Queue set (${resolved.length} card${resolved.length > 1 ? 's' : ''}):</b>\n\n${preview}`;
      if (notFound.length) msg += `\n\n⚠️ Not found: ${notFound.map(x => `<code>${x}</code>`).join(', ')}`;
      await sendMessage(chatId, msg);
      return res.json({ ok: true });
    }

    // /queue add ID
    if (subCmd === 'add') {
      const partial = parts[2];
      if (!partial) {
        await sendMessage(chatId, `❌ Provide a card ID.\n\nUse: <code>/queue add ID</code>`);
        return res.json({ ok: true });
      }
      const fullId = await resolveCardId(userId, partial);
      if (!fullId) {
        await sendMessage(chatId, `❌ Card not found. Use /card list to see IDs.`);
        return res.json({ ok: true });
      }
      await appendToQueue(userId, fullId);
      const qCards = await getQueueCards(userId);
      const added  = qCards.find(c => c.id === fullId);
      await sendMessage(chatId,
        `✅ Card added to queue (position ${qCards.length}):\n\n` +
        `${formatCard(added, { showDefault: false })}\n\n` +
        `Queue is now ${qCards.length} card${qCards.length > 1 ? 's' : ''}. Use /queue list to see it.`
      );
      return res.json({ ok: true });
    }

    // /queue remove ID
    if (subCmd === 'remove') {
      const partial = parts[2];
      if (!partial) {
        await sendMessage(chatId, `❌ Provide a card ID.\n\nUse: <code>/queue remove ID</code>`);
        return res.json({ ok: true });
      }
      const fullId = await resolveCardId(userId, partial);
      if (!fullId) {
        await sendMessage(chatId, `❌ Card not found.`);
        return res.json({ ok: true });
      }
      await removeFromQueue(userId, fullId);
      const remaining = await getQueueCards(userId);
      await sendMessage(chatId,
        `✅ Card removed from queue.\n\n` +
        `Queue now has ${remaining.length} card${remaining.length !== 1 ? 's' : ''}.` +
        (remaining.length === 0 ? '\n\n<i>Queue is empty — falls back to default card.</i>' : '')
      );
      return res.json({ ok: true });
    }

    // /queue list
    if (subCmd === 'list') {
      const qCards = await getQueueCards(userId);
      if (!qCards.length) {
        await sendMessage(chatId,
          `📭 No queue set.\n\nBuild one:\n<code>/queue set ID1 ID2 ID3</code>\n\nUse /card list for IDs.`
        );
        return res.json({ ok: true });
      }
      const list = qCards.map((c, i) =>
        `${i + 1}. ${formatCard(c, { showDefault: false })}`
      ).join('\n\n');
      await sendMessage(chatId,
        `<b>🔄 Rotation Queue (${qCards.length} cards):</b>\n\n${list}\n\n` +
        `Cards tried left→right. Stops on first hit.\n` +
        `Manage: /queue add | /queue remove | /queue clear`
      );
      return res.json({ ok: true });
    }

    // /queue clear
    if (subCmd === 'clear') {
      await clearQueue(userId);
      await sendMessage(chatId,
        `🗑 Queue cleared.\n\n<i>Checkouts will now use your default card (or ask for one).</i>`
      );
      return res.json({ ok: true });
    }

    await sendMessage(chatId, QUEUE_HELP);
    return res.json({ ok: true });
  }

  // ── /card ──────────────────────────────────────────────────────────────────
  if (/^\/card/.test(text)) {
    const parts  = text.split(/\s+/);
    const subCmd = parts[1]?.toLowerCase();

    if (!subCmd) { await sendMessage(chatId, CARD_HELP); return res.json({ ok: true }); }

    // /card add NUMBER|MM|YY|CVC [label]
    if (subCmd === 'add') {
      const rawCard = parts[2];
      const label   = parts.slice(3).join(' ') || null;
      if (!rawCard) {
        await sendMessage(chatId,
          `❌ Missing card data.\n\n${CARD_FORMAT_HINT}\n\n` +
          `With label: <code>/card add 4111...|12|25|123 Chase</code>`
        );
        return res.json({ ok: true });
      }
      const card = parseCard(rawCard);
      if (!card) {
        await sendMessage(chatId, `❌ Invalid format.\n\n${CARD_FORMAT_HINT}`);
        return res.json({ ok: true });
      }
      try {
        const { card: saved, wasAutoDefault } = await saveCard(userId, card, label);
        await sendMessage(chatId,
          `✅ <b>Card saved!</b>\n\n${formatCard(saved)}\n\n` +
          (wasAutoDefault
            ? `⭐ Auto-set as default (first card).`
            : `Use <code>/card default ${saved.id.slice(0, 8)}</code> to make it default.\n` +
              `Use <code>/queue add ${saved.id.slice(0, 8)}</code> to add it to rotation.`)
        );
      } catch (e) {
        await sendMessage(chatId, `❌ Failed to save: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    // /card list
    if (subCmd === 'list') {
      const cards = await getUserCards(userId);
      if (!cards.length) {
        await sendMessage(chatId, `📭 No saved cards.\n\nAdd one:\n<code>/card add NUMBER|MM|YY|CVC</code>`);
        return res.json({ ok: true });
      }
      const body = cards.map((c, i) => `${i + 1}. ${formatCard(c)}`).join('\n\n');
      await sendMessage(chatId,
        `<b>💳 Your Cards (${cards.length}):</b>\n\n${body}\n\n` +
        `/card default ID  |  /card del ID\n/queue set ID1 ID2 ID3 → build rotation`
      );
      return res.json({ ok: true });
    }

    // /card default ID
    if (subCmd === 'default') {
      const partial = parts[2];
      if (!partial) { await sendMessage(chatId, `❌ Provide a card ID.`); return res.json({ ok: true }); }
      const fullId = await resolveCardId(userId, partial);
      if (!fullId) { await sendMessage(chatId, `❌ Card not found.`); return res.json({ ok: true }); }
      try {
        const updated = await setDefaultCard(fullId, userId);
        await sendMessage(chatId, `⭐ <b>Default updated!</b>\n\n${formatCard(updated)}`);
      } catch (e) {
        await sendMessage(chatId, `❌ Failed: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    // /card del ID
    if (subCmd === 'del') {
      const partial = parts[2];
      if (!partial) { await sendMessage(chatId, `❌ Provide a card ID.`); return res.json({ ok: true }); }
      const fullId = await resolveCardId(userId, partial);
      if (!fullId) { await sendMessage(chatId, `❌ Card not found.`); return res.json({ ok: true }); }

      // Also remove from queue if present
      await removeFromQueue(userId, fullId);

      const result = await deleteCard(fullId, userId);
      if (!result.deleted) { await sendMessage(chatId, `❌ Could not delete.`); return res.json({ ok: true }); }
      let msg = `🗑 Card deleted.`;
      if (result.newDefault) msg += `\n\n⭐ New default:\n${formatCard(result.newDefault)}`;
      await sendMessage(chatId, msg);
      return res.json({ ok: true });
    }

    // /card clear
    if (subCmd === 'clear') {
      await clearQueue(userId); // also clear queue since cards are gone
      await supabase.from('cards').delete().eq('telegram_id', userId);
      await sendMessage(chatId, `🗑 All cards and queue cleared.`);
      return res.json({ ok: true });
    }

    await sendMessage(chatId, CARD_HELP);
    return res.json({ ok: true });
  }

  // ── /proxy ─────────────────────────────────────────────────────────────────
  if (/^\/proxy/.test(text)) {
    const parts  = text.split(/\s+/);
    const subCmd = parts[1];

    if (subCmd === 'add') {
      const proxy = parseProxy(parts.slice(2).join(''));
      if (!proxy?.host) {
        await sendMessage(chatId, `❌ Use: <code>/proxy add HOST:PORT:USER:PASS</code>`);
        return res.json({ ok: true });
      }
      await sendMessage(chatId, '🔄 Validating proxy...');
      try {
        const resp   = await callWorker('/validate-proxy', { proxy, telegram_id: userId });
        const result = await resp.json();
        await sendMessage(chatId, result.valid
          ? `✅ <b>Proxy saved!</b>\n\n🌍 ${result.country || '?'}  🔹 <code>${result.ip}</code>\n🏢 ${result.isp || '—'}`
          : `❌ Dead proxy. ${result.error || ''}`
        );
      } catch { await sendMessage(chatId, `❌ Worker unreachable.`); }
      return res.json({ ok: true });
    }

    if (subCmd === 'list') {
      const { data } = await supabase.from('proxies').select('id, host, port, country, ip, active, fail_count')
        .eq('telegram_id', userId).order('created_at', { ascending: false });
      if (!data?.length) {
        await sendMessage(chatId, `📭 No proxies.\n\n<code>/proxy add HOST:PORT:USER:PASS</code>`);
        return res.json({ ok: true });
      }
      const lines = data.map(p =>
        `${p.active ? '🟢' : '🔴'} <code>${p.id.slice(0, 8)}</code>  ${p.host}:${p.port}` +
        `${p.country ? `  (${p.country})` : ''}${p.fail_count > 0 ? `  ⚠${p.fail_count}` : ''}`
      ).join('\n');
      await sendMessage(chatId, `<b>Proxies (${data.length}):</b>\n\n${lines}`);
      return res.json({ ok: true });
    }

    if (subCmd === 'del' && parts[2]) {
      const { data } = await supabase.from('proxies').select('id').eq('telegram_id', userId)
        .ilike('id', `${parts[2]}%`).limit(1);
      if (!data?.length) { await sendMessage(chatId, `❌ Not found.`); return res.json({ ok: true }); }
      await supabase.from('proxies').delete().eq('id', data[0].id);
      await sendMessage(chatId, '✅ Proxy removed.');
      return res.json({ ok: true });
    }

    await sendMessage(chatId, `/proxy add HOST:PORT:USER:PASS\n/proxy list\n/proxy del ID`);
    return res.json({ ok: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session state machine
  // ─────────────────────────────────────────────────────────────────────────────
  const session = await getSession(userId);
  const state   = session.state;

  // ── IDLE ───────────────────────────────────────────────────────────────────
  if (state === 'idle') {
    if (!isCheckoutUrl(text)) {
      await sendMessage(chatId, `📎 Paste a <b>checkout URL</b> to get started.\n\nType /help for instructions.`);
      return res.json({ ok: true });
    }
    const checkoutUrl = text.trim();
    const prompt      = await buildCheckoutPrompt(userId, checkoutUrl);
    await setSession(userId, prompt.state, checkoutUrl, prompt.pendingCardId || null);
    await sendMessage(chatId, prompt.message);
    return res.json({ ok: true });
  }

  // ── WAITING_CONFIRM_QUEUE — queue pre-selected, waiting for YES or override ─
  if (state === 'waiting_confirm_queue') {
    const checkoutUrl = session.checkout_url;

    if (isCheckoutUrl(text)) {
      const prompt = await buildCheckoutPrompt(userId, text.trim());
      await setSession(userId, prompt.state, text.trim(), prompt.pendingCardId || null);
      await sendMessage(chatId, `🔗 URL updated!\n\n${prompt.message}`);
      return res.json({ ok: true });
    }

    if (/^(yes|y|ok|go|yep|yeah|sure|use|run|start|✅)$/i.test(text)) {
      const queueCards = await getQueueCards(userId);
      if (!queueCards.length) {
        await sendMessage(chatId, `❌ Queue is empty. Add cards with /queue add.`);
        await setSession(userId, 'idle');
        return res.json({ ok: true });
      }
      await startCheckout({ chatId, userId, checkoutUrl, cards: queueCards });
      return res.json({ ok: true });
    }

    // Override with a single pasted card
    const card = parseCard(text);
    if (card) {
      await startCheckout({ chatId, userId, checkoutUrl, cards: [card] });
      return res.json({ ok: true });
    }

    await sendMessage(chatId,
      `❓ Reply <b>YES</b> to run the queue, paste a single card to override, or /cancel.`
    );
    return res.json({ ok: true });
  }

  // ── WAITING_CONFIRM — single default card pre-selected ────────────────────
  if (state === 'waiting_confirm') {
    const checkoutUrl = session.checkout_url;

    if (isCheckoutUrl(text)) {
      const prompt = await buildCheckoutPrompt(userId, text.trim());
      await setSession(userId, prompt.state, text.trim(), prompt.pendingCardId || null);
      await sendMessage(chatId, `🔗 URL updated!\n\n${prompt.message}`);
      return res.json({ ok: true });
    }

    if (/^(yes|y|ok|go|yep|yeah|sure|use|✅)$/i.test(text)) {
      const card = await getCardById(session.pending_card_id, userId);
      if (!card) {
        await sendMessage(chatId, `❌ Default card not found. Paste one manually.`);
        await setSession(userId, 'waiting_card', checkoutUrl);
        return res.json({ ok: true });
      }
      await startCheckout({ chatId, userId, checkoutUrl, cards: [card] });
      return res.json({ ok: true });
    }

    const card = parseCard(text);
    if (card) {
      await startCheckout({ chatId, userId, checkoutUrl, cards: [card] });
      return res.json({ ok: true });
    }

    await sendMessage(chatId,
      `❓ Reply <b>YES</b> to use default card, paste a different card, or /cancel.`
    );
    return res.json({ ok: true });
  }

  // ── WAITING_CARD — no card saved, must paste ───────────────────────────────
  if (state === 'waiting_card') {
    const checkoutUrl = session.checkout_url;

    if (isCheckoutUrl(text)) {
      const prompt = await buildCheckoutPrompt(userId, text.trim());
      await setSession(userId, prompt.state, text.trim(), prompt.pendingCardId || null);
      await sendMessage(chatId, `🔗 URL updated!\n\n${prompt.message}`);
      return res.json({ ok: true });
    }

    const card = parseCard(text);
    if (!card) {
      await sendMessage(chatId,
        `❌ Invalid card format.\n\n${CARD_FORMAT_HINT}\n\n` +
        `💡 Save cards with /card add, build a queue with /queue set.`
      );
      return res.json({ ok: true });
    }
    await startCheckout({ chatId, userId, checkoutUrl, cards: [card] });
    return res.json({ ok: true });
  }

  // ── PROCESSING ─────────────────────────────────────────────────────────────
  if (state === 'processing') {
    await sendMessage(chatId, `⏳ Checkout running. Wait for result or /cancel.`);
    return res.json({ ok: true });
  }

  res.json({ ok: true });
}
