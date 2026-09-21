const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE  = `https://api.telegram.org/bot${TOKEN}`;

export async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${BASE}/sendMessage`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

export async function sendTyping(chatId) {
  await fetch(`${BASE}/sendChatAction`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ chat_id: chatId, action: 'typing' }),
  });
}
