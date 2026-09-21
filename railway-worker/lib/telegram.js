// ⚡ ALPHA Worker — Telegram sender (v5: timeouts + text-first result delivery)

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE  = `https://api.telegram.org/bot${TOKEN}`;

// All Telegram HTTP calls get a hard timeout so a hung request never blocks results.
async function tgFetch(path, init, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function sendMessage(chatId, text) {
  try {
    await tgFetch('/sendMessage', {
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
  form.append('caption',    caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  const resp = await tgFetch('/sendPhoto', { method: 'POST', body: form }, 25000);
  if (!resp.ok) throw new Error(`sendPhoto HTTP ${resp.status}`);
}

// ── Card number masker ────────────────────────────────────────────────────────
export function maskNumber(number) {
  const n = String(number).replace(/\s/g, '');
  if (n.length < 10) return n;
  const first6 = n.slice(0, 6);
  const last4  = n.slice(-4);
  const mid    = 'x'.repeat(n.length - 10);
  return `${first6}${mid}${last4}`.match(/.{1,4}/g)?.join(' ') ?? `${first6}...${last4}`;
}

// ── Per-attempt progress (multi-card rotation) ────────────────────────────────
export async function sendAttemptUpdate(chatId, { attemptNum, total, masked, expiry, status, message }) {
  if (total <= 1) return;
  const emoji = status === 'decline' ? '❌' : status === 'error' ? '⚠️' : '⏳';
  const label = status === 'decline' ? 'Declined' : status === 'error' ? 'Error' : 'Processing';
  await sendMessage(chatId,
    `${emoji} <b>Card ${attemptNum}/${total} — ${label}</b>\n` +
    `💳 <code>${masked}</code>  📅 ${expiry}\n` +
    (message ? `📄 ${message}\n` : '') +
    (attemptNum < total ? `\n⏩ Trying card ${attemptNum + 1}/${total}...` : '')
  );
}

// ── Final result — TEXT FIRST (always arrives), then screenshot as a 2nd msg ──
export async function sendResult(chatId, result, meta = {}) {
  const { status, message, screenshot, url } = result;
  const { cardNum = 1, total = 1, masked = '', expiry = '', proxy, exhausted } = meta;

  const emoji = status === 'hit' ? '✅' : status === 'decline' ? '❌' : '⚠️';
  const label = status === 'hit' ? 'HIT — CHARGED' : status === 'decline' ? 'DECLINED' : 'UNKNOWN / ERROR';

  let contextLine = '';
  if (total > 1) {
    if (status === 'hit') contextLine = `🎯 Hit on card ${cardNum} of ${total}`;
    else if (exhausted)   contextLine = `🚫 All ${total} cards exhausted — no hit`;
  }

  const lines = [
    `${emoji} <b>${label}</b>`,
    contextLine,
    masked  ? `💳 <code>${masked}</code>  📅 ${expiry}` : '',
    message ? `📄 ${message}` : '',
    url     ? `🔗 <code>${url.slice(0, 70)}</code>` : '',
    proxy   ? `🌐 ${proxy}` : '',
  ].filter(Boolean).join('\n');

  // 1) Send the text result FIRST — guaranteed delivery path
  await sendMessage(chatId, lines);

  // 2) Then attach the screenshot (best-effort, time-bound)
  if (screenshot) {
    try {
      await sendPhoto(chatId, screenshot, '📸 Result screenshot');
    } catch (e) {
      console.warn('[TG] sendPhoto failed:', e.message);
    }
  }
}
