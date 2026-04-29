-- TradeArena — initial schema (Task #2 foundation)
-- Run this once in Supabase Dashboard → SQL Editor.
--
-- Tables created here are designed to support the full product roadmap:
--   - profiles, strategies, paper_trades, holdings (Task #3 — trader scorecard)
--   - reels, reel_tags, reel_mirrors (Task #4 — strategy reels feed)
--   - chart_layouts, price_bars (Task #2b — pro charts)
--   - schools, modules, quizzes, challenges, perks (Task #5 — education)
--   - follows, leagues, league_members (social + competition)
--
-- RLS policies are written conservatively: owner-only writes, public reads
-- where it makes sense, and a `visibility_mask` on profiles so traders can
-- pick exactly which sections of their page are public.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ============================================================
-- profiles  (1-to-1 with auth.users)
-- ============================================================
-- Note: profiles intentionally does NOT store email. The canonical email lives
-- in auth.users; duplicating it here would create a PII enumeration surface.
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text unique not null check (username ~ '^[a-z][a-z0-9_]{2,19}$'),
  display_name    text not null,
  university      text not null default 'Public',
  tier            text not null default 'Member',           -- Student | Member | Pro
  type            text not null default 'public',           -- student | public
  bio             text default '',
  avatar_color    text,
  is_admin        boolean not null default false,
  visibility_mask jsonb not null default '{
    "holdings":      false,
    "cash":          false,
    "equity_curve":  true,
    "metrics":       true,
    "strategies":    true,
    "journal":       true,
    "reels":         true,
    "university":    true
  }'::jsonb,
  badges          text[] not null default '{}'::text[],
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists profiles_username_lower_idx on public.profiles (lower(username));
create index if not exists profiles_university_idx     on public.profiles (university);

-- ============================================================
-- strategies
-- ============================================================
create table if not exists public.strategies (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  description text default '',
  rules       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists strategies_owner_idx on public.strategies(owner_id);

-- ============================================================
-- paper_trades
-- ============================================================
create table if not exists public.paper_trades (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles(id) on delete cascade,
  symbol          text not null,
  market          text,                                       -- asx | us | crypto
  side            text not null check (side in ('buy','sell')),
  qty             numeric(20,8) not null,
  entry_price     numeric(20,8) not null,
  exit_price      numeric(20,8),
  stop_loss       numeric(20,8),
  target          numeric(20,8),
  status          text not null default 'open' check (status in ('open','closed','cancelled')),
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  source_reel_id  uuid,                                       -- FK added later (chicken/egg with reels)
  notes           text default ''
);
create index if not exists paper_trades_owner_idx  on public.paper_trades(owner_id);
create index if not exists paper_trades_status_idx on public.paper_trades(owner_id, status);

-- ============================================================
-- reels  (the social trade-idea feed)
-- ============================================================
create table if not exists public.reels (
  id                  uuid primary key default gen_random_uuid(),
  author_id           uuid not null references public.profiles(id) on delete cascade,
  symbol              text not null,
  market              text,
  chart_snapshot_url  text,                                   -- storage URL or data URL
  thesis              text not null check (length(thesis) <= 280),
  entry               numeric(20,8),
  stop_loss           numeric(20,8),
  target              numeric(20,8),
  direction           text check (direction in ('long','short')),
  paper_trade_id      uuid references public.paper_trades(id) on delete set null,
  visibility          text not null default 'public' check (visibility in ('public','followers','league','private')),
  created_at          timestamptz not null default now()
);
create index if not exists reels_author_idx     on public.reels(author_id);
create index if not exists reels_created_at_idx on public.reels(created_at desc);
create index if not exists reels_symbol_idx     on public.reels(symbol);

-- back-fill the FK from paper_trades.source_reel_id now that reels exists
alter table public.paper_trades
  drop constraint if exists paper_trades_source_reel_fkey,
  add  constraint paper_trades_source_reel_fkey
    foreign key (source_reel_id) references public.reels(id) on delete set null;

-- ============================================================
-- reel_tags  (Instagram-style "tag people", but for indicators / patterns / strategies / tickers)
--   tag_type: indicator | pattern | strategy | ticker
--   x_pct, y_pct: position on the chart snapshot, 0–100 (NULL = chip-only, not pinned)
-- ============================================================
create table if not exists public.reel_tags (
  id          uuid primary key default gen_random_uuid(),
  reel_id     uuid not null references public.reels(id) on delete cascade,
  tag_type    text not null check (tag_type in ('indicator','pattern','strategy','ticker')),
  tag_value   text not null,
  x_pct       numeric(5,2),
  y_pct       numeric(5,2),
  ordinal     int not null default 0
);
create index if not exists reel_tags_reel_idx  on public.reel_tags(reel_id);
create index if not exists reel_tags_value_idx on public.reel_tags(tag_type, lower(tag_value));

-- ============================================================
-- reel_mirrors  (when another user copies a reel into their paper book)
-- ============================================================
create table if not exists public.reel_mirrors (
  id              uuid primary key default gen_random_uuid(),
  reel_id         uuid not null references public.reels(id) on delete cascade,
  mirrored_by     uuid not null references public.profiles(id) on delete cascade,
  paper_trade_id  uuid references public.paper_trades(id) on delete set null,
  sized_risk_pct  numeric(5,2),
  created_at      timestamptz not null default now()
);
create index if not exists reel_mirrors_reel_idx on public.reel_mirrors(reel_id);
create index if not exists reel_mirrors_user_idx on public.reel_mirrors(mirrored_by);

-- ============================================================
-- reel_engagement  (likes / saves / shares — count tracking)
-- ============================================================
create table if not exists public.reel_engagement (
  id          uuid primary key default gen_random_uuid(),
  reel_id     uuid not null references public.reels(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('like','save','share','view')),
  created_at  timestamptz not null default now(),
  unique (reel_id, user_id, kind)
);
create index if not exists reel_engagement_reel_idx on public.reel_engagement(reel_id, kind);

-- ============================================================
-- (Note: holdings_view is intentionally NOT defined here. The
-- canonical materialized-view version is created lower in this file
-- after RLS is configured. An earlier draft of this migration created
-- a regular view at this point, which then collided with the matview
-- on re-run because Postgres won't let `drop materialized view if
-- exists` remove a regular view of the same name.)
-- ============================================================
-- follows  (social graph)
-- ============================================================
create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id)
);

-- ============================================================
-- leagues + league_members
-- ============================================================
create table if not exists public.leagues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  university  text,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.league_members (
  league_id  uuid not null references public.leagues(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- ============================================================
-- chart_layouts  (saved TradingView layouts per user — Task #2b)
-- ============================================================
create table if not exists public.chart_layouts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  symbol      text,
  resolution  text,
  layout      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- price_bars  (cached OHLCV for replay / fallback — Task #2b)
-- ============================================================
create table if not exists public.price_bars (
  symbol      text not null,
  resolution  text not null,
  t           timestamptz not null,
  o           numeric(20,8),
  h           numeric(20,8),
  l           numeric(20,8),
  c           numeric(20,8),
  v           numeric(20,8),
  primary key (symbol, resolution, t)
);

-- ============================================================
-- updated_at triggers
-- ============================================================
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

drop trigger if exists chart_layouts_updated_at on public.chart_layouts;
create trigger chart_layouts_updated_at before update on public.chart_layouts
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- RPC: email_for_username_login  (lets users log in with their username)
--
-- Naively translating username -> email would let anyone enumerate every
-- registered email address by trying a list of usernames. Instead this RPC
-- requires the caller to also supply the candidate password and verifies it
-- server-side against auth.users.encrypted_password (bcrypt via pgcrypto).
-- The email is returned ONLY when the credential pair is correct, so the
-- function discloses nothing an attacker does not already know.
--
-- Email logins skip this RPC entirely (the client passes the email straight
-- to signInWithPassword). The forgot-password flow also requires an email,
-- so this RPC is only used by the username-login path.
-- ============================================================
create or replace function public.email_for_username_login(p_username text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  candidate_email text;
  candidate_hash  text;
begin
  if p_username is null or length(trim(p_username)) < 3 then return null; end if;
  if p_password is null or length(p_password)        = 0 then return null; end if;

  select u.email, u.encrypted_password
    into candidate_email, candidate_hash
    from auth.users u
    join public.profiles p on p.id = u.id
   where lower(p.username) = lower(trim(p_username))
   limit 1;

  if candidate_email is null or candidate_hash is null then
    return null;
  end if;
  -- crypt() resolves via the function's search_path (public/extensions),
  -- whichever schema Supabase placed pgcrypto in.
  if crypt(p_password, candidate_hash) = candidate_hash then
    return candidate_email;
  end if;
  return null;
end;
$$;
grant execute on function public.email_for_username_login(text, text) to anon, authenticated;

-- Drop the older, leakier variant if it was ever created.
drop function if exists public.lookup_email_by_login(text);

-- ============================================================
-- RPC: seed_demo_users
-- One-shot seeder for the 8 legacy demo accounts so the existing demo logins
-- (e.g. liamos@... / demo1234) keep working against real Supabase Auth.
-- All passwords are stored as bcrypt hashes via pgcrypto, the same format
-- supabase-auth uses for real signups.
-- Call once after the migration:  select public.seed_demo_users();
-- Re-runnable: existing accounts are skipped.
-- ============================================================
create or replace function public.seed_demo_users()
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  rec record;
  uid uuid;
  inserted int := 0;
  skipped  int := 0;
begin
  for rec in
    select * from (values
      ('alex.chen@student.unsw.edu.au', 'alexchen', 'student', 'UNSW',    'Student', 12, false),
      ('mia.lee@usyd.edu.au',           'mialee',   'student', 'USYD',    'Student',  9, false),
      ('jordan.kim@uts.edu.au',         'jkim',     'student', 'UTS',     'Student',  7, false),
      ('sarah.patel@monash.edu',        'sarahp',   'student', 'Monash',  'Student',  5, false),
      ('noah.brown@unimelb.edu.au',     'noahb',    'student', 'UniMelb', 'Student',  3, false),
      ('ella.smith@anu.edu.au',         'esmith',   'student', 'ANU',     'Student',  2, false),
      ('priya.shah@uq.edu.au',          'priya',    'student', 'UQ',      'Student',  2, false),
      ('liam.osullivan@gmail.com',      'liamos',   'public',  'Public',  'Pro',      1, true)
    ) as t(email, username, type, university, tier, days_ago, is_admin)
  loop
    if exists (select 1 from auth.users where lower(email) = lower(rec.email)) then
      skipped := skipped + 1;
      continue;
    end if;

    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000',
      uid, 'authenticated', 'authenticated', rec.email,
      crypt('demo1234', gen_salt('bf')),
      now() - (rec.days_ago || ' days')::interval,
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', rec.username, 'type', rec.type, 'university', rec.university),
      now() - (rec.days_ago || ' days')::interval, now()
    );

    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid, uid::text, 'email',
      jsonb_build_object('sub', uid::text, 'email', rec.email),
      now() - (rec.days_ago || ' days')::interval,
      now() - (rec.days_ago || ' days')::interval, now()
    );

    insert into public.profiles (
      id, username, display_name, university, tier, type, bio,
      avatar_color, is_admin, badges, created_at
    ) values (
      uid, rec.username, initcap(rec.username), rec.university, rec.tier, rec.type,
      'Demo account · password is demo1234',
      '#' || substr(md5(rec.username), 1, 6),
      rec.is_admin,
      case when rec.is_admin then array['founder','admin'] else array['early-access'] end,
      now() - (rec.days_ago || ' days')::interval
    );

    inserted := inserted + 1;
  end loop;

  return format('Seeded %s users (%s skipped). Demo password: demo1234', inserted, skipped);
end;
$$;
revoke execute on function public.seed_demo_users() from public;

-- ============================================================
-- RPC: check_username_available
-- ============================================================
create or replace function public.check_username_available(p_username text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(trim(p_username))
  );
$$;
grant execute on function public.check_username_available(text) to anon, authenticated;

-- ============================================================
-- RPC: check_email_available
-- An email is "available" if there's no profile yet for it.
-- (This lets users resume a half-finished signup where auth.users exists
--  but profiles does not.)
-- ============================================================
create or replace function public.check_email_available(p_email text)
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select not exists (
    select 1
      from auth.users u
      join public.profiles p on p.id = u.id
     where lower(u.email) = lower(trim(p_email))
  );
$$;
grant execute on function public.check_email_available(text) to anon, authenticated;

-- ============================================================
-- Helper: has_visibility(owner, field)
-- SECURITY DEFINER so it can read the owner's visibility_mask even when
-- the caller's RLS would forbid SELECT on the profile row.
-- ============================================================
create or replace function public.has_visibility(p_owner uuid, p_field text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((visibility_mask->>p_field)::boolean, false)
    from public.profiles where id = p_owner;
$$;
grant execute on function public.has_visibility(uuid, text) to anon, authenticated;

-- ============================================================
-- Admin-only RPC: list_registrations
-- Returns a registration summary for the admin page. Caller must have
-- profiles.is_admin = true.
-- ============================================================
create or replace function public.list_registrations()
returns table (
  email      text,
  username   text,
  university text,
  tier       text,
  type       text,
  is_admin   boolean,
  joined_at  timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin = true) then
    raise exception 'Forbidden: admin only';
  end if;
  return query
    select u.email::text, p.username, p.university, p.tier, p.type, p.is_admin, p.created_at
      from public.profiles p
      join auth.users u on u.id = p.id
     order by p.created_at desc;
end;
$$;
grant execute on function public.list_registrations() to authenticated;

-- ============================================================
-- Row-Level Security
-- ============================================================
alter table public.profiles        enable row level security;
alter table public.strategies      enable row level security;
alter table public.paper_trades    enable row level security;
alter table public.reels           enable row level security;
alter table public.reel_tags       enable row level security;
alter table public.reel_mirrors    enable row level security;
alter table public.reel_engagement enable row level security;
alter table public.follows         enable row level security;
alter table public.leagues         enable row level security;
alter table public.league_members  enable row level security;
alter table public.chart_layouts   enable row level security;
alter table public.price_bars      enable row level security;

-- ----- profiles -----
-- Direct SELECT on the table is restricted to the owner, so that sensitive
-- columns (is_admin, visibility_mask, raw bio, etc.) are never exposed to
-- other users. The public-safe view `public_profiles` (defined below) is
-- what other clients should query when looking up someone else.
drop policy if exists profiles_read_all      on public.profiles;
drop policy if exists profiles_read_self     on public.profiles;
drop policy if exists profiles_insert_self   on public.profiles;
drop policy if exists profiles_update_self   on public.profiles;
drop policy if exists profiles_delete_self   on public.profiles;
create policy profiles_read_self    on public.profiles for select using (auth.uid() = id);
create policy profiles_insert_self  on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update_self  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_delete_self  on public.profiles for delete using (auth.uid() = id);

-- Public view: only the columns the task contract approves for the public
-- profile surface — username, display_name, tier, avatar_color, badges.
-- Granted to authenticated users only (NOT anon) so unauthenticated visitors
-- cannot enumerate the user list.
-- security_invoker = false means the view runs with the definer's privileges,
-- bypassing the self-only RLS on profiles for read-only purposes.
-- Drop any prior incarnation regardless of object type (regular view,
-- materialized view, or table) so the migration is safely re-runnable.
drop materialized view if exists public.public_profiles;
drop view              if exists public.public_profiles;
drop table             if exists public.public_profiles;
create view public.public_profiles
with (security_invoker = false) as
  select id, username, display_name, tier, avatar_color, badges
    from public.profiles;
revoke all on public.public_profiles from public;
grant select on public.public_profiles to authenticated;

-- ----- strategies -----
drop policy if exists strategies_read_all     on public.strategies;
drop policy if exists strategies_write_owner  on public.strategies;
create policy strategies_read_all    on public.strategies for select using (true);
create policy strategies_write_owner on public.strategies for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ----- paper_trades -----
-- Owner sees everything. Others see only when the owner has opted-in (visibility_mask.holdings).
drop policy if exists paper_trades_read    on public.paper_trades;
drop policy if exists paper_trades_write   on public.paper_trades;
create policy paper_trades_read on public.paper_trades for select using (
  owner_id = auth.uid()
  or public.has_visibility(owner_id, 'holdings')
);
create policy paper_trades_write on public.paper_trades for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============================================================
-- holdings_view  (materialized roll-up of paper_trades)
-- One row per (owner_id, symbol) summarising open positions.
-- Note: PostgreSQL does NOT enforce RLS on materialized views, so direct
-- SELECT is revoked from regular users. Cross-user access goes through the
-- visibility-aware functions below; the materialized view itself is only
-- readable by service_role (and by the wrapper functions which run
-- SECURITY DEFINER). Refresh with: select public.refresh_holdings_view();
-- ============================================================
-- Drop any prior incarnation regardless of object type so the migration
-- can re-create holdings_view as a materialized view even when an
-- earlier iteration of the schema defined it as a regular view, a
-- table, or a foreign table. We can't just chain three IF EXISTS
-- statements: `drop materialized view if exists` does NOT silently
-- skip an object that exists with the wrong type — it raises
--   ERROR 42809: "holdings_view" is not a materialized view
-- So we look at pg_class.relkind first and emit the matching DROP.
do $$
declare
  v_kind char;
begin
  select c.relkind into v_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'holdings_view';
  if v_kind is null then
    return;                         -- nothing to drop
  elsif v_kind = 'm' then
    execute 'drop materialized view public.holdings_view cascade';
  elsif v_kind = 'v' then
    execute 'drop view public.holdings_view cascade';
  elsif v_kind in ('r','p') then
    execute 'drop table public.holdings_view cascade';
  elsif v_kind = 'f' then
    execute 'drop foreign table public.holdings_view cascade';
  else
    raise exception 'unexpected relkind % for public.holdings_view', v_kind;
  end if;
end $$;
create materialized view public.holdings_view as
  select
    owner_id,
    symbol,
    sum(case when side = 'buy' then qty else -qty end)             as net_qty,
    sum(case when side = 'buy' then qty * entry_price else 0 end)
      / nullif(sum(case when side = 'buy' then qty else 0 end), 0) as avg_cost,
    count(*) filter (where status = 'open')                        as open_legs,
    max(opened_at)                                                 as last_activity
  from public.paper_trades
  group by owner_id, symbol
  having sum(case when side = 'buy' then qty else -qty end) <> 0;

create unique index if not exists holdings_view_pk_idx
  on public.holdings_view (owner_id, symbol);
create index if not exists holdings_view_owner_idx
  on public.holdings_view (owner_id);

revoke all on public.holdings_view from public;
grant select on public.holdings_view to service_role;

create or replace function public.get_my_holdings()
returns setof public.holdings_view
language sql stable
security definer
set search_path = public
as $$
  select * from public.holdings_view where owner_id = auth.uid();
$$;
grant execute on function public.get_my_holdings() to authenticated;

create or replace function public.get_holdings_for(p_owner uuid)
returns setof public.holdings_view
language sql stable
security definer
set search_path = public
as $$
  select * from public.holdings_view
   where owner_id = p_owner
     and (p_owner = auth.uid() or public.has_visibility(p_owner, 'holdings'));
$$;
grant execute on function public.get_holdings_for(uuid) to authenticated;

-- NB: REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a function's
-- implicit transaction block, so the function uses a non-concurrent refresh.
-- For higher-traffic production use, drop this function and refresh via a
-- scheduled job (pg_cron) that calls REFRESH ... CONCURRENTLY directly.
create or replace function public.refresh_holdings_view()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.holdings_view;
end;
$$;
revoke execute on function public.refresh_holdings_view() from public;

-- ----- reels -----
drop policy if exists reels_read   on public.reels;
drop policy if exists reels_write  on public.reels;
create policy reels_read on public.reels for select using (
  visibility = 'public'
  or author_id = auth.uid()
  or (visibility = 'followers' and exists (
        select 1 from public.follows
         where follower_id = auth.uid() and followee_id = reels.author_id
      ))
);
create policy reels_write on public.reels for all
  using (author_id = auth.uid()) with check (author_id = auth.uid());

-- ----- reel_tags -----
drop policy if exists reel_tags_read  on public.reel_tags;
drop policy if exists reel_tags_write on public.reel_tags;
create policy reel_tags_read on public.reel_tags for select using (
  exists (select 1 from public.reels r where r.id = reel_tags.reel_id)
);
create policy reel_tags_write on public.reel_tags for all using (
  exists (select 1 from public.reels r where r.id = reel_tags.reel_id and r.author_id = auth.uid())
) with check (
  exists (select 1 from public.reels r where r.id = reel_tags.reel_id and r.author_id = auth.uid())
);

-- ----- reel_mirrors -----
drop policy if exists reel_mirrors_read  on public.reel_mirrors;
drop policy if exists reel_mirrors_write on public.reel_mirrors;
create policy reel_mirrors_read  on public.reel_mirrors for select using (true);
create policy reel_mirrors_write on public.reel_mirrors for all
  using (mirrored_by = auth.uid()) with check (mirrored_by = auth.uid());

-- ----- reel_engagement -----
drop policy if exists reel_engagement_read  on public.reel_engagement;
drop policy if exists reel_engagement_write on public.reel_engagement;
create policy reel_engagement_read  on public.reel_engagement for select using (true);
create policy reel_engagement_write on public.reel_engagement for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- follows -----
drop policy if exists follows_read  on public.follows;
drop policy if exists follows_write on public.follows;
create policy follows_read  on public.follows for select using (true);
create policy follows_write on public.follows for all
  using (follower_id = auth.uid()) with check (follower_id = auth.uid());

-- ----- leagues -----
drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues for select using (true);

-- ----- league_members -----
drop policy if exists league_members_read  on public.league_members;
drop policy if exists league_members_write on public.league_members;
create policy league_members_read  on public.league_members for select using (true);
create policy league_members_write on public.league_members for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- chart_layouts -----
drop policy if exists chart_layouts_owner on public.chart_layouts;
create policy chart_layouts_owner on public.chart_layouts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ----- price_bars -----
-- Read-only cache, populated by Edge Function (service-role). Anyone can read.
drop policy if exists price_bars_read on public.price_bars;
create policy price_bars_read on public.price_bars for select using (true);

-- ============================================================
-- Done.
-- ============================================================
