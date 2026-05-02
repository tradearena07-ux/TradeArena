-- ============================================================================
-- TradeArena · Lesson-based School (Task #16)
--
-- This sits ALONGSIDE the reel-based schools/modules from 0004. The new
-- model is text-lesson driven: 6 hard-coded modules in JS, each with 4-5
-- reading lessons, each module rewards paper capital on completion.
--
-- Tables:
--   school_lesson_progress   - one row per (user, lesson_key)
--   school_module_completions - idempotent module completion + reward
--   school_module_overrides   - admin content edits (override JS defaults)
--
-- All cross-user writes go through SECURITY DEFINER RPCs.
-- get_cash_balance_for is overlaid here to add reward credits.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
create table if not exists public.school_lesson_progress (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  module_key   text not null,
  lesson_key   text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_key)
);
create index if not exists slp_user_module_idx
  on public.school_lesson_progress(user_id, module_key);

create table if not exists public.school_module_completions (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  module_key     text not null,
  reward_amount  int  not null default 0,
  completed_at   timestamptz not null default now(),
  primary key (user_id, module_key)
);
create index if not exists smc_module_idx
  on public.school_module_completions(module_key);

create table if not exists public.school_module_overrides (
  module_key     text primary key,
  title          text,
  summary        text,
  reward_amount  int,
  lessons        jsonb,   -- [{key,title,content,minutes}] when admin edits
  updated_by     uuid references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. RLS — read-only at the table layer; writes via RPC
-- ----------------------------------------------------------------------------
alter table public.school_lesson_progress    enable row level security;
alter table public.school_module_completions enable row level security;
alter table public.school_module_overrides   enable row level security;

drop policy if exists slp_self_read  on public.school_lesson_progress;
drop policy if exists smc_self_read  on public.school_module_completions;
drop policy if exists smo_read       on public.school_module_overrides;

create policy slp_self_read on public.school_lesson_progress
  for select using (user_id = auth.uid());
create policy smc_self_read on public.school_module_completions
  for select using (user_id = auth.uid());
create policy smo_read on public.school_module_overrides
  for select using (auth.role() = 'authenticated');

-- ----------------------------------------------------------------------------
-- 3. User-facing RPCs
-- ----------------------------------------------------------------------------
create or replace function public.mark_lesson_complete(
  p_module_key text, p_lesson_key text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_lesson_key is null or length(trim(p_lesson_key)) = 0
     or p_module_key is null or length(trim(p_module_key)) = 0 then
    raise exception 'invalid lesson/module key';
  end if;
  insert into public.school_lesson_progress(user_id, module_key, lesson_key)
       values (auth.uid(), p_module_key, p_lesson_key)
  on conflict (user_id, lesson_key) do nothing;
end $$;
revoke all on function public.mark_lesson_complete(text,text) from public;
grant execute on function public.mark_lesson_complete(text,text) to authenticated;

-- Idempotent: first call inserts and grants reward; subsequent calls are no-ops.
-- Returns the row that ended up persisted so the client can show "you earned X".
create or replace function public.complete_module(
  p_module_key text, p_reward int
) returns table (
  module_key text, reward_amount int, completed_at timestamptz, was_new boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_was_new boolean := false;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.school_module_completions(user_id, module_key, reward_amount)
       values (auth.uid(), p_module_key, greatest(0, coalesce(p_reward,0)))
  on conflict (user_id, module_key) do nothing;
  get diagnostics v_was_new = row_count;
  return query
    select smc.module_key, smc.reward_amount, smc.completed_at, (v_was_new > 0)
      from public.school_module_completions smc
     where smc.user_id = auth.uid() and smc.module_key = p_module_key;
end $$;
revoke all on function public.complete_module(text,int) from public;
grant execute on function public.complete_module(text,int) to authenticated;

create or replace function public.get_my_school_progress()
returns table (
  lesson_keys text[], module_keys text[], total_reward int
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce((select array_agg(lesson_key) from public.school_lesson_progress
              where user_id = auth.uid()), '{}'::text[]),
    coalesce((select array_agg(module_key) from public.school_module_completions
              where user_id = auth.uid()), '{}'::text[]),
    coalesce((select sum(reward_amount)::int from public.school_module_completions
              where user_id = auth.uid()), 0);
$$;
revoke all on function public.get_my_school_progress() from public;
grant execute on function public.get_my_school_progress() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Admin RPCs
-- ----------------------------------------------------------------------------
create or replace function public.admin_school_completion_stats()
returns table (module_key text, learners int, completions int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  return query
    select
      lp.module_key,
      count(distinct lp.user_id)::int as learners,
      coalesce((select count(*)::int
                  from public.school_module_completions c
                 where c.module_key = lp.module_key), 0) as completions
      from public.school_lesson_progress lp
     group by lp.module_key
     order by lp.module_key;
end $$;
revoke all on function public.admin_school_completion_stats() from public;
grant execute on function public.admin_school_completion_stats() to authenticated;

create or replace function public.admin_upsert_school_module_override(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  if p ->> 'module_key' is null then raise exception 'module_key required'; end if;
  insert into public.school_module_overrides(
    module_key, title, summary, reward_amount, lessons, updated_by
  ) values (
    p ->> 'module_key',
    nullif(p ->> 'title', ''),
    nullif(p ->> 'summary', ''),
    nullif(p ->> 'reward_amount', '')::int,
    case when p ? 'lessons' then p -> 'lessons' else null end,
    auth.uid()
  )
  on conflict (module_key) do update set
    title         = coalesce(excluded.title,         public.school_module_overrides.title),
    summary       = coalesce(excluded.summary,       public.school_module_overrides.summary),
    reward_amount = coalesce(excluded.reward_amount, public.school_module_overrides.reward_amount),
    lessons       = coalesce(excluded.lessons,       public.school_module_overrides.lessons),
    updated_by    = auth.uid(),
    updated_at    = now();
end $$;
revoke all on function public.admin_upsert_school_module_override(jsonb) from public;
grant execute on function public.admin_upsert_school_module_override(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Cash-balance overlay — credit completed-module rewards
-- ----------------------------------------------------------------------------
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
     where owner_id = p_owner and status = 'closed'
  ),
  open_cost as (
    select coalesce(sum(
      case when side = 'buy'  then qty * entry_price else 0 end
      - case when side = 'sell' then qty * entry_price else 0 end
    ), 0) as cost
      from public.paper_trades
     where owner_id = p_owner and status = 'open'
  ),
  rewards as (
    select coalesce(sum(reward_amount), 0)::numeric as bonus
      from public.school_module_completions
     where user_id = p_owner
  )
  select case
    when p_owner = auth.uid()
      or public.has_visibility(p_owner, 'cash')
    then 100000::numeric
       + (select pnl   from realised)
       - (select cost  from open_cost)
       + (select bonus from rewards)
    else null
  end;
$$;
revoke all on function public.get_cash_balance_for(uuid) from public;
grant execute on function public.get_cash_balance_for(uuid) to authenticated;
