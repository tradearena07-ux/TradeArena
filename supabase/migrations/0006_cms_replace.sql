-- ============================================================================
-- TradeArena · CMS replacement (Task #17)
--
-- DESTRUCTIVE: drops the entire reels-based schools system from 0004 + the
-- text-lesson overlay from 0005, and replaces them with a flat, editable
-- CMS: schools (modules) → lessons (content + optional quiz JSON), plus
-- announcements and an admin-actions audit log.
--
-- Admin gate is now email-or-flag based: tradearena07@gmail.com OR any user
-- with profiles.is_admin = true counts as admin.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop old tables (CASCADE removes their policies + dependent FKs)
-- ----------------------------------------------------------------------------
drop table if exists public.school_module_overrides   cascade;
drop table if exists public.school_module_completions cascade;
drop table if exists public.school_lesson_progress    cascade;
drop table if exists public.user_perks                cascade;
drop table if exists public.challenge_completions     cascade;
drop table if exists public.quiz_attempts             cascade;
drop table if exists public.challenges                cascade;
drop table if exists public.quizzes                   cascade;
drop table if exists public.module_reels              cascade;
drop table if exists public.school_modules            cascade;
drop table if exists public.schools                   cascade;

-- ----------------------------------------------------------------------------
-- 2. Drop now-orphaned RPCs
-- ----------------------------------------------------------------------------
drop function if exists public.list_schools()                                     cascade;
drop function if exists public.get_school(uuid)                                   cascade;
drop function if exists public.get_module(uuid)                                   cascade;
drop function if exists public.submit_quiz(uuid, jsonb)                           cascade;
drop function if exists public.validate_challenge(uuid)                           cascade;
drop function if exists public.mark_lesson_complete(text, text)                   cascade;
drop function if exists public.complete_module(text, int)                         cascade;
drop function if exists public.get_my_school_progress()                           cascade;
drop function if exists public.admin_school_completion_stats()                    cascade;
drop function if exists public.admin_upsert_school_module_override(jsonb)         cascade;
drop function if exists public.admin_upsert_school(jsonb)                         cascade;
drop function if exists public.admin_upsert_module(jsonb)                         cascade;
drop function if exists public.admin_delete_school(uuid)                          cascade;
drop function if exists public.admin_delete_module(uuid)                          cascade;
drop function if exists public.admin_upsert_quiz(uuid, jsonb, int)                cascade;
drop function if exists public.admin_upsert_challenge(uuid, text, text, jsonb)    cascade;
drop function if exists public.admin_get_quiz(uuid)                               cascade;
drop function if exists public.admin_list_reels(text, int)                        cascade;
drop function if exists public.admin_set_module_reels(uuid, uuid[])               cascade;
drop function if exists public.seed_starter_schools()                             cascade;

-- ----------------------------------------------------------------------------
-- 3. Admin helper — email allow-list + profiles.is_admin
-- ----------------------------------------------------------------------------
create or replace function public.is_admin_user() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select lower(email) from auth.users where id = auth.uid())
      = 'tradearena07@gmail.com',
    false
  ) or exists(
    select 1 from public.profiles where id = auth.uid() and is_admin = true
  );
$$;
revoke all on function public.is_admin_user() from public;
grant execute on function public.is_admin_user() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. New tables
-- ----------------------------------------------------------------------------
create table public.schools (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  difficulty     text not null default 'Beginner',  -- Beginner | Intermediate | Advanced
  reward_capital int  not null default 0,
  order_index    int  not null default 0,
  published      boolean not null default false,
  created_at     timestamptz not null default now()
);
create index schools_pub_ord_idx on public.schools(published, order_index);

create table public.lessons (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  title       text not null,
  content     text,
  video_url   text,
  quiz        jsonb,                  -- [{q,choices[],correct,explain}] or null
  order_index int  not null default 0,
  created_at  timestamptz not null default now()
);
create index lessons_school_idx on public.lessons(school_id, order_index);

create table public.user_progress (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  lesson_id    uuid not null references public.lessons(id)  on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table public.school_completions (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  school_id     uuid not null references public.schools(id)  on delete cascade,
  reward_amount int  not null default 0,
  completed_at  timestamptz not null default now(),
  primary key (user_id, school_id)
);

create table public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  message    text not null,
  type       text not null default 'info',   -- info | warning | success
  published  boolean not null default true,
  created_at timestamptz not null default now()
);
create index announcements_pub_idx on public.announcements(published, created_at desc);

create table public.admin_actions (
  id             uuid primary key default gen_random_uuid(),
  admin_id       uuid references public.profiles(id) on delete set null,
  admin_email    text,
  action         text not null,                -- e.g. award_capital | reset_progress
  target_user_id uuid references public.profiles(id) on delete set null,
  target_email   text,
  amount         int,
  reason         text,
  created_at     timestamptz not null default now()
);
create index admin_actions_target_idx on public.admin_actions(target_user_id, action);

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------
alter table public.schools             enable row level security;
alter table public.lessons             enable row level security;
alter table public.user_progress       enable row level security;
alter table public.school_completions  enable row level security;
alter table public.announcements       enable row level security;
alter table public.admin_actions       enable row level security;

-- Schools: signed-in users see published; admins see all + can write
create policy schools_read on public.schools
  for select using (
    auth.uid() is not null
    and (published = true or public.is_admin_user())
  );
create policy schools_admin_write on public.schools
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- Lessons: visible iff parent school visible to a signed-in caller
create policy lessons_read on public.lessons
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.schools s
       where s.id = lessons.school_id
         and (s.published = true or public.is_admin_user())
    )
  );
create policy lessons_admin_write on public.lessons
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- User progress: each user sees + writes their own; admins read all
create policy up_self_read   on public.user_progress
  for select using (user_id = auth.uid() or public.is_admin_user());
create policy up_self_insert on public.user_progress
  for insert with check (user_id = auth.uid());
create policy up_admin_del   on public.user_progress
  for delete using (user_id = auth.uid() or public.is_admin_user());

-- School completions: read-only at the table; writes only via complete_lesson()
create policy sc_self_read on public.school_completions
  for select using (user_id = auth.uid() or public.is_admin_user());

-- Announcements: signed-in users read published; admins read+write all
create policy ann_read on public.announcements
  for select using (
    auth.uid() is not null
    and (published = true or public.is_admin_user())
  );
create policy ann_admin_write on public.announcements
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- Admin actions: admins only
create policy aa_admin on public.admin_actions
  for all using (public.is_admin_user()) with check (public.is_admin_user());

-- ----------------------------------------------------------------------------
-- 6. RPCs — user-facing
-- ----------------------------------------------------------------------------

-- Mark a lesson complete; if every lesson in the school is now done,
-- record school_completions (idempotent) and return the reward amount.
create or replace function public.complete_lesson(p_lesson_id uuid)
returns table (
  newly_completed_school boolean,
  reward_amount          int,
  total_lessons          int,
  completed_lessons      int
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id  uuid;
  v_total      int;
  v_done       int;
  v_reward     int := 0;
  v_inserted   int := 0;
  v_new_school boolean := false;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select school_id into v_school_id from public.lessons where id = p_lesson_id;
  if v_school_id is null then raise exception 'lesson not found'; end if;

  insert into public.user_progress(user_id, lesson_id)
       values (auth.uid(), p_lesson_id)
  on conflict do nothing;

  select count(*)::int into v_total from public.lessons where school_id = v_school_id;
  select count(*)::int into v_done
    from public.user_progress up
    join public.lessons l on l.id = up.lesson_id
   where l.school_id = v_school_id and up.user_id = auth.uid();

  if v_total > 0 and v_done >= v_total then
    select reward_capital into v_reward from public.schools where id = v_school_id;
    insert into public.school_completions(user_id, school_id, reward_amount)
         values (auth.uid(), v_school_id, coalesce(v_reward, 0))
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    v_new_school := v_inserted > 0;
  end if;

  return query select v_new_school, coalesce(v_reward, 0), v_total, v_done;
end $$;
revoke all on function public.complete_lesson(uuid) from public;
grant execute on function public.complete_lesson(uuid) to authenticated;

-- Snapshot of the caller's progress + total earned bonus (school + admin grants)
create or replace function public.get_my_progress()
returns table (
  lesson_ids   uuid[],
  school_ids   uuid[],
  total_bonus  int
)
language sql security definer set search_path = public, pg_temp as $$
  select
    coalesce((select array_agg(lesson_id) from public.user_progress
              where user_id = auth.uid()), '{}'::uuid[]),
    coalesce((select array_agg(school_id) from public.school_completions
              where user_id = auth.uid()), '{}'::uuid[]),
    coalesce((select sum(reward_amount)::int from public.school_completions
              where user_id = auth.uid()), 0)
      + coalesce((select sum(amount)::int from public.admin_actions
                   where action = 'award_capital'
                     and target_user_id = auth.uid()), 0);
$$;
revoke all on function public.get_my_progress() from public;
grant execute on function public.get_my_progress() to authenticated;

-- ----------------------------------------------------------------------------
-- 7. RPCs — admin
-- ----------------------------------------------------------------------------

-- Award bonus paper-capital to a user (looked up by email).
-- Records an admin_actions row that the cash-balance overlay sums in.
create or replace function public.admin_award_capital(
  p_target_email text, p_amount int, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_target uuid; v_admin_email text;
begin
  if not public.is_admin_user() then raise exception 'admin only'; end if;
  if p_amount is null then raise exception 'amount required'; end if;

  select email into v_admin_email from auth.users where id = auth.uid();
  select id    into v_target      from auth.users where lower(email) = lower(p_target_email);

  insert into public.admin_actions(
    admin_id, admin_email, action, target_user_id, target_email, amount, reason
  ) values (
    auth.uid(), v_admin_email, 'award_capital', v_target, p_target_email,
    p_amount, p_reason
  );
end $$;
revoke all on function public.admin_award_capital(text, int, text) from public;
grant execute on function public.admin_award_capital(text, int, text) to authenticated;

-- All users + their bonus + completion stats (for the leaderboard tab).
create or replace function public.admin_list_users()
returns table (
  user_id           uuid,
  email             text,
  username          text,
  university        text,
  tier              text,
  total_bonus       int,
  schools_completed int,
  lessons_completed int,
  joined_at         timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin_user() then raise exception 'admin only'; end if;
  return query
    select
      p.id,
      u.email,
      p.username,
      p.university,
      p.tier,
      (coalesce((select sum(amount)::int from public.admin_actions
                  where action = 'award_capital' and target_user_id = p.id), 0)
       + coalesce((select sum(reward_amount)::int from public.school_completions
                    where user_id = p.id), 0)),
      coalesce((select count(*)::int from public.school_completions where user_id = p.id), 0),
      coalesce((select count(*)::int from public.user_progress       where user_id = p.id), 0),
      u.created_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by u.created_at desc;
end $$;
revoke all on function public.admin_list_users() from public;
grant execute on function public.admin_list_users() to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Cash-balance overlay — replace the 0005 version that referenced the
--    now-dropped school_module_completions table.
-- ----------------------------------------------------------------------------
create or replace function public.get_cash_balance_for(p_owner uuid)
returns numeric
language sql stable security definer set search_path = public as $$
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
  school_bonus as (
    select coalesce(sum(reward_amount), 0)::numeric as bonus
      from public.school_completions
     where user_id = p_owner
  ),
  admin_bonus as (
    select coalesce(sum(amount), 0)::numeric as bonus
      from public.admin_actions
     where action = 'award_capital'
       and target_user_id = p_owner
  )
  select case
    when p_owner = auth.uid()
      or public.has_visibility(p_owner, 'cash')
    then 100000::numeric
       + (select pnl   from realised)
       - (select cost  from open_cost)
       + (select bonus from school_bonus)
       + (select bonus from admin_bonus)
    else null
  end;
$$;
revoke all on function public.get_cash_balance_for(uuid) from public;
grant execute on function public.get_cash_balance_for(uuid) to authenticated;
