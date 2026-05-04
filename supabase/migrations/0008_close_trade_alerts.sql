-- ============================================================
-- Migration 0008: close_trade RPC, price_alerts, notifications
-- ============================================================

-- ============================================================
-- RPC: close_trade
-- Closes an open paper trade by recording the exit price,
-- calculating realized P&L, updating status to 'closed',
-- and refreshing the holdings materialized view.
-- ============================================================
create or replace function public.close_trade(
  p_trade_id   uuid,
  p_exit_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade   public.paper_trades%rowtype;
  v_pnl     numeric;
  v_pnl_pct numeric;
begin
  -- Fetch the trade and verify ownership
  select * into v_trade
    from public.paper_trades
   where id = p_trade_id
     and owner_id = auth.uid()
     and status = 'open';

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Trade not found or already closed');
  end if;

  if p_exit_price is null or p_exit_price <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Invalid exit price');
  end if;

  -- Calculate realized P&L
  if v_trade.side = 'buy' then
    v_pnl := (p_exit_price - v_trade.entry_price) * v_trade.qty;
  else
    v_pnl := (v_trade.entry_price - p_exit_price) * v_trade.qty;
  end if;

  v_pnl_pct := case
    when v_trade.entry_price > 0
    then (v_pnl / (v_trade.entry_price * v_trade.qty)) * 100
    else 0
  end;

  -- Update the trade row
  update public.paper_trades
     set exit_price = p_exit_price,
         status     = 'closed',
         closed_at  = now()
   where id = p_trade_id
     and owner_id = auth.uid();

  -- Refresh the holdings materialized view so the portfolio
  -- reflects the closed position immediately.
  refresh materialized view public.holdings_view;

  return jsonb_build_object(
    'ok',      true,
    'pnl',     round(v_pnl, 2),
    'pnl_pct', round(v_pnl_pct, 2),
    'symbol',  v_trade.symbol,
    'side',    v_trade.side
  );
end;
$$;
grant execute on function public.close_trade(uuid, numeric) to authenticated;

-- ============================================================
-- TABLE: price_alerts
-- Stores user-defined price alerts. The check_price_alerts()
-- function is called on each market data tick to fire alerts.
-- ============================================================
create table if not exists public.price_alerts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  symbol      text not null,
  condition   text not null check (condition in ('above', 'below')),
  target      numeric(20,8) not null,
  note        text default '',
  fired       boolean not null default false,
  fired_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists price_alerts_owner_idx  on public.price_alerts(owner_id);
create index if not exists price_alerts_symbol_idx on public.price_alerts(symbol, fired);

alter table public.price_alerts enable row level security;

drop policy if exists price_alerts_read  on public.price_alerts;
drop policy if exists price_alerts_write on public.price_alerts;
create policy price_alerts_read  on public.price_alerts for select using (owner_id = auth.uid());
create policy price_alerts_write on public.price_alerts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============================================================
-- TABLE: notifications
-- In-app notification inbox. Populated by server-side triggers
-- and client-side alert checks.
-- ============================================================
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'info',  -- info | trade | alert | social
  title       text not null,
  body        text default '',
  link        text default '',
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_owner_idx on public.notifications(owner_id, read, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists notifications_read  on public.notifications;
drop policy if exists notifications_write on public.notifications;
create policy notifications_read  on public.notifications for select using (owner_id = auth.uid());
create policy notifications_write on public.notifications for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============================================================
-- RPC: get_my_notifications
-- Returns the 50 most recent notifications for the current user.
-- ============================================================
create or replace function public.get_my_notifications()
returns setof public.notifications
language sql stable
security definer
set search_path = public
as $$
  select * from public.notifications
   where owner_id = auth.uid()
   order by created_at desc
   limit 50;
$$;
grant execute on function public.get_my_notifications() to authenticated;

-- ============================================================
-- RPC: mark_notifications_read
-- Marks all unread notifications as read for the current user.
-- ============================================================
create or replace function public.mark_notifications_read()
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
     set read = true
   where owner_id = auth.uid()
     and read = false;
$$;
grant execute on function public.mark_notifications_read() to authenticated;

-- ============================================================
-- RPC: create_price_alert
-- Creates a price alert and returns the new alert id.
-- ============================================================
create or replace function public.create_price_alert(
  p_symbol    text,
  p_condition text,
  p_target    numeric,
  p_note      text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.price_alerts (owner_id, symbol, condition, target, note)
  values (auth.uid(), upper(p_symbol), p_condition, p_target, coalesce(p_note, ''))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.create_price_alert(text, text, numeric, text) to authenticated;

-- ============================================================
-- RPC: fire_price_alerts
-- Called client-side when a live price tick arrives.
-- Checks all unfired alerts for the given symbol and fires
-- any that have been triggered, creating notifications.
-- ============================================================
create or replace function public.fire_price_alerts(
  p_symbol text,
  p_price  numeric
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert  record;
  v_fired  int := 0;
begin
  for v_alert in
    select * from public.price_alerts
     where owner_id = auth.uid()
       and symbol   = upper(p_symbol)
       and fired    = false
       and (
         (condition = 'above' and p_price >= target)
         or
         (condition = 'below' and p_price <= target)
       )
  loop
    -- Mark alert as fired
    update public.price_alerts
       set fired = true, fired_at = now()
     where id = v_alert.id;

    -- Create a notification
    insert into public.notifications (owner_id, kind, title, body, link)
    values (
      auth.uid(),
      'alert',
      v_alert.symbol || ' price alert triggered',
      v_alert.symbol || ' is ' || v_alert.condition || ' $' || v_alert.target::text
        || case when v_alert.note <> '' then ' — ' || v_alert.note else '' end,
      '/trade.html'
    );

    v_fired := v_fired + 1;
  end loop;

  return v_fired;
end;
$$;
grant execute on function public.fire_price_alerts(text, numeric) to authenticated;
