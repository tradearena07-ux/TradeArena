-- ============================================================
-- 0007_avatar_url.sql
-- Adds uploadable avatar support to profiles + storage bucket.
--
-- Run this in the Supabase SQL editor. After running, head to
-- Storage in the Supabase dashboard and confirm the `avatars`
-- bucket exists and is marked PUBLIC. (The INSERT below creates
-- it idempotently; the policies underneath let any authenticated
-- user upload to / manage their own folder.)
-- ============================================================

-- 1. Column on profiles ---------------------------------------
alter table public.profiles
  add column if not exists avatar_url text;

-- 2. Expose avatar_url through the public profile RPC ---------
-- Postgres won't let CREATE OR REPLACE change a function's return
-- columns, so drop the old signature first (42P13 otherwise).
drop function if exists public.get_profile_card(text);
create function public.get_profile_card(p_username text)
returns table (
  id              uuid,
  username        text,
  display_name    text,
  tier            text,
  type            text,
  university      text,
  bio             text,
  avatar_color    text,
  avatar_url      text,
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
    p.avatar_url,
    p.badges,
    p.visibility_mask,
    p.created_at
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
  limit 1;
$$;
revoke all on function public.get_profile_card(text) from public;
grant execute on function public.get_profile_card(text) to authenticated;

-- 3. Public_profiles view (used by leaderboards / reels) ------
drop view if exists public.public_profiles;
create view public.public_profiles
  with (security_invoker = true) as
  select id, username, display_name, tier, avatar_color, avatar_url, badges
  from public.profiles;
revoke all on public.public_profiles from public;
grant select on public.public_profiles to authenticated;

-- 4. Storage bucket + RLS policies ----------------------------
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do update set public = true;

-- Anyone (incl. anon) can view avatars (bucket is public).
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Authenticated users can upload to / overwrite their own folder
-- (path prefix == auth.uid()::text). Foldering by uid keeps users
-- from clobbering each other's files.
drop policy if exists "avatars_owner_insert" on storage.objects;
create policy "avatars_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
