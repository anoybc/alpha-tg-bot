-- ⚡ ALPHA TG Bot — Supabase Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── Sessions (conversation state machine) ────────────────────────────────────
create table if not exists sessions (
  telegram_id     bigint primary key,
  state           text default 'idle'
                    check (state in ('idle', 'waiting_card', 'waiting_confirm', 'waiting_confirm_queue', 'processing')),
  checkout_url    text,
  pending_card_id uuid,   -- set when a default card is pre-selected for confirmation
  updated_at      timestamptz default now()
);

-- ── Proxies ───────────────────────────────────────────────────────────────────
create table if not exists proxies (
  id              uuid primary key default gen_random_uuid(),
  telegram_id     bigint not null,
  host            text not null,
  port            int  not null,
  username        text,
  password        text,
  country         text,
  city            text,
  ip              text,
  isp             text,
  valid           boolean default false,
  active          boolean default true,
  fail_count      int default 0,
  last_validated  timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists idx_proxies_telegram_id  on proxies(telegram_id);
create index if not exists idx_proxies_active        on proxies(active);
create index if not exists idx_proxies_last_validated on proxies(last_validated);

-- ── Saved cards (per user) ──────────────────────────────────────────────────
create table if not exists cards (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  label       text,             -- optional user-given name e.g. "Chase Visa"
  number      text not null,    -- full card number
  month       text not null,
  year        text not null,
  cvc         text not null,
  expiry      text not null,    -- MM/YY display format
  bin         text not null,    -- first 6 digits
  last4       text not null,    -- last 4 digits
  is_default  boolean default false,
  created_at  timestamptz default now()
);

create index if not exists idx_cards_telegram_id on cards(telegram_id);
create index if not exists idx_cards_is_default  on cards(is_default);

-- ── Hits log ──────────────────────────────────────────────────────────────────
create table if not exists hits (
  id              uuid primary key default gen_random_uuid(),
  telegram_id     bigint,
  checkout_url    text,
  card_bin        text,           -- first 6 digits only
  card_last4      text,           -- last 4 digits only
  status          text check (status in ('hit', 'decline', 'error', 'unknown')),
  response_text   text,
  proxy_used      text,
  created_at      timestamptz default now()
);

create index if not exists idx_hits_telegram_id on hits(telegram_id);
create index if not exists idx_hits_status      on hits(status);
create index if not exists idx_hits_created_at  on hits(created_at);

-- ── Row Level Security (service role bypasses all) ────────────────────────────
alter table sessions enable row level security;
alter table proxies  enable row level security;
alter table hits     enable row level security;
alter table cards    enable row level security;

-- Allow service_role (our backend) full access
create policy "service_role_sessions" on sessions using (true) with check (true);
create policy "service_role_proxies"  on proxies  using (true) with check (true);
create policy "service_role_hits"     on hits      using (true) with check (true);
create policy "service_role_cards"    on cards     using (true) with check (true);

-- ── Card rotation queues (per user) ────────────────────────────────────────
create table if not exists card_queues (
  telegram_id  bigint primary key,
  card_ids     jsonb not null default '[]'::jsonb,   -- ordered list of card IDs to try
  updated_at   timestamptz default now()
);

alter table card_queues enable row level security;
create policy "service_role_card_queues" on card_queues using (true) with check (true);

-- ── If upgrading an existing install, run these ALTER statements ─────────────
-- alter table sessions add column if not exists pending_card_id uuid;
-- alter table sessions drop constraint if exists sessions_state_check;
-- alter table sessions add constraint sessions_state_check
--   check (state in ('idle','waiting_card','waiting_confirm','waiting_confirm_queue','processing'));
-- create table if not exists card_queues ( telegram_id bigint primary key, card_ids jsonb not null default '[]'::jsonb, updated_at timestamptz default now() );
