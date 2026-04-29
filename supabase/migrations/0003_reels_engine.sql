-- ============================================================
--  TradeArena · 0003_reels_engine.sql
--  ----------------------------------------------------------
--  Server side of Task #5 — strategy reels feed + composer.
--
--  All client-facing access goes through SECURITY DEFINER RPCs
--  that wrap the RLS-protected base tables, so we can:
--    1. atomically open paper trades when a reel is published,
--    2. enforce visibility (public / followers / private) in
--       a single hardened code path, and
--    3. return rich, joined payloads in one round-trip without
--       leaking columns the row-level policies would otherwise
--       expose to followers.
--
--  Conventions:
--    - Default account size is $100,000 (matches profile.html).
--    - Default risk per reel is 1% of account.
--    - Position sizing: qty = (account * risk_pct/100) / |entry-stop|
--      (signed by direction = long => +qty, short => -qty).
--
--  Apply order: 0001 → 0002 → 0003.
-- ============================================================

set search_path = public;

-- ============================================================
-- 1. Tighten reel_engagement & reel_mirrors read policies
--
-- 0001 left these as `using (true)` so that aggregate counts
-- (likes / saves / mirrors) could be computed by anyone. That's
-- still the goal — but enumerating *who* liked a reel is a
-- different question. We keep table-level reads open so the
-- counts queries below stay simple, but we expose viewer-only
-- detail through the RPCs (no rows returned for "who saved").
-- ============================================================
-- (no-op DDL, kept here as a documentation anchor)


-- ============================================================
-- 2. Helper: position sizing
--
-- Risk-based sizing — qty is whatever quantity makes
-- |entry - stop| * qty == account * risk_pct/100. The math
-- lives in SQL (not just JS) so the auto-open trade on publish
-- and the manual mirror open use exactly the same formula.
-- Returns 0 when the price levels make no sense (entry == stop,
-- negative entry, etc.).
-- ============================================================
create or replace function public.tarena_position_size(
  p_entry        numeric,
  p_stop         numeric,
  p_risk_pct     numeric,
  p_account_size numeric
)
returns numeric
language sql immutable
as $$
  -- Truncate (floor) to 6 decimals — must match assets/reels.js
  -- positionSize() exactly. Banker's rounding in SQL `round()` and
  -- JS `toFixed()` disagree at the 6th-decimal boundary, which could
  -- otherwise show one qty in the composer preview and store a
  -- different one server-side.
  select case
    when coalesce(p_entry, 0) <= 0
      or coalesce(p_stop,  0) <= 0
      or coalesce(p_risk_pct, 0) <= 0
      or coalesce(p_account_size, 0) <= 0
      or abs(p_entry - p_stop) < 1e-9
    then 0::numeric
    else floor(
      ((p_account_size * (p_risk_pct / 100.0)) / abs(p_entry - p_stop)) * 1000000
    ) / 1000000.0
  end;
$$;
grant execute on function public.tarena_position_size(numeric, numeric, numeric, numeric) to authenticated;


-- ============================================================
-- 3. Helper: can the current viewer read this reel?
--
-- Mirrors `reels_read` policy logic but exposed as a function so
-- the SECURITY DEFINER RPCs below can short-circuit cleanly.
-- 'league' visibility is treated as **private until leagues ship**
-- so a user who picks "League only" today never accidentally
-- broadcasts publicly when leagues launch with different rules.
-- ============================================================
create or replace function public.can_read_reel(
  p_visibility text,
  p_author_id  uuid
)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select case
    when p_visibility = 'public'                      then true
    when p_author_id  = auth.uid()                    then true
    when p_visibility = 'followers' then exists (
      select 1 from public.follows
       where follower_id = auth.uid()
         and followee_id = p_author_id
    )
    else false
  end;
$$;
revoke all on function public.can_read_reel(text, uuid) from public;
grant execute on function public.can_read_reel(text, uuid) to authenticated;


-- ============================================================
-- 4. publish_reel(p_payload jsonb)
--
-- Atomic publish path — the *only* way the client should
-- create reels. Inserts the reel row, the tag rows, opens a
-- paper trade sized to risk_pct of the author's account, and
-- back-links the trade onto the reel — all in one transaction.
--
-- Payload shape:
--   {
--     "symbol":     "BHP.AX",
--     "market":     "asx",
--     "thesis":     "...",                         -- <= 280 chars
--     "direction":  "long" | "short",
--     "entry":      43.50,
--     "stop_loss":  41.80,
--     "target":     48.20,
--     "visibility": "public"|"followers"|"private",
--     "snapshot":   "data:image/png;base64,...",   -- nullable
--     "risk_pct":   1.0,                           -- defaults to 1
--     "tags": [
--       { "tag_type": "indicator", "tag_value": "RSI",
--         "x_pct": 35.0, "y_pct": 70.5, "ordinal": 0 },
--       ...
--     ]
--   }
--
-- Returns: reel_id uuid.
-- ============================================================
create or replace function public.publish_reel(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_reel_id   uuid;
  v_trade_id  uuid;
  v_qty       numeric;
  v_thesis    text;
  v_visibility text;
  v_direction text;
  v_entry     numeric;
  v_stop      numeric;
  v_target    numeric;
  v_risk_pct  numeric;
  v_account   numeric := 100000.0;  -- v1 starting capital
  v_tag       jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_thesis     := nullif(trim(p_payload->>'thesis'), '');
  v_direction  := lower(coalesce(p_payload->>'direction', 'long'));
  v_visibility := lower(coalesce(p_payload->>'visibility', 'public'));
  v_entry      := nullif((p_payload->>'entry'),     '')::numeric;
  v_stop       := nullif((p_payload->>'stop_loss'), '')::numeric;
  v_target     := nullif((p_payload->>'target'),    '')::numeric;
  v_risk_pct   := coalesce(nullif((p_payload->>'risk_pct'), '')::numeric, 1.0);

  if v_thesis is null then raise exception 'Thesis is required'; end if;
  if length(v_thesis) > 280 then raise exception 'Thesis exceeds 280 characters'; end if;
  if v_direction not in ('long','short') then
    raise exception 'Direction must be long or short';
  end if;
  if v_visibility not in ('public','followers','league','private') then
    raise exception 'Bad visibility';
  end if;
  if coalesce(p_payload->>'symbol', '') = '' then
    raise exception 'Symbol is required';
  end if;
  if v_entry is null or v_entry <= 0 then
    raise exception 'Entry price is required';
  end if;
  if v_stop is null or v_stop <= 0 then
    raise exception 'Stop loss is required';
  end if;
  if v_risk_pct < 0.05 or v_risk_pct > 25 then
    raise exception 'risk_pct out of range (0.05..25)';
  end if;

  -- 4a. Insert the reel
  insert into public.reels (
    author_id, symbol, market, chart_snapshot_url,
    thesis, entry, stop_loss, target, direction, visibility
  ) values (
    v_uid,
    p_payload->>'symbol',
    nullif(p_payload->>'market', ''),
    nullif(p_payload->>'snapshot', ''),
    v_thesis,
    v_entry, v_stop, v_target,
    v_direction,
    v_visibility
  )
  returning id into v_reel_id;

  -- 4b. Insert tags (skip silently when payload omits them)
  if jsonb_typeof(p_payload->'tags') = 'array' then
    for v_tag in select * from jsonb_array_elements(p_payload->'tags') loop
      if (v_tag->>'tag_type') in ('indicator','pattern','strategy','ticker')
         and coalesce(v_tag->>'tag_value', '') <> ''
      then
        insert into public.reel_tags (
          reel_id, tag_type, tag_value, x_pct, y_pct, ordinal
        ) values (
          v_reel_id,
          v_tag->>'tag_type',
          v_tag->>'tag_value',
          nullif(v_tag->>'x_pct','')::numeric,
          nullif(v_tag->>'y_pct','')::numeric,
          coalesce(nullif(v_tag->>'ordinal','')::int, 0)
        );
      end if;
    end loop;
  end if;

  -- 4c. Auto paper trade — risk-sized
  v_qty := public.tarena_position_size(v_entry, v_stop, v_risk_pct, v_account);
  if v_qty > 0 then
    insert into public.paper_trades (
      owner_id, symbol, market, side, qty,
      entry_price, stop_loss, target,
      status, source_reel_id
    ) values (
      v_uid,
      p_payload->>'symbol',
      nullif(p_payload->>'market', ''),
      case when v_direction = 'long' then 'buy' else 'sell' end,
      v_qty,
      v_entry, v_stop, v_target,
      'open', v_reel_id
    )
    returning id into v_trade_id;

    update public.reels
       set paper_trade_id = v_trade_id
     where id = v_reel_id;
  end if;

  return v_reel_id;
end;
$$;
revoke all on function public.publish_reel(jsonb) from public;
grant execute on function public.publish_reel(jsonb) to authenticated;


-- ============================================================
-- 5. mirror_reel(p_reel_id, p_risk_pct, p_account_size)
--
-- Opens a paper trade in the *viewer's* account, sized to their
-- own risk %, and records a reel_mirrors row linking it back to
-- the source reel. Idempotent on (reel_id, mirrored_by) — second
-- press returns the existing row instead of erroring.
-- ============================================================
create or replace function public.mirror_reel(
  p_reel_id      uuid,
  p_risk_pct     numeric default 1.0,
  p_account_size numeric default 100000.0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_reel     public.reels%rowtype;
  v_qty      numeric;
  v_trade_id uuid;
  v_mirror_id uuid;
  v_existing  uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_risk_pct is null or p_risk_pct < 0.05 or p_risk_pct > 25 then
    raise exception 'risk_pct out of range (0.05..25)';
  end if;

  select * into v_reel from public.reels where id = p_reel_id;
  if not found then raise exception 'Reel not found'; end if;

  if not public.can_read_reel(v_reel.visibility, v_reel.author_id) then
    raise exception 'You cannot mirror this reel';
  end if;

  if v_reel.author_id = v_uid then
    raise exception 'You can''t mirror your own reel';
  end if;

  -- Idempotency
  select id into v_existing
    from public.reel_mirrors
   where reel_id = p_reel_id and mirrored_by = v_uid
   limit 1;
  if v_existing is not null then return v_existing; end if;

  v_qty := public.tarena_position_size(v_reel.entry, v_reel.stop_loss, p_risk_pct, p_account_size);
  if v_qty <= 0 then
    raise exception 'Cannot size position from this reel';
  end if;

  insert into public.paper_trades (
    owner_id, symbol, market, side, qty,
    entry_price, stop_loss, target,
    status, source_reel_id
  ) values (
    v_uid,
    v_reel.symbol, v_reel.market,
    case when v_reel.direction = 'long' then 'buy' else 'sell' end,
    v_qty,
    v_reel.entry, v_reel.stop_loss, v_reel.target,
    'open', v_reel.id
  )
  returning id into v_trade_id;

  insert into public.reel_mirrors (
    reel_id, mirrored_by, paper_trade_id, sized_risk_pct
  ) values (
    p_reel_id, v_uid, v_trade_id, p_risk_pct
  )
  returning id into v_mirror_id;

  return v_mirror_id;
end;
$$;
revoke all on function public.mirror_reel(uuid, numeric, numeric) from public;
grant execute on function public.mirror_reel(uuid, numeric, numeric) to authenticated;


-- ============================================================
-- 6. toggle_engagement(p_reel_id, p_kind)
--
-- Like / save / share toggle. 'view' is also acceptable (counted
-- once per (reel, user) thanks to the unique constraint). Returns
-- the resulting state ({on: bool, count: int}) so the client can
-- update the chip without a follow-up read.
-- ============================================================
create or replace function public.toggle_engagement(
  p_reel_id uuid,
  p_kind    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_exists uuid;
  v_count  bigint;
  v_now_on boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_kind not in ('like','save','share','view') then
    raise exception 'Bad engagement kind';
  end if;

  -- Visibility gate — can the viewer even see this reel?
  if not exists (
    select 1 from public.reels r
     where r.id = p_reel_id
       and public.can_read_reel(r.visibility, r.author_id)
  ) then
    raise exception 'Cannot engage with this reel';
  end if;

  select id into v_exists
    from public.reel_engagement
   where reel_id = p_reel_id and user_id = v_uid and kind = p_kind
   limit 1;

  if p_kind in ('share','view') then
    -- Non-toggleable kinds — insert if missing, leave alone otherwise.
    if v_exists is null then
      insert into public.reel_engagement (reel_id, user_id, kind)
        values (p_reel_id, v_uid, p_kind);
    end if;
    v_now_on := true;
  else
    if v_exists is null then
      insert into public.reel_engagement (reel_id, user_id, kind)
        values (p_reel_id, v_uid, p_kind);
      v_now_on := true;
    else
      delete from public.reel_engagement where id = v_exists;
      v_now_on := false;
    end if;
  end if;

  select count(*) into v_count
    from public.reel_engagement
   where reel_id = p_reel_id and kind = p_kind;

  return jsonb_build_object('on', v_now_on, 'count', v_count, 'kind', p_kind);
end;
$$;
revoke all on function public.toggle_engagement(uuid, text) from public;
grant execute on function public.toggle_engagement(uuid, text) to authenticated;


-- ============================================================
-- 7. feed_reels(...)
--
-- The single read-side query for the reels feed. Returns one row
-- per reel, with author profile + tag list + engagement counts +
-- viewer's own engagement state + the linked paper trade fields
-- needed to render entry/SL/target and live P&L locally.
--
-- Tabs:
--   'fy'         — chronological reverse, all visible reels
--   'following'  — only authors the viewer follows
--   'trending'   — engagement-weighted in the last 24h
--
-- Filters (optional, all default null):
--   p_tag    — exact tag_value match (any tag_type)
--   p_ticker — exact symbol or @handle
--   p_q      — substring match against thesis or tag_value
--
-- Cursor: any reel where created_at < p_cursor (NULL = first page).
-- ============================================================
create or replace function public.feed_reels(
  p_cursor   timestamptz default null,
  p_limit    int         default 12,
  p_tab      text        default 'fy',
  p_tag      text        default null,
  p_ticker   text        default null,
  p_q        text        default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_limit  int  := least(greatest(coalesce(p_limit, 12), 1), 30);
  v_rows   jsonb;
begin
  with base as (
    select r.*
      from public.reels r
     where public.can_read_reel(r.visibility, r.author_id)
       and (p_cursor is null or r.created_at < p_cursor)
       and (p_tab <> 'following' or exists (
            select 1 from public.follows f
             where f.follower_id = v_uid and f.followee_id = r.author_id))
       and (p_tag is null or exists (
            select 1 from public.reel_tags t
             where t.reel_id = r.id and lower(t.tag_value) = lower(p_tag)))
       and (p_ticker is null or lower(r.symbol) = lower(p_ticker))
       and (p_q is null or
            r.thesis ilike '%' || p_q || '%' or
            exists (select 1 from public.reel_tags t
                     where t.reel_id = r.id
                       and lower(t.tag_value) ilike '%' || lower(p_q) || '%'))
  ),
  scored as (
    select
      b.*,
      case when p_tab = 'trending'
        then coalesce((select count(*) from public.reel_engagement e
                        where e.reel_id = b.id
                          and e.created_at >= now() - interval '24 hours'), 0)
        else 0
      end as score
    from base b
  ),
  ranked as (
    select s.*
      from scored s
     order by
       case when p_tab = 'trending' then s.score end desc nulls last,
       s.created_at desc
     limit v_limit + 1
  ),
  tag_lists as (
    select t.reel_id, jsonb_agg(jsonb_build_object(
      'tag_type', t.tag_type,
      'tag_value', t.tag_value,
      'x_pct', t.x_pct,
      'y_pct', t.y_pct,
      'ordinal', t.ordinal
    ) order by t.ordinal, t.id) as tags
      from public.reel_tags t
     where t.reel_id in (select id from ranked)
     group by t.reel_id
  ),
  eng_counts as (
    select e.reel_id,
           coalesce(sum((e.kind='like' )::int), 0) as likes,
           coalesce(sum((e.kind='save' )::int), 0) as saves,
           coalesce(sum((e.kind='share')::int), 0) as shares,
           coalesce(sum((e.kind='view' )::int), 0) as views
      from public.reel_engagement e
     where e.reel_id in (select id from ranked)
     group by e.reel_id
  ),
  mirror_counts as (
    select m.reel_id, count(*) as mirrors
      from public.reel_mirrors m
     where m.reel_id in (select id from ranked)
     group by m.reel_id
  ),
  viewer_eng as (
    select e.reel_id,
           bool_or(e.kind='like') as liked,
           bool_or(e.kind='save') as saved
      from public.reel_engagement e
     where e.user_id = v_uid
       and e.reel_id in (select id from ranked)
     group by e.reel_id
  ),
  viewer_mirror as (
    select m.reel_id, true as mirrored
      from public.reel_mirrors m
     where m.mirrored_by = v_uid
       and m.reel_id in (select id from ranked)
  ),
  joined as (
    select
      r.id, r.symbol, r.market, r.chart_snapshot_url,
      r.thesis, r.entry, r.stop_loss, r.target, r.direction,
      r.visibility, r.created_at, r.paper_trade_id,
      jsonb_build_object(
        'id',           p.id,
        'username',     p.username,
        'display_name', p.display_name,
        'tier',         p.tier,
        'avatar_color', p.avatar_color
      ) as author,
      coalesce(tl.tags, '[]'::jsonb) as tags,
      jsonb_build_object(
        'likes',   coalesce(ec.likes,   0),
        'saves',   coalesce(ec.saves,   0),
        'shares',  coalesce(ec.shares,  0),
        'views',   coalesce(ec.views,   0),
        'mirrors', coalesce(mc.mirrors, 0)
      ) as counts,
      jsonb_build_object(
        'liked',    coalesce(ve.liked,    false),
        'saved',    coalesce(ve.saved,    false),
        'mirrored', coalesce(vm.mirrored, false)
      ) as viewer_state
    from ranked r
    join public.profiles p     on p.id = r.author_id
    left join tag_lists tl     on tl.reel_id    = r.id
    left join eng_counts ec    on ec.reel_id    = r.id
    left join mirror_counts mc on mc.reel_id    = r.id
    left join viewer_eng ve    on ve.reel_id    = r.id
    left join viewer_mirror vm on vm.reel_id    = r.id
  )
  -- next_cursor = the oldest created_at on this page. The client
  -- sends it back as `p_cursor` and we return rows strictly older.
  -- If two reels share an exact created_at across a page boundary,
  -- the second one is briefly skipped — acceptable for v1 (resolved
  -- on next refresh) and avoids a composite-cursor API change.
  select jsonb_build_object(
    'rows',        coalesce(jsonb_agg(j order by j.created_at desc), '[]'::jsonb),
    'next_cursor', (select min(created_at) from joined)
  )
    into v_rows
    from joined j;

  return v_rows;
end;
$$;
revoke all on function public.feed_reels(timestamptz, int, text, text, text, text) from public;
grant execute on function public.feed_reels(timestamptz, int, text, text, text, text) to authenticated;


-- ============================================================
-- 8. get_reel(p_id) — single-reel fetch (deep link / share view)
-- Same shape as one row from feed_reels.
-- ============================================================
create or replace function public.get_reel(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_payload jsonb;
begin
  with r as (
    select * from public.reels
     where id = p_id
       and public.can_read_reel(visibility, author_id)
  )
  select jsonb_build_object(
    'id',           r.id,
    'symbol',       r.symbol,
    'market',       r.market,
    'chart_snapshot_url', r.chart_snapshot_url,
    'thesis',       r.thesis,
    'entry',        r.entry,
    'stop_loss',    r.stop_loss,
    'target',       r.target,
    'direction',    r.direction,
    'visibility',   r.visibility,
    'created_at',   r.created_at,
    'paper_trade_id', r.paper_trade_id,
    'author', jsonb_build_object(
      'id',           p.id,
      'username',     p.username,
      'display_name', p.display_name,
      'tier',         p.tier,
      'avatar_color', p.avatar_color
    ),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tag_type',  t.tag_type,
        'tag_value', t.tag_value,
        'x_pct',     t.x_pct,
        'y_pct',     t.y_pct,
        'ordinal',   t.ordinal
      ) order by t.ordinal, t.id)
        from public.reel_tags t
       where t.reel_id = r.id
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'likes',   (select count(*) from public.reel_engagement where reel_id = r.id and kind = 'like'),
      'saves',   (select count(*) from public.reel_engagement where reel_id = r.id and kind = 'save'),
      'shares',  (select count(*) from public.reel_engagement where reel_id = r.id and kind = 'share'),
      'views',   (select count(*) from public.reel_engagement where reel_id = r.id and kind = 'view'),
      'mirrors', (select count(*) from public.reel_mirrors    where reel_id = r.id)
    ),
    'viewer_state', jsonb_build_object(
      'liked',    exists (select 1 from public.reel_engagement where reel_id = r.id and user_id = v_uid and kind = 'like'),
      'saved',    exists (select 1 from public.reel_engagement where reel_id = r.id and user_id = v_uid and kind = 'save'),
      'mirrored', exists (select 1 from public.reel_mirrors    where reel_id = r.id and mirrored_by = v_uid)
    )
  )
    into v_payload
    from r
    join public.profiles p on p.id = r.author_id;

  return v_payload;
end;
$$;
revoke all on function public.get_reel(uuid) from public;
grant execute on function public.get_reel(uuid) to authenticated;
