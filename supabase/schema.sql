-- ALPHA TG Bot - Supabase Schema (idempotent - safe to re-run)

create table if not exists sessions (
  telegram_id bigint primary key,
  state text default 'idle'
    check (state in ('idle','waiting_card','waiting_confirm','waiting_confirm_queue','processing')),
  checkout_url text,
  pending_card_id uuid,
  updated_at timestamptz default now()
);

create table if not exists proxies (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  host text not null,
  port int not null,
  username text,
  password text,
  country text,
  city text,
  ip text,
  isp text,
  valid boolean default false,
  active boolean default true,
  fail_count int default 0,
  last_validated timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists idx_proxies_telegram_id on proxies(telegram_id);
create index if not exists idx_proxies_active on proxies(active);
create index if not exists idx_proxies_last_validated on proxies(last_validated);

create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  label text,
  number text not null,
  month text not null,
  year text not null,
  cvc text not null,
  expiry text not null,
  bin text not null,
  last4 text not null,
  is_default boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_cards_telegram_id on cards(telegram_id);
create index if not exists idx_cards_is_default on cards(is_default);

create table if not exists hits (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint,
  checkout_url text,
  card_bin text,
  card_last4 text,
  status text check (status in ('hit','decline','error','unknown')),
  response_text text,
  proxy_used text,
  created_at timestamptz default now()
);

create index if not exists idx_hits_telegram_id on hits(telegram_id);
create index if not exists idx_hits_status on hits(status);
create index if not exists idx_hits_created_at on hits(created_at);

create table if not exists card_queues (
  telegram_id bigint primary key,
  card_ids jsonb,
  updated_at timestamptz default now()
);
