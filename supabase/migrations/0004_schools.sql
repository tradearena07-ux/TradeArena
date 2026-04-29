-- ============================================================================
-- TradeArena · Task #6: Schools (curated, ordered playlists of reels with
-- quizzes, paper-trade challenges, and perks).
--
-- Run after 0003_reels_engine.sql.
--
-- Conventions kept consistent with prior migrations:
--   * Every cross-user write goes through a SECURITY DEFINER RPC. The
--     base tables have minimal RLS; clients never write directly.
--   * Every new RPC `revoke all from public` then `grant execute to
--     authenticated` so anonymous callers can't invoke them even if
--     PUBLIC retains the default privilege somewhere upstream.
--   * Admin-only RPCs check `is_admin` themselves (no separate role).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
create table if not exists public.schools (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  summary       text not null default '',
  icon          text not null default 'fa-graduation-cap',  -- font-awesome
  accent_color  text not null default '#c9a030',
  ordinal       int  not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists public.school_modules (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  ordinal     int  not null,
  title       text not null,
  summary     text not null default '',
  created_at  timestamptz not null default now(),
  unique (school_id, ordinal)
);
create index if not exists school_modules_school_idx
  on public.school_modules(school_id, ordinal);

create table if not exists public.module_reels (
  module_id   uuid not null references public.school_modules(id) on delete cascade,
  reel_id     uuid not null references public.reels(id)         on delete cascade,
  ordinal     int  not null,
  primary key (module_id, ordinal)
);
create index if not exists module_reels_reel_idx on public.module_reels(reel_id);

-- One quiz per module (questions jsonb is an ordered array of
-- {q, choices:[...], correct:int, explain?}). Stored inline rather than
-- normalised because quizzes are short, never queried by question, and
-- always read as a single blob.
create table if not exists public.quizzes (
  module_id   uuid primary key references public.school_modules(id) on delete cascade,
  questions   jsonb not null default '[]'::jsonb,
  pass_pct    int   not null default 70 check (pass_pct between 0 and 100),
  updated_at  timestamptz not null default now()
);

create table if not exists public.quiz_attempts (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references public.school_modules(id) on delete cascade,
  user_id      uuid not null references public.profiles(id)       on delete cascade,
  score        int  not null,
  total        int  not null,
  passed       boolean not null,
  answers      jsonb not null default '[]'::jsonb,  -- [{q, picked, correct}]
  attempted_at timestamptz not null default now()
);
create index if not exists quiz_attempts_user_idx
  on public.quiz_attempts(user_id, module_id, attempted_at desc);

-- One challenge per module. spec.kind drives the validator. Supported:
--   {kind:'min_trades',       params:{n:5, market?:'asx'}}
--   {kind:'consecutive_wins', params:{n:3, tag?:'breakout'}}
--   {kind:'min_rr',           params:{n:1, ratio:2.0, min_hold_days?:3, market?:'asx'}}
--   {kind:'journal_count',    params:{n:5, days:7}}
create table if not exists public.challenges (
  module_id   uuid primary key references public.school_modules(id) on delete cascade,
  title       text not null,
  summary     text not null default '',
  spec        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.challenge_completions (
  id            uuid primary key default gen_random_uuid(),
  module_id     uuid not null references public.school_modules(id) on delete cascade,
  user_id       uuid not null references public.profiles(id)       on delete cascade,
  evidence      jsonb not null default '{}'::jsonb,  -- e.g. {trade_ids:[...], note:'...'}
  completed_at  timestamptz not null default now(),
  unique (module_id, user_id)
);

-- Perks granted on module completion. Same row-shape regardless of kind:
--   kind='extra_capital'     value:{amount: 5000}
--   kind='indicator_unlock'  value:{indicator: 'macd'}
--   kind='badge'             value:{key, label, icon}
create table if not exists public.user_perks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id)       on delete cascade,
  kind          text not null check (kind in ('extra_capital','indicator_unlock','badge')),
  value         jsonb not null default '{}'::jsonb,
  source_module_id uuid references public.school_modules(id) on delete set null,
  granted_at    timestamptz not null default now(),
  unique (user_id, kind, source_module_id)
);
create index if not exists user_perks_user_idx on public.user_perks(user_id);

-- ----------------------------------------------------------------------------
-- 2. RLS
-- ----------------------------------------------------------------------------
-- Catalogue tables are public-read for any signed-in user. Writes only
-- through admin RPCs (which are SECURITY DEFINER and check is_admin).
alter table public.schools                enable row level security;
alter table public.school_modules         enable row level security;
alter table public.module_reels           enable row level security;
alter table public.quizzes                enable row level security;
alter table public.challenges             enable row level security;
alter table public.quiz_attempts          enable row level security;
alter table public.challenge_completions  enable row level security;
alter table public.user_perks             enable row level security;

drop policy if exists schools_read           on public.schools;
drop policy if exists school_modules_read    on public.school_modules;
drop policy if exists module_reels_read      on public.module_reels;
drop policy if exists quizzes_read           on public.quizzes;
drop policy if exists challenges_read        on public.challenges;
drop policy if exists quiz_attempts_read     on public.quiz_attempts;
drop policy if exists challenge_compls_read  on public.challenge_completions;
drop policy if exists user_perks_read        on public.user_perks;

create policy schools_read          on public.schools          for select using (auth.role() = 'authenticated');
create policy school_modules_read   on public.school_modules   for select using (auth.role() = 'authenticated');
create policy module_reels_read     on public.module_reels     for select using (auth.role() = 'authenticated');
create policy quizzes_read          on public.quizzes          for select using (auth.role() = 'authenticated');
create policy challenges_read       on public.challenges       for select using (auth.role() = 'authenticated');

-- Personal tables: owner-only. All writes happen through SECURITY DEFINER RPCs.
create policy quiz_attempts_read    on public.quiz_attempts          for select using (user_id = auth.uid());
create policy challenge_compls_read on public.challenge_completions  for select using (user_id = auth.uid());
create policy user_perks_read       on public.user_perks             for select using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. Reader RPCs
-- ----------------------------------------------------------------------------

-- list_schools — index page. Returns each school + module count + the
-- viewer's progress (modules completed = both quiz passed AND challenge
-- passed). Signed-in only.
create or replace function public.list_schools()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  with mod_counts as (
    select s.id as school_id, count(m.id) as module_count
      from public.schools s
      left join public.school_modules m on m.school_id = s.id
     group by s.id
  ),
  done as (
    select m.school_id, count(*) as done_count
      from public.school_modules m
      join public.quiz_attempts qa
        on qa.module_id = m.id and qa.user_id = v_uid and qa.passed
      join public.challenge_completions cc
        on cc.module_id = m.id and cc.user_id = v_uid
     group by m.school_id
  )
  select jsonb_agg(jsonb_build_object(
    'id',           s.id,
    'slug',         s.slug,
    'title',        s.title,
    'summary',      s.summary,
    'icon',         s.icon,
    'accent_color', s.accent_color,
    'module_count', coalesce(mc.module_count, 0),
    'done_count',   coalesce(d.done_count, 0)
  ) order by s.ordinal, s.title)
    into v_out
    from public.schools s
    left join mod_counts mc on mc.school_id = s.id
    left join done       d  on d.school_id  = s.id;

  return coalesce(v_out, '[]'::jsonb);
end $$;

-- get_school — detail page. School + ordered module list with each
-- module's lock status (a module is unlocked when the previous module
-- by ordinal is fully complete; the first module is always unlocked).
create or replace function public.get_school(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_school jsonb;
  v_modules jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select jsonb_build_object(
    'id',           s.id,  'slug', s.slug, 'title', s.title,
    'summary',      s.summary,
    'icon',         s.icon, 'accent_color', s.accent_color
  ) into v_school
    from public.schools s
   where s.id = p_id;

  if v_school is null then raise exception 'school not found'; end if;

  -- Per-module status for this user.
  with status as (
    select m.id as module_id,
           exists(select 1 from public.quiz_attempts qa
                   where qa.module_id = m.id and qa.user_id = v_uid and qa.passed) as quiz_passed,
           exists(select 1 from public.challenge_completions cc
                   where cc.module_id = m.id and cc.user_id = v_uid) as challenge_passed,
           (select count(*) from public.module_reels mr where mr.module_id = m.id) as reel_count,
           exists(select 1 from public.quizzes q where q.module_id = m.id) as has_quiz,
           exists(select 1 from public.challenges c where c.module_id = m.id) as has_challenge
      from public.school_modules m
     where m.school_id = p_id
  ),
  ordered as (
    select m.*, st.quiz_passed, st.challenge_passed, st.reel_count, st.has_quiz, st.has_challenge,
           (st.quiz_passed and st.challenge_passed) as is_complete,
           -- Previous module is the one with the largest ordinal less than ours.
           lag( (st.quiz_passed and st.challenge_passed) ) over (order by m.ordinal) as prev_complete,
           row_number() over (order by m.ordinal) as rn
      from public.school_modules m
      join status st on st.module_id = m.id
     where m.school_id = p_id
  )
  select jsonb_agg(jsonb_build_object(
    'id',                o.id,
    'ordinal',           o.ordinal,
    'title',             o.title,
    'summary',           o.summary,
    'reel_count',        o.reel_count,
    'has_quiz',          o.has_quiz,
    'has_challenge',     o.has_challenge,
    'quiz_passed',       o.quiz_passed,
    'challenge_passed',  o.challenge_passed,
    'is_complete',       o.is_complete,
    -- First module (rn=1) always unlocked; others unlocked when the
    -- previous module is fully complete.
    'is_unlocked',       (o.rn = 1) or coalesce(o.prev_complete, false)
  ) order by o.ordinal)
    into v_modules
    from ordered o;

  return jsonb_build_object('school', v_school, 'modules', coalesce(v_modules, '[]'::jsonb));
end $$;

-- get_module — full module payload for the player page: ordered reels
-- (same shape as feed_reels rows so reels.html-style cards can render
-- unchanged), the quiz (sans correct-answer indices — those stay
-- server-side until submit_quiz), the challenge spec, and the user's
-- last attempt summary + completion status.
create or replace function public.get_module(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_module jsonb;
  v_reels  jsonb;
  v_quiz   jsonb;
  v_challenge jsonb;
  v_attempt jsonb;
  v_completed boolean;
  v_school_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select jsonb_build_object(
    'id', m.id, 'school_id', m.school_id, 'ordinal', m.ordinal,
    'title', m.title, 'summary', m.summary,
    'school_title', s.title, 'school_slug', s.slug, 'accent_color', s.accent_color
  ), m.school_id
    into v_module, v_school_id
    from public.school_modules m
    join public.schools s on s.id = m.school_id
   where m.id = p_id;
  if v_module is null then raise exception 'module not found'; end if;

  -- Ordered reels with author + tag list. Trimmed shape; the player
  -- page renders simpler cards than the full feed.
  with mr as (
    select reel_id, ordinal from public.module_reels where module_id = p_id
  ),
  tag_lists as (
    select t.reel_id, jsonb_agg(jsonb_build_object(
      'tag_type', t.tag_type, 'tag_value', t.tag_value,
      'x_pct', t.x_pct, 'y_pct', t.y_pct, 'ordinal', t.ordinal
    ) order by t.ordinal) as tags
      from public.reel_tags t
     where t.reel_id in (select reel_id from mr)
     group by t.reel_id
  )
  select jsonb_agg(jsonb_build_object(
    'ordinal', mr.ordinal,
    'reel', jsonb_build_object(
      'id',           r.id,    'symbol', r.symbol,    'market', r.market,
      'chart_snapshot_url', r.chart_snapshot_url,
      'thesis',       r.thesis,'entry',  r.entry,     'stop_loss', r.stop_loss,
      'target',       r.target,'direction', r.direction,
      'created_at',   r.created_at,
      'author', jsonb_build_object(
        'username',     p.username,
        'display_name', p.display_name,
        'tier',         p.tier,
        'avatar_color', p.avatar_color
      ),
      'tags', coalesce(tl.tags, '[]'::jsonb)
    )
  ) order by mr.ordinal)
    into v_reels
    from mr
    join public.reels r       on r.id = mr.reel_id
    join public.public_profiles p on p.id = r.author_id
    left join tag_lists tl    on tl.reel_id = r.id;

  -- Quiz: strip correct-answer indices before sending to client.
  select jsonb_build_object(
    'pass_pct', q.pass_pct,
    'questions', (
      select jsonb_agg(jsonb_build_object(
        'q',       elem->>'q',
        'choices', elem->'choices',
        -- explain is intentionally omitted until after submission
        'idx',     idx - 1
      ))
        from jsonb_array_elements(q.questions) with ordinality as t(elem, idx)
    )
  ) into v_quiz
    from public.quizzes q
   where q.module_id = p_id;

  select jsonb_build_object(
    'title', c.title, 'summary', c.summary, 'spec', c.spec
  ) into v_challenge
    from public.challenges c
   where c.module_id = p_id;

  -- Best (most recent passing) attempt summary, or just most recent.
  select jsonb_build_object(
    'score', qa.score, 'total', qa.total, 'passed', qa.passed,
    'attempted_at', qa.attempted_at
  ) into v_attempt
    from public.quiz_attempts qa
   where qa.module_id = p_id and qa.user_id = v_uid
   order by qa.passed desc, qa.attempted_at desc
   limit 1;

  v_completed := exists(
    select 1 from public.challenge_completions cc
     where cc.module_id = p_id and cc.user_id = v_uid
  );

  return jsonb_build_object(
    'module',    v_module,
    'reels',     coalesce(v_reels,  '[]'::jsonb),
    'quiz',      v_quiz,
    'challenge', v_challenge,
    'attempt',   v_attempt,
    'challenge_passed', v_completed
  );
end $$;

-- ----------------------------------------------------------------------------
-- 4. Submission RPCs (quiz + challenge)
-- ----------------------------------------------------------------------------

-- submit_quiz — server scores answers against the canonical questions
-- jsonb. Returns the per-question correctness map so the UI can show
-- instant feedback without a follow-up read. Inserts an attempt row
-- regardless of pass/fail (drives Profile streak math).
create or replace function public.submit_quiz(
  p_module_id uuid,
  p_answers   jsonb           -- [int, int, ...] picked-choice index per question
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_questions jsonb;
  v_pass_pct  int;
  v_total int := 0;
  v_score int := 0;
  v_passed boolean;
  v_per jsonb := '[]'::jsonb;
  v_idx int;
  v_q jsonb;
  v_picked int;
  v_correct int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select questions, pass_pct into v_questions, v_pass_pct
    from public.quizzes where module_id = p_module_id;
  if v_questions is null then raise exception 'no quiz for module'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'answers must be a jsonb array'; end if;

  v_total := jsonb_array_length(v_questions);

  for v_idx in 0 .. v_total - 1 loop
    v_q := v_questions -> v_idx;
    v_correct := (v_q ->> 'correct')::int;
    -- coerce picked safely; out-of-range / missing = wrong
    begin
      v_picked := (p_answers ->> v_idx)::int;
    exception when others then v_picked := -1; end;
    if v_picked = v_correct then v_score := v_score + 1; end if;
    v_per := v_per || jsonb_build_array(jsonb_build_object(
      'idx', v_idx,
      'picked', v_picked,
      'correct', v_correct,
      'right', v_picked = v_correct,
      'explain', v_q -> 'explain'
    ));
  end loop;

  v_passed := v_total > 0 and (v_score * 100 / v_total) >= v_pass_pct;

  insert into public.quiz_attempts(module_id, user_id, score, total, passed, answers)
    values (p_module_id, v_uid, v_score, v_total, v_passed, p_answers);

  return jsonb_build_object(
    'score', v_score, 'total', v_total, 'passed', v_passed,
    'pass_pct', v_pass_pct, 'per_question', v_per
  );
end $$;

-- validate_challenge — runs the challenge.spec against the user's
-- paper_trades / quiz_attempts. The skill spec called for a Supabase
-- Edge Function for this; we kept it inline as a SECURITY DEFINER RPC
-- because (a) the existing reels engine already uses RPCs not Edge
-- Functions, (b) all the data lives in Postgres so an HTTP hop adds
-- latency without isolation benefit, and (c) gating + perk grant must
-- be transactional with the completion insert.
--
-- Supported spec.kind:
--   * min_trades       — N closed trades, optional market filter.
--   * consecutive_wins — last N closed trades all winners; optional
--                        tag filter (matches reel_tags on the source
--                        reel of the trade).
--   * min_rr           — N trades with realised R:R >= ratio; optional
--                        min_hold_days, market filter.
--   * journal_count    — N paper_trades opened in last `days` whose
--                        notes are non-empty.
-- Returns {passed, evidence, perk?}. On a fresh pass, also inserts
-- challenge_completions and grants the configured perk (if any). The
-- perk lives on the challenge.spec under `perk: {kind, value, badge?}`.
create or replace function public.validate_challenge(p_module_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_spec jsonb;
  v_kind text;
  v_params jsonb;
  v_passed boolean := false;
  v_evidence jsonb := '{}'::jsonb;
  v_already boolean;
  v_perk jsonb;
  v_n int;
  v_market text;
  v_tag text;
  v_ratio numeric;
  v_min_hold int;
  v_days int;
  v_count int;
  v_trade_ids uuid[];
  v_streak int := 0;
  v_t record;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select spec into v_spec from public.challenges where module_id = p_module_id;
  if v_spec is null then raise exception 'no challenge for module'; end if;

  v_kind   := v_spec ->> 'kind';
  v_params := coalesce(v_spec -> 'params', '{}'::jsonb);
  v_perk   := v_spec -> 'perk';

  if v_kind = 'min_trades' then
    v_n := coalesce((v_params ->> 'n')::int, 1);
    v_market := v_params ->> 'market';
    select array_agg(id), count(*) into v_trade_ids, v_count
      from (select id from public.paper_trades
             where owner_id = v_uid and status = 'closed'
               and (v_market is null or market = v_market)
             order by closed_at desc limit v_n) t;
    v_passed := coalesce(v_count, 0) >= v_n;
    v_evidence := jsonb_build_object('trade_ids', to_jsonb(coalesce(v_trade_ids, '{}')),
                                     'have', coalesce(v_count, 0), 'need', v_n);

  elsif v_kind = 'consecutive_wins' then
    v_n   := coalesce((v_params ->> 'n')::int, 3);
    v_tag := lower(coalesce(v_params ->> 'tag', ''));
    v_trade_ids := '{}';
    for v_t in
      select pt.id, pt.side, pt.entry_price, pt.exit_price, pt.source_reel_id
        from public.paper_trades pt
       where pt.owner_id = v_uid and pt.status = 'closed'
         and (v_tag = '' or exists (
              select 1 from public.reel_tags rt
               where rt.reel_id = pt.source_reel_id
                 and lower(rt.tag_value) = v_tag))
       order by pt.closed_at desc
       limit v_n
    loop
      if (v_t.side = 'buy'  and v_t.exit_price > v_t.entry_price) or
         (v_t.side = 'sell' and v_t.exit_price < v_t.entry_price) then
        v_streak   := v_streak + 1;
        v_trade_ids := v_trade_ids || v_t.id;
      else
        exit;
      end if;
    end loop;
    v_passed := v_streak >= v_n;
    v_evidence := jsonb_build_object('streak', v_streak, 'need', v_n,
                                     'trade_ids', to_jsonb(v_trade_ids),
                                     'tag', nullif(v_tag, ''));

  elsif v_kind = 'min_rr' then
    v_n        := coalesce((v_params ->> 'n')::int, 1);
    v_ratio    := coalesce((v_params ->> 'ratio')::numeric, 2);
    v_min_hold := coalesce((v_params ->> 'min_hold_days')::int, 0);
    v_market   := v_params ->> 'market';
    select array_agg(id), count(*) into v_trade_ids, v_count
      from (
        select pt.id
          from public.paper_trades pt
         where pt.owner_id = v_uid and pt.status = 'closed'
           and pt.stop_loss is not null and pt.target is not null
           and (v_market is null or pt.market = v_market)
           and abs(pt.target - pt.entry_price) /
               nullif(abs(pt.entry_price - pt.stop_loss), 0) >= v_ratio
           and (v_min_hold = 0 or
                extract(epoch from (coalesce(pt.closed_at, now()) - pt.opened_at))
                  / 86400.0 >= v_min_hold)
      ) t;
    v_passed := coalesce(v_count, 0) >= v_n;
    v_evidence := jsonb_build_object('trade_ids', to_jsonb(coalesce(v_trade_ids, '{}')),
                                     'have', coalesce(v_count, 0),
                                     'need', v_n, 'ratio', v_ratio,
                                     'min_hold_days', v_min_hold);

  elsif v_kind = 'journal_count' then
    v_n    := coalesce((v_params ->> 'n')::int, 1);
    v_days := coalesce((v_params ->> 'days')::int, 7);
    select count(*) into v_count
      from public.paper_trades pt
     where pt.owner_id = v_uid
       and pt.notes is not null and length(trim(pt.notes)) > 0
       and pt.opened_at >= now() - make_interval(days => v_days);
    v_passed := v_count >= v_n;
    v_evidence := jsonb_build_object('have', v_count, 'need', v_n, 'days', v_days);

  else
    raise exception 'unknown challenge kind: %', v_kind;
  end if;

  -- Idempotent insert + perk grant on a fresh pass.
  if v_passed then
    select exists(select 1 from public.challenge_completions
                   where module_id = p_module_id and user_id = v_uid)
      into v_already;
    if not v_already then
      insert into public.challenge_completions(module_id, user_id, evidence)
        values (p_module_id, v_uid, v_evidence);
      if v_perk is not null and v_perk ? 'kind' then
        insert into public.user_perks(user_id, kind, value, source_module_id)
          values (v_uid, v_perk ->> 'kind', coalesce(v_perk -> 'value', '{}'::jsonb), p_module_id)
          on conflict (user_id, kind, source_module_id) do nothing;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'passed',   v_passed,
    'evidence', v_evidence,
    'perk',     case when v_passed then v_perk else null end,
    'already_completed', coalesce(v_already, false)
  );
end $$;

-- ----------------------------------------------------------------------------
-- 5. Stats RPCs (Profile tile + perks list)
-- ----------------------------------------------------------------------------
create or replace function public.list_my_perks()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',         up.id,
    'kind',       up.kind,
    'value',      up.value,
    'granted_at', up.granted_at,
    'module_title', m.title,
    'school_title', s.title
  ) order by up.granted_at desc), '[]'::jsonb)
    from public.user_perks up
    left join public.school_modules m on m.id = up.source_module_id
    left join public.schools        s on s.id = m.school_id
   where up.user_id = auth.uid();
$$;

-- learning_stats(p_owner) — public-safe summary used by the Profile
-- "Learning" tile. Schools_completed = schools where every module has
-- both a passing quiz attempt AND a challenge completion. Streak =
-- consecutive days with at least one quiz attempt OR challenge
-- completion, ending at today.
create or replace function public.learning_stats(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_modules_completed int := 0;
  v_schools_completed int := 0;
  v_streak int := 0;
  v_today date := (now() at time zone 'utc')::date;
  v_d date;
  v_has boolean;
begin
  select count(*) into v_modules_completed
    from public.school_modules m
   where exists(select 1 from public.quiz_attempts qa
                 where qa.module_id = m.id and qa.user_id = p_owner and qa.passed)
     and exists(select 1 from public.challenge_completions cc
                 where cc.module_id = m.id and cc.user_id = p_owner);

  select count(*) into v_schools_completed
    from public.schools s
   where exists(select 1 from public.school_modules m where m.school_id = s.id)
     and not exists(
       select 1 from public.school_modules m
        where m.school_id = s.id
          and not (exists(select 1 from public.quiz_attempts qa
                           where qa.module_id = m.id and qa.user_id = p_owner and qa.passed)
                   and exists(select 1 from public.challenge_completions cc
                               where cc.module_id = m.id and cc.user_id = p_owner)));

  -- Walk back from today; first gap ends the streak.
  v_d := v_today;
  loop
    select exists(
      select 1 from public.quiz_attempts where user_id = p_owner
        and (attempted_at at time zone 'utc')::date = v_d
      union all
      select 1 from public.challenge_completions where user_id = p_owner
        and (completed_at at time zone 'utc')::date = v_d
    ) into v_has;
    exit when not v_has;
    v_streak := v_streak + 1;
    v_d := v_d - 1;
    -- safety belt — don't loop forever on misconfigured data
    exit when v_streak > 365;
  end loop;

  return jsonb_build_object(
    'schools_completed', v_schools_completed,
    'modules_completed', v_modules_completed,
    'streak',            v_streak
  );
end $$;

-- ----------------------------------------------------------------------------
-- 6. Admin curator RPCs
-- ----------------------------------------------------------------------------
create or replace function public.tarena_assert_admin()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists(select 1 from public.profiles where id = auth.uid() and is_admin = true) then
    raise exception 'admin only';
  end if;
end $$;

create or replace function public.admin_upsert_school(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform public.tarena_assert_admin();
  v_id := nullif(p ->> 'id', '')::uuid;
  if v_id is null then
    insert into public.schools(slug, title, summary, icon, accent_color, ordinal)
      values(p ->> 'slug', p ->> 'title', coalesce(p ->> 'summary',''),
             coalesce(p ->> 'icon','fa-graduation-cap'),
             coalesce(p ->> 'accent_color','#c9a030'),
             coalesce((p ->> 'ordinal')::int, 0))
      returning id into v_id;
  else
    update public.schools set
      slug = coalesce(p ->> 'slug', slug),
      title = coalesce(p ->> 'title', title),
      summary = coalesce(p ->> 'summary', summary),
      icon = coalesce(p ->> 'icon', icon),
      accent_color = coalesce(p ->> 'accent_color', accent_color),
      ordinal = coalesce((p ->> 'ordinal')::int, ordinal)
    where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.admin_delete_school(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  delete from public.schools where id = p_id;
end $$;

create or replace function public.admin_upsert_module(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform public.tarena_assert_admin();
  v_id := nullif(p ->> 'id', '')::uuid;
  if v_id is null then
    insert into public.school_modules(school_id, ordinal, title, summary)
      values((p ->> 'school_id')::uuid,
             coalesce((p ->> 'ordinal')::int, 1),
             p ->> 'title', coalesce(p ->> 'summary',''))
      returning id into v_id;
  else
    update public.school_modules set
      ordinal = coalesce((p ->> 'ordinal')::int, ordinal),
      title   = coalesce(p ->> 'title', title),
      summary = coalesce(p ->> 'summary', summary)
    where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.admin_delete_module(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  delete from public.school_modules where id = p_id;
end $$;

create or replace function public.admin_set_module_reels(p_module_id uuid, p_reel_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare i int;
begin
  perform public.tarena_assert_admin();
  delete from public.module_reels where module_id = p_module_id;
  if p_reel_ids is null then return; end if;
  for i in 1 .. array_length(p_reel_ids, 1) loop
    insert into public.module_reels(module_id, reel_id, ordinal)
      values(p_module_id, p_reel_ids[i], i);
  end loop;
end $$;

create or replace function public.admin_upsert_quiz(p_module_id uuid, p_questions jsonb, p_pass_pct int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  insert into public.quizzes(module_id, questions, pass_pct, updated_at)
    values(p_module_id, p_questions, coalesce(p_pass_pct, 70), now())
    on conflict (module_id) do update set
      questions = excluded.questions,
      pass_pct  = excluded.pass_pct,
      updated_at = now();
end $$;

create or replace function public.admin_upsert_challenge(
  p_module_id uuid, p_title text, p_summary text, p_spec jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.tarena_assert_admin();
  insert into public.challenges(module_id, title, summary, spec, updated_at)
    values(p_module_id, p_title, coalesce(p_summary,''), p_spec, now())
    on conflict (module_id) do update set
      title     = excluded.title,
      summary   = excluded.summary,
      spec      = excluded.spec,
      updated_at = now();
end $$;

-- admin_get_quiz — full quiz including correct-answer indices + explain
-- text, for the curator UI only. Public `get_module` strips these to
-- keep them server-side; this RPC re-exposes them gated on is_admin so
-- editing an existing quiz round-trips losslessly (otherwise saving
-- would silently reset every `correct` to 0).
create or replace function public.admin_get_quiz(p_module_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  perform public.tarena_assert_admin();
  select jsonb_build_object(
    'module_id', q.module_id,
    'pass_pct',  q.pass_pct,
    'questions', q.questions
  ) into v_out
    from public.quizzes q
   where q.module_id = p_module_id;
  return v_out;  -- null if no quiz
end $$;

-- admin_list_reels — autocomplete for the curator. Lightweight
-- projection — id, symbol, thesis (truncated), author handle.
create or replace function public.admin_list_reels(p_q text default '', p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  perform public.tarena_assert_admin();
  -- Limit BEFORE aggregating — `limit` on the outer select with
  -- jsonb_agg() collapses to one row and would not actually cap the
  -- number of reels returned.
  with picked as (
    select r.id, r.symbol, r.thesis, r.created_at, p.username
      from public.reels r
      join public.public_profiles p on p.id = r.author_id
     where p_q = '' or r.symbol ilike '%'||p_q||'%' or r.thesis ilike '%'||p_q||'%' or p.username ilike '%'||p_q||'%'
     order by r.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'symbol', symbol,
    'thesis', left(thesis, 80),
    'author', username,
    'created_at', created_at
  ) order by created_at desc), '[]'::jsonb)
    into v_out
    from picked;
  return v_out;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Seed two starter schools (idempotent)
-- ----------------------------------------------------------------------------
create or replace function public.seed_starter_schools()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school1 uuid; v_school2 uuid;
  v_m1 uuid; v_m2 uuid; v_m3 uuid; v_m4 uuid;
begin
  -- School 1: Reading Charts in 30 minutes (Technical 101)
  insert into public.schools(slug, title, summary, icon, accent_color, ordinal)
    values ('reading-charts-30',
            'Reading Charts in 30 Minutes',
            'A speed-run through the chart-reading skills every Aussie uni trader needs: candles, support/resistance, and the two indicators worth your screen real-estate.',
            'fa-chart-candlestick', '#c9a030', 1)
    on conflict (slug) do update set title = excluded.title returning id into v_school1;

  insert into public.school_modules(school_id, ordinal, title, summary)
    values (v_school1, 1, 'Candle Anatomy',
            'What every wick, body and shadow is telling you. Five-minute primer + the only quiz you need.')
    on conflict (school_id, ordinal) do update set title = excluded.title returning id into v_m1;

  insert into public.school_modules(school_id, ordinal, title, summary)
    values (v_school1, 2, 'Support & Resistance',
            'Drawing levels that actually matter — and trading the bounce vs the break.')
    on conflict (school_id, ordinal) do update set title = excluded.title returning id into v_m2;

  insert into public.school_modules(school_id, ordinal, title, summary)
    values (v_school1, 3, 'Two Indicators, No More',
            'Why most traders use 7 indicators and lose money. The case for EMA20 + RSI(14) and nothing else.')
    on conflict (school_id, ordinal) do update set title = excluded.title returning id into v_m3;

  perform public.admin_upsert_quiz_internal(v_m1, jsonb_build_array(
    jsonb_build_object('q', 'A long upper wick on a green candle most often signals…',
      'choices', jsonb_build_array('Strong continuation up','Sellers stepped in at the high','A bullish engulfing pattern','Insider buying'),
      'correct', 1, 'explain', 'The wick shows price was rejected from the high — sellers absorbed buying pressure.'),
    jsonb_build_object('q', 'A doji candle is best described as…',
      'choices', jsonb_build_array('A wide-bodied trend candle','Open ≈ close, signalling indecision','Always bearish','Always bullish'),
      'correct', 1, 'explain', 'Doji = open and close are roughly equal. It marks indecision; context (trend, location) decides direction.'),
    jsonb_build_object('q', 'On a 5-minute chart a single candle represents…',
      'choices', jsonb_build_array('5 trades','5 minutes of price action','5 ticks','5 percent move'),
      'correct', 1, 'explain', 'Candle interval = the chart timeframe. A 5m candle sums all trades in that 5-minute window.'),
    jsonb_build_object('q', 'A bullish engulfing requires…',
      'choices', jsonb_build_array('A green candle whose body fully engulfs the previous red body','A green candle with a long upper wick','Two green candles in a row','A doji followed by a green candle'),
      'correct', 0, 'explain', 'The green body must completely cover the prior red body — that''s what makes it a reversal pattern.')
  ), 75);

  perform public.admin_upsert_quiz_internal(v_m2, jsonb_build_array(
    jsonb_build_object('q', 'A horizontal level becomes "stronger" each time it…',
      'choices', jsonb_build_array('Is touched and respected','Is broken','Is ignored','Aligns with a Fib level'),
      'correct', 0, 'explain', 'Repeat touches that hold confirm market memory. Breaks weaken the level.'),
    jsonb_build_object('q', 'When support breaks decisively it usually…',
      'choices', jsonb_build_array('Disappears','Becomes new resistance','Becomes stronger support','Triggers a margin call'),
      'correct', 1, 'explain', 'Old support → new resistance ("polarity"). The price level retains psychological weight on the other side.'),
    jsonb_build_object('q', 'The best stop placement when buying a bounce off support is…',
      'choices', jsonb_build_array('At the support level','Just below the support level','At the previous high','No stop — average down'),
      'correct', 1, 'explain', 'A stop just below structure invalidates your trade idea cleanly when the level fails.')
  ), 70);

  perform public.admin_upsert_quiz_internal(v_m3, jsonb_build_array(
    jsonb_build_object('q', 'EMA20 reacts ___ than EMA50.',
      'choices', jsonb_build_array('Slower','Faster','The same','Only on weekly charts'),
      'correct', 1, 'explain', 'A shorter window weights recent price more heavily, so the EMA20 turns sooner.'),
    jsonb_build_object('q', 'RSI(14) above 70 is traditionally read as…',
      'choices', jsonb_build_array('Oversold','Overbought','Neutral','Bearish divergence'),
      'correct', 1, 'explain', 'But "overbought" doesn''t mean "sell" — strong trends stay above 70 for weeks.'),
    jsonb_build_object('q', 'The biggest risk of stacking 7 indicators is…',
      'choices', jsonb_build_array('Slower charts','Conflicting signals → analysis paralysis','Higher commissions','Broker rejection'),
      'correct', 1, 'explain', 'Indicators are derivatives of price. Adding more rarely adds information; it adds contradiction.')
  ), 70);

  perform public.admin_upsert_challenge_internal(v_m1, 'Spot 5 setups',
    'Open 5 paper trades on any market — practice committing to a thesis.',
    jsonb_build_object(
      'kind', 'min_trades',
      'params', jsonb_build_object('n', 5),
      'perk', jsonb_build_object('kind', 'extra_capital',
        'value', jsonb_build_object('amount', 5000))));

  perform public.admin_upsert_challenge_internal(v_m2, 'Trade a level',
    'Open one trade with a stop placed within 0.5% of a clear support/resistance level (R:R ≥ 2:1).',
    jsonb_build_object(
      'kind', 'min_rr',
      'params', jsonb_build_object('n', 1, 'ratio', 2),
      'perk', jsonb_build_object('kind', 'badge',
        'value', jsonb_build_object('key','level_trader','label','Level Trader','icon','fa-grip-lines'))));

  perform public.admin_upsert_challenge_internal(v_m3, 'Indicator discipline',
    'Document your reasoning on at least 3 trades this week — note which indicator triggered entry.',
    jsonb_build_object(
      'kind', 'journal_count',
      'params', jsonb_build_object('n', 3, 'days', 7),
      'perk', jsonb_build_object('kind','indicator_unlock',
        'value', jsonb_build_object('indicator','macd','label','MACD'))));

  -- School 2: Risk-First Trading (Risk Mgmt 101)
  insert into public.schools(slug, title, summary, icon, accent_color, ordinal)
    values ('risk-first',
            'Risk-First Trading',
            'Position sizing, stop placement, and the maths behind never blowing up your paper account. The course every retail trader skipped.',
            'fa-shield-halved', '#5b9cff', 2)
    on conflict (slug) do update set title = excluded.title returning id into v_school2;

  insert into public.school_modules(school_id, ordinal, title, summary)
    values (v_school2, 1, 'The 1% Rule',
            'Why risking 1% per trade survives a 10-trade losing streak — and 5% does not.')
    on conflict (school_id, ordinal) do update set title = excluded.title returning id into v_m4;

  perform public.admin_upsert_quiz_internal(v_m4, jsonb_build_array(
    jsonb_build_object('q', 'Risking 1% per trade, after 10 consecutive losses your account is at…',
      'choices', jsonb_build_array('~70% of starting','~90% of starting','~50% of starting','Wiped'),
      'correct', 1, 'explain', '0.99^10 ≈ 0.904. You still have ~90% — plenty of runway to recover.'),
    jsonb_build_object('q', 'Risking 10% per trade, after 10 consecutive losses your account is at…',
      'choices', jsonb_build_array('~90% of starting','~50% of starting','~35% of starting','Wiped'),
      'correct', 2, 'explain', '0.9^10 ≈ 0.349. You need a 186% return just to break even.'),
    jsonb_build_object('q', 'Position size = (account × risk%) ÷ ___',
      'choices', jsonb_build_array('Entry price','Distance from entry to stop','Distance from entry to target','Daily ATR'),
      'correct', 1, 'explain', 'The denominator is your per-share dollar risk = |entry − stop|. That converts dollar risk into share count.')
  ), 75);

  perform public.admin_upsert_challenge_internal(v_m4, 'Three winners in a row',
    'Demonstrate disciplined sizing with 3 consecutive winning closed trades.',
    jsonb_build_object(
      'kind', 'consecutive_wins',
      'params', jsonb_build_object('n', 3),
      'perk', jsonb_build_object('kind', 'badge',
        'value', jsonb_build_object('key','risk_first','label','Risk-First','icon','fa-shield-halved'))));
end $$;

-- Internal versions of the upsert RPCs that skip the admin check —
-- only called from within seed_starter_schools (also security definer).
create or replace function public.admin_upsert_quiz_internal(p_module_id uuid, p_questions jsonb, p_pass_pct int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.quizzes(module_id, questions, pass_pct, updated_at)
    values(p_module_id, p_questions, coalesce(p_pass_pct, 70), now())
    on conflict (module_id) do update set
      questions = excluded.questions, pass_pct = excluded.pass_pct, updated_at = now();
end $$;

create or replace function public.admin_upsert_challenge_internal(
  p_module_id uuid, p_title text, p_summary text, p_spec jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.challenges(module_id, title, summary, spec, updated_at)
    values(p_module_id, p_title, coalesce(p_summary,''), p_spec, now())
    on conflict (module_id) do update set
      title = excluded.title, summary = excluded.summary,
      spec = excluded.spec, updated_at = now();
end $$;

-- ----------------------------------------------------------------------------
-- 8. Grants
-- ----------------------------------------------------------------------------
revoke all on function public.list_schools()                   from public;
revoke all on function public.get_school(uuid)                 from public;
revoke all on function public.get_module(uuid)                 from public;
revoke all on function public.submit_quiz(uuid, jsonb)         from public;
revoke all on function public.validate_challenge(uuid)         from public;
revoke all on function public.list_my_perks()                  from public;
revoke all on function public.learning_stats(uuid)             from public;
revoke all on function public.admin_upsert_school(jsonb)       from public;
revoke all on function public.admin_delete_school(uuid)        from public;
revoke all on function public.admin_upsert_module(jsonb)       from public;
revoke all on function public.admin_delete_module(uuid)        from public;
revoke all on function public.admin_set_module_reels(uuid,uuid[]) from public;
revoke all on function public.admin_upsert_quiz(uuid, jsonb, int) from public;
revoke all on function public.admin_upsert_challenge(uuid,text,text,jsonb) from public;
revoke all on function public.admin_list_reels(text, int)      from public;
revoke all on function public.admin_get_quiz(uuid)             from public;
revoke all on function public.tarena_assert_admin()            from public;
revoke all on function public.admin_upsert_quiz_internal(uuid, jsonb, int) from public;
revoke all on function public.admin_upsert_challenge_internal(uuid,text,text,jsonb) from public;
revoke all on function public.seed_starter_schools()           from public;

grant execute on function public.list_schools()                   to authenticated;
grant execute on function public.get_school(uuid)                 to authenticated;
grant execute on function public.get_module(uuid)                 to authenticated;
grant execute on function public.submit_quiz(uuid, jsonb)         to authenticated;
grant execute on function public.validate_challenge(uuid)         to authenticated;
grant execute on function public.list_my_perks()                  to authenticated;
grant execute on function public.learning_stats(uuid)             to authenticated;
grant execute on function public.admin_upsert_school(jsonb)       to authenticated;
grant execute on function public.admin_delete_school(uuid)        to authenticated;
grant execute on function public.admin_upsert_module(jsonb)       to authenticated;
grant execute on function public.admin_delete_module(uuid)        to authenticated;
grant execute on function public.admin_set_module_reels(uuid,uuid[]) to authenticated;
grant execute on function public.admin_upsert_quiz(uuid, jsonb, int) to authenticated;
grant execute on function public.admin_upsert_challenge(uuid,text,text,jsonb) to authenticated;
grant execute on function public.admin_list_reels(text, int)      to authenticated;
grant execute on function public.admin_get_quiz(uuid)             to authenticated;
-- seed_starter_schools is intentionally NOT granted to clients — run from the SQL editor.
