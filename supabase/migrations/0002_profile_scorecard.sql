-- ============================================================
-- 0002_profile_scorecard.sql
--
-- Task #4 — Trader profile = quant scorecard with hybrid privacy.
--
-- Adds the visibility-aware accessors the new profile.html consumes,
-- a deterministic badge computation function, the follow-stats RPCs,
-- and tightens the paper_trades read policy so the holdings vs journal
-- visibility masks gate distinct slices of a trader's history:
--   - status='open'   → gated by visibility_mask.holdings
--   - status='closed' → gated by visibility_mask.journal
--
-- Re-runnable (every block uses CREATE OR REPLACE / DROP IF EXISTS).
-- ============================================================

-- ----- 1. Tighten paper_trades read policy ------------------------
--
-- Direct SELECT on paper_trades exposes the identifying columns (notes,
-- symbol, etc.). We let outsiders read open rows ONLY when the owner has
-- opted into `holdings`, and closed rows ONLY when `journal` is on.
-- Aggregate/derived metrics that don't reveal the journal narrative
-- (used to render the equity curve and quant tiles when ONLY the
-- equity_curve / metrics masks are on, but journal is off) flow through
-- a dedicated SECURITY DEFINER projection RPC further down.

drop policy if exists paper_trades_read    on public.paper_trades;
drop policy if exists paper_trades_write   on public.paper_trades;
create policy paper_trades_read on public.paper_trades for select using (
  owner_id = auth.uid()
  or (status = 'open'   and public.has_visibility(owner_id, 'holdings'))
  or (status = 'closed' and public.has_visibility(owner_id, 'journal'))
);
create policy paper_trades_write on public.paper_trades for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ----- 1b. Tighten strategies read policy -------------------------
--
-- The base table previously had `strategies_read_all` which let any
-- authenticated user enumerate every other user's strategy library
-- regardless of their visibility_mask.strategies setting. We restrict
-- to (owner | strategies-mask-on) here so the wrapper RPC and direct
-- SELECT enforce the same gate.

drop policy if exists strategies_read_all     on public.strategies;
drop policy if exists strategies_read         on public.strategies;
drop policy if exists strategies_write_owner  on public.strategies;
create policy strategies_read on public.strategies for select using (
  owner_id = auth.uid()
  or public.has_visibility(owner_id, 'strategies')
);
create policy strategies_write_owner on public.strategies for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ----- 2. Profile lookup by username (visibility-stripped) -------
--
-- Returns the public columns plus the owner's visibility_mask so the
-- client can decide which sub-cards to render. Sensitive columns
-- (is_admin, raw bio when private, etc.) are NOT exposed.

create or replace function public.get_profile_card(p_username text)
returns table (
  id              uuid,
  username        text,
  display_name    text,
  tier            text,
  type            text,
  university      text,   -- nulled out when visibility_mask.university = false (and viewer is not owner)
  bio             text,
  avatar_color    text,
  badges          text[],
  visibility_mask jsonb,
  joined_at       timestamptz
)
language sql stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.tier,
    p.type,
    case
      when p.id = auth.uid() then p.university
      when coalesce((p.visibility_mask->>'university')::boolean, true) then p.university
      else null
    end as university,
    p.bio,
    p.avatar_color,
    p.badges,
    p.visibility_mask,
    p.created_at
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
  limit 1;
$$;
revoke all on function public.get_profile_card(text) from public;
grant execute on function public.get_profile_card(text) to authenticated;

-- ----- 3. Closed-trade journal accessor --------------------------
--
-- Visibility-gated server-side accessor for the Journal tab. Returns
-- the closed paper_trades for an owner only when:
--   - the caller IS the owner, OR
--   - the owner has visibility_mask.journal = true.

create or replace function public.get_journal_for(p_owner uuid)
returns setof public.paper_trades
language sql stable
security definer
set search_path = public
as $$
  select *
    from public.paper_trades
   where owner_id = p_owner
     and status = 'closed'
     and (p_owner = auth.uid() or public.has_visibility(p_owner, 'journal'))
   order by closed_at desc nulls last, opened_at desc;
$$;
revoke all on function public.get_journal_for(uuid) from public;
grant execute on function public.get_journal_for(uuid) to authenticated;

-- ----- 3b. Performance-only projection ---------------------------
--
-- Returns the *minimum* fields the client needs to compute equity
-- curve + quant tiles (no `notes`, no `source_reel_id`, no `target` —
-- nothing journal-specific). Gated by `metrics OR equity_curve` so
-- a trader can publish their performance without revealing the
-- narrative behind each trade. Owner always sees their own data.

create or replace function public.get_perf_trades_for(p_owner uuid)
returns table (
  id          uuid,
  symbol      text,
  side        text,
  qty         numeric,
  entry_price numeric,
  exit_price  numeric,
  stop_loss   numeric,
  status      text,
  opened_at   timestamptz,
  closed_at   timestamptz
)
language sql stable
security definer
set search_path = public
as $$
  select pt.id, pt.symbol, pt.side, pt.qty,
         pt.entry_price, pt.exit_price, pt.stop_loss,
         pt.status, pt.opened_at, pt.closed_at
    from public.paper_trades pt
   where pt.owner_id = p_owner
     and pt.status   = 'closed'
     and (
       p_owner = auth.uid()
       or public.has_visibility(p_owner, 'metrics')
       or public.has_visibility(p_owner, 'equity_curve')
     )
   order by pt.closed_at asc nulls last;
$$;
revoke all on function public.get_perf_trades_for(uuid) from public;
grant execute on function public.get_perf_trades_for(uuid) to authenticated;

-- ----- 4. Strategies accessor (visibility-gated) -----------------
--
-- Today RLS on strategies is `read_all`, but the profile page only
-- shows them on the Strategies tab when visibility_mask.strategies =
-- true. This wrapper gives the client a single source of truth for
-- that gate without changing the global RLS contract (other surfaces
-- like the reel composer still read the table directly).

create or replace function public.get_strategies_for(p_owner uuid)
returns setof public.strategies
language sql stable
security definer
set search_path = public
as $$
  select *
    from public.strategies
   where owner_id = p_owner
     and (p_owner = auth.uid() or public.has_visibility(p_owner, 'strategies'))
   order by created_at desc;
$$;
revoke all on function public.get_strategies_for(uuid) from public;
grant execute on function public.get_strategies_for(uuid) to authenticated;

-- ----- 5. Follow graph helpers -----------------------------------

create or replace function public.get_follow_stats(p_owner uuid)
returns table (followers bigint, following bigint)
language sql stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.follows where followee_id = p_owner) as followers,
    (select count(*) from public.follows where follower_id = p_owner) as following;
$$;
revoke all on function public.get_follow_stats(uuid) from public;
grant execute on function public.get_follow_stats(uuid) to authenticated;

create or replace function public.am_following(p_target uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.follows
     where follower_id = auth.uid() and followee_id = p_target
  );
$$;
revoke all on function public.am_following(uuid) from public;
grant execute on function public.am_following(uuid) to authenticated;

create or replace function public.follow_user(p_target uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.follows (follower_id, followee_id)
  values (auth.uid(), p_target)
  on conflict do nothing;
$$;
revoke all on function public.follow_user(uuid) from public;
grant execute on function public.follow_user(uuid) to authenticated;

create or replace function public.unfollow_user(p_target uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.follows
   where follower_id = auth.uid()
     and followee_id = p_target;
$$;
revoke all on function public.unfollow_user(uuid) from public;
grant execute on function public.unfollow_user(uuid) to authenticated;

-- ============================================================
-- 6. Badges
--
-- Auto-issued on demand. Returns the union of:
--   - 100+ trades       — closed_trades >= 100
--   - 6 profitable mo   — at least 6 calendar months with positive net P&L
--   - top_sharpe_q3_26  — sharpe ratio rank in top 1% (computed against
--                         everyone with >= 30 closed trades) for the
--                         current quarter window. We approximate: badge
--                         is granted when sharpe >= 2.5 AND closed >= 30.
--                         (A real cron job replaces this with rank = 1.)
--   - mirror_master     — 50+ mirrors of this owner's reels
--   - strategy_curator  — 5+ published strategies
--
-- All inputs come from existing tables; no extra schema is required.
-- ============================================================

create or replace function public.compute_badges_for(p_owner uuid)
returns text[]
language plpgsql stable
security definer
set search_path = public
as $$
declare
  out_badges text[] := '{}';
  closed_n   int;
  profit_mo  int;
  sharpe_n   numeric;
  mirror_n   int;
  strat_n    int;
begin
  -- closed-trade count
  select count(*) into closed_n
    from public.paper_trades
   where owner_id = p_owner and status = 'closed';
  if closed_n >= 100 then
    out_badges := array_append(out_badges, '100_trades');
  end if;

  -- profitable months
  select count(*) into profit_mo from (
    select date_trunc('month', closed_at) as m,
           sum((coalesce(exit_price,0) - entry_price) * qty * case when side='buy' then 1 else -1 end) as pnl
      from public.paper_trades
     where owner_id = p_owner and status='closed' and closed_at is not null
     group by 1
    having sum((coalesce(exit_price,0) - entry_price) * qty * case when side='buy' then 1 else -1 end) > 0
  ) sub;
  if profit_mo >= 6 then
    out_badges := array_append(out_badges, '6_profitable_months');
  end if;

  -- approximate top-sharpe (cron will replace with true rank-1 query)
  if closed_n >= 30 then
    -- naive realised-pnl-per-trade std/mean as a proxy
    select case
             when stddev_samp(pnl) is null or stddev_samp(pnl) = 0 then null
             else avg(pnl) / stddev_samp(pnl) * sqrt(252)
           end into sharpe_n
      from (
        select (coalesce(exit_price,0) - entry_price) * qty * case when side='buy' then 1 else -1 end as pnl
          from public.paper_trades
         where owner_id = p_owner and status='closed'
      ) p;
    if sharpe_n is not null and sharpe_n >= 2.5 then
      out_badges := array_append(out_badges, 'top_sharpe_q3_26');
    end if;
  end if;

  -- mirror master
  select count(*) into mirror_n
    from public.reel_mirrors m
    join public.reels r on r.id = m.reel_id
   where r.author_id = p_owner;
  if mirror_n >= 50 then
    out_badges := array_append(out_badges, 'mirror_master');
  end if;

  -- strategy curator
  select count(*) into strat_n
    from public.strategies
   where owner_id = p_owner;
  if strat_n >= 5 then
    out_badges := array_append(out_badges, 'strategy_curator');
  end if;

  return out_badges;
end;
$$;
revoke all on function public.compute_badges_for(uuid) from public;
grant execute on function public.compute_badges_for(uuid) to authenticated;


-- ============================================================
-- 7. Cash balance accessor
--
-- The profile page shows a "Cash buffer" line whose visibility is
-- gated **only** by visibility_mask.cash. Computing it client-side
-- from get_perf_trades_for + holdings would conflate the cash mask
-- with the metrics / holdings masks (a trader with cash=true but
-- metrics=false would see a fabricated number). This RPC computes
-- it server-side and ignores every other mask.
--
-- Convention: starting capital is $100,000.
--   cash = 100000
--        + Σ realised P&L on closed trades
--        − Σ cost basis of currently open long positions
-- ============================================================

create or replace function public.get_cash_balance_for(p_owner uuid)
returns numeric
language sql stable
security definer
set search_path = public
as $$
  with realised as (
    select coalesce(sum(
      (coalesce(exit_price, 0) - entry_price) * qty *
      case when side = 'buy' then 1 else -1 end
    ), 0) as pnl
      from public.paper_trades
     where owner_id = p_owner
       and status = 'closed'
  ),
  open_cost as (
    -- Cost basis of currently-open long positions. We compute this
    -- directly from paper_trades rather than the materialised view
    -- so a stale refresh doesn't drift cash.
    select coalesce(sum(
      case when side = 'buy' then qty * entry_price else 0 end
      - case when side = 'sell' then qty * entry_price else 0 end
    ), 0) as cost
      from public.paper_trades
     where owner_id = p_owner
       and status = 'open'
  )
  select case
    when p_owner = auth.uid()
      or public.has_visibility(p_owner, 'cash')
    then 100000::numeric + (select pnl from realised) - (select cost from open_cost)
    else null
  end;
$$;
revoke all on function public.get_cash_balance_for(uuid) from public;
grant execute on function public.get_cash_balance_for(uuid) to authenticated;
