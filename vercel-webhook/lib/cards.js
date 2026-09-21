// ⚡ ALPHA TG Bot — Card Management Helpers

import { supabase } from './supabase.js';

// ── Mask card number for safe display ────────────────────────────────────────
// e.g. 4111111111111111 → 4111 11xx xxxx 1111
export function maskNumber(number) {
  const n = String(number).replace(/\s/g, '');
  if (n.length < 10) return n;
  const first6 = n.slice(0, 6);
  const last4  = n.slice(-4);
  const mid    = 'x'.repeat(n.length - 10);
  // Format with spaces every 4 chars
  const full   = `${first6}${mid}${last4}`;
  return full.match(/.{1,4}/g)?.join(' ') ?? full;
}

// ── Get the default card for a user ──────────────────────────────────────────
export async function getDefaultCard(telegramId) {
  const { data } = await supabase
    .from('cards')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('is_default', true)
    .single();
  return data || null;
}

// ── Get card by ID (must belong to user) ─────────────────────────────────────
export async function getCardById(id, telegramId) {
  const { data } = await supabase
    .from('cards')
    .select('*')
    .eq('id', id)
    .eq('telegram_id', telegramId)
    .single();
  return data || null;
}

// ── Get all cards for a user ──────────────────────────────────────────────────
export async function getUserCards(telegramId) {
  const { data } = await supabase
    .from('cards')
    .select('*')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false });
  return data || [];
}

// ── Save a new card ───────────────────────────────────────────────────────────
// If it's the user's first card, auto-set as default.
export async function saveCard(telegramId, card, label = null) {
  const existing = await getUserCards(telegramId);
  const isFirst  = existing.length === 0;

  const { data, error } = await supabase
    .from('cards')
    .insert({
      telegram_id : telegramId,
      label       : label || null,
      number      : card.number,
      month       : card.month,
      year        : card.year,
      cvc         : card.cvc,
      expiry      : card.expiry,
      bin         : card.number.slice(0, 6),
      last4       : card.number.slice(-4),
      is_default  : isFirst,   // first card is automatically the default
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return { card: data, wasAutoDefault: isFirst };
}

// ── Set a card as default (clears old default first) ─────────────────────────
export async function setDefaultCard(cardId, telegramId) {
  // Clear existing default
  await supabase
    .from('cards')
    .update({ is_default: false })
    .eq('telegram_id', telegramId);

  // Set new default
  const { data, error } = await supabase
    .from('cards')
    .update({ is_default: true })
    .eq('id', cardId)
    .eq('telegram_id', telegramId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// ── Delete a card ─────────────────────────────────────────────────────────────
// If deleted card was default, auto-promote the most recent remaining card.
export async function deleteCard(cardId, telegramId) {
  const card = await getCardById(cardId, telegramId);
  if (!card) return { deleted: false, reason: 'not_found' };

  await supabase.from('cards').delete().eq('id', cardId);

  // If it was the default, promote the next newest card
  if (card.is_default) {
    const remaining = await getUserCards(telegramId);
    if (remaining.length > 0) {
      await supabase
        .from('cards')
        .update({ is_default: true })
        .eq('id', remaining[0].id);
      return { deleted: true, newDefault: remaining[0] };
    }
  }

  return { deleted: true, newDefault: null };
}

// ── Format a card for display ─────────────────────────────────────────────────
export function formatCard(card, { showDefault = true, index = null } = {}) {
  const prefix     = index !== null ? `${index}. ` : '';
  const label      = card.label ? `<b>${card.label}</b>` : '<b>Card</b>';
  const masked     = maskNumber(card.number);
  const defaultTag = (showDefault && card.is_default) ? '  ⭐' : '';
  return `${prefix}${label}${defaultTag}\n  💳 <code>${masked}</code>\n  📅 ${card.expiry}  🔐 ${card.cvc}\n  🆔 <code>${card.id.slice(0, 8)}</code>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card Queue (rotation list) helpers
// ─────────────────────────────────────────────────────────────────────────────

// Get the saved queue row (or null)
export async function getQueueRow(telegramId) {
  const { data } = await supabase
    .from('card_queues')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data || null;
}

// Get ordered card objects for the queue (skips missing/deleted cards)
export async function getQueueCards(telegramId) {
  const row = await getQueueRow(telegramId);
  if (!row || !row.card_ids?.length) return [];

  // Fetch all in one query then re-order to match stored sequence
  const { data: cards } = await supabase
    .from('cards')
    .select('*')
    .eq('telegram_id', telegramId)
    .in('id', row.card_ids);

  if (!cards?.length) return [];

  // Restore stored order (some cards may have been deleted)
  const cardMap = Object.fromEntries(cards.map(c => [c.id, c]));
  return row.card_ids.map(id => cardMap[id]).filter(Boolean);
}

// Overwrite the queue with a new ordered list of card IDs
export async function setQueue(telegramId, cardIds) {
  await supabase.from('card_queues').upsert({
    telegram_id : telegramId,
    card_ids    : cardIds,
    updated_at  : new Date().toISOString(),
  });
}

// Append one card ID to the end of the queue
export async function appendToQueue(telegramId, cardId) {
  const row      = await getQueueRow(telegramId);
  const existing = row?.card_ids || [];
  if (existing.includes(cardId)) return; // already in queue
  await setQueue(telegramId, [...existing, cardId]);
}

// Remove one card ID from the queue
export async function removeFromQueue(telegramId, cardId) {
  const row = await getQueueRow(telegramId);
  if (!row) return;
  await setQueue(telegramId, (row.card_ids || []).filter(id => id !== cardId));
}

// Clear the queue entirely
export async function clearQueue(telegramId) {
  await supabase.from('card_queues').delete().eq('telegram_id', telegramId);
}

// Resolve a partial ID (first 8 chars) to a full UUID for a given user's cards
export async function resolveCardId(telegramId, partialId) {
  const { data } = await supabase
    .from('cards')
    .select('id')
    .eq('telegram_id', telegramId)
    .ilike('id', `${partialId}%`)
    .limit(1);
  return data?.[0]?.id || null;
}
