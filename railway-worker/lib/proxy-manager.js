// ⚡ ALPHA Worker — Proxy Manager
// Validates proxies via live HTTP test and rotates them using LRU strategy.

import axios              from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { supabase }       from './supabase.js';

const VALIDATION_TIMEOUT_MS = 12000;
const MAX_FAIL_COUNT        = 3;   // deactivate after 3 consecutive failures

// ── Build proxy URL string ────────────────────────────────────────────────────
function buildProxyUrl(proxy) {
  if (proxy.username && proxy.password) {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }
  return `http://${proxy.host}:${proxy.port}`;
}

// ── Validate a single proxy object ───────────────────────────────────────────
// Returns { valid, ip, country, city, isp, error }
export async function validateProxy(proxy) {
  try {
    const proxyUrl = buildProxyUrl(proxy);
    const agent    = new HttpsProxyAgent(proxyUrl);

    const resp = await axios.get('http://ip-api.com/json?fields=status,country,city,isp,query', {
      httpAgent       : agent,
      httpsAgent      : agent,
      timeout         : VALIDATION_TIMEOUT_MS,
      validateStatus  : () => true,
    });

    if (resp.status !== 200 || resp.data?.status !== 'success') {
      return { valid: false, error: `ip-api returned: ${resp.data?.message || resp.status}` };
    }

    return {
      valid  : true,
      ip     : resp.data.query,
      country: resp.data.country,
      city   : resp.data.city,
      isp    : resp.data.isp,
    };
  } catch (err) {
    return { valid: false, error: err.message || 'Connection refused / timed out' };
  }
}

// ── Get next proxy for a user (LRU rotation) ─────────────────────────────────
export async function getNextProxy(telegramId) {
  const { data } = await supabase
    .from('proxies')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('active', true)
    .order('last_validated', { ascending: true })  // least-recently-used first
    .limit(1);

  if (!data?.length) return null;

  const proxy = data[0];

  // Bump last_validated so next call picks a different proxy
  await supabase
    .from('proxies')
    .update({ last_validated: new Date().toISOString() })
    .eq('id', proxy.id);

  return proxy;
}

// ── Build Playwright proxy config from DB row ─────────────────────────────────
export function toPlaywrightProxy(proxy) {
  if (!proxy) return undefined;
  return {
    server  : `http://${proxy.host}:${proxy.port}`,
    username: proxy.username  || undefined,
    password: proxy.password  || undefined,
  };
}

// ── Health-check ALL active proxies (called hourly by server.js) ──────────────
export async function runHealthCheck() {
  console.log('[ProxyManager] Running health check…');

  const { data: proxies, error } = await supabase
    .from('proxies')
    .select('*')
    .eq('active', true);

  if (error || !proxies?.length) {
    console.log('[ProxyManager] No active proxies to check.');
    return;
  }

  for (const proxy of proxies) {
    const result = await validateProxy(proxy);

    if (result.valid) {
      // Refresh geo info and reset fail count
      await supabase.from('proxies').update({
        valid          : true,
        active         : true,
        fail_count     : 0,
        ip             : result.ip,
        country        : result.country,
        city           : result.city,
        isp            : result.isp,
        last_validated : new Date().toISOString(),
      }).eq('id', proxy.id);

      console.log(`[ProxyManager] ✅ ${proxy.host}:${proxy.port} — ${result.ip} (${result.country})`);
    } else {
      const newFailCount = (proxy.fail_count || 0) + 1;
      const deactivate   = newFailCount >= MAX_FAIL_COUNT;

      await supabase.from('proxies').update({
        valid          : false,
        active         : !deactivate,
        fail_count     : newFailCount,
        last_validated : new Date().toISOString(),
      }).eq('id', proxy.id);

      console.log(`[ProxyManager] ❌ ${proxy.host}:${proxy.port} — ${result.error} (fails: ${newFailCount}${deactivate ? ' → DEACTIVATED' : ''})`);
    }
  }

  console.log('[ProxyManager] Health check complete.');
}
