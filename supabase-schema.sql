-- ══════════════════════════════════════════════════════════
-- Portfolio Tracker — Supabase Schema
-- Safe to run multiple times (idempotent)
-- ══════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";

-- ── PORTFOLIOS ──────────────────────────────────────────────
create table if not exists portfolios (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null unique,
  data        jsonb not null default '{"wallets":[],"btc":[],"others":[],"indian":[],"intl":[],"mf":[],"banks":[]}',
  currency    text not null default 'INR',
  updated_at  timestamptz not null default now()
);
alter table portfolios enable row level security;
drop policy if exists "own portfolio" on portfolios;
create policy "own portfolio" on portfolios
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "public portfolio read" on portfolios;
create policy "public portfolio read" on portfolios
  for select using (
    auth.uid() = user_id
    or exists (select 1 from share_links sl where sl.user_id = portfolios.user_id)
  );

-- ── SNAPSHOTS ───────────────────────────────────────────────
create table if not exists snapshots (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  value_usd   numeric(20,4) not null,
  breakdown   jsonb,
  snapped_at  date not null default current_date
);
create unique index if not exists snapshots_user_date on snapshots(user_id, snapped_at);
alter table snapshots enable row level security;
drop policy if exists "own snapshots" on snapshots;
create policy "own snapshots" on snapshots
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── ALERTS ──────────────────────────────────────────────────
create table if not exists alerts (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid references auth.users(id) on delete cascade not null,
  type             text not null,
  asset            text not null,
  threshold        numeric(20,4) not null,
  currency         text not null default 'USD',
  channel          text not null default 'email',
  telegram_chat_id text,
  active           boolean not null default true,
  last_fired       timestamptz,
  created_at       timestamptz not null default now()
);
alter table alerts enable row level security;
drop policy if exists "own alerts" on alerts;
create policy "own alerts" on alerts
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── SHARE LINKS ─────────────────────────────────────────────
create table if not exists share_links (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  slug        text not null unique,
  show_values boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table share_links enable row level security;
drop policy if exists "owner manage" on share_links;
create policy "owner manage" on share_links
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "public read" on share_links;
create policy "public read" on share_links
  for select using (true);

-- ── TRIGGER: auto-update updated_at ─────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists portfolios_updated_at on portfolios;
create trigger portfolios_updated_at
  before update on portfolios
  for each row execute function update_updated_at();
