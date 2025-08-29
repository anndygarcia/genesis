-- Supabase setup for Homes library and GLB storage
-- Run this in the Supabase SQL Editor or via Supabase CLI.

-- 1) Create public.homes table
create table if not exists public.homes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  path text not null,
  public_url text not null,
  size bigint,
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.homes enable row level security;

-- Recreate policies safely (drop-if-exists)
drop policy if exists "homes_select_own" on public.homes;
drop policy if exists "homes_select_public" on public.homes;
drop policy if exists "homes_insert_own" on public.homes;
drop policy if exists "homes_update_own" on public.homes;
drop policy if exists "homes_delete_own" on public.homes;

-- Policies: owners can select/insert/update/delete their rows
-- Public can read all homes (global feed)
create policy "homes_select_public"
  on public.homes for select to public
  using (true);

create policy "homes_insert_own"
  on public.homes for insert to authenticated
  with check (user_id = auth.uid());

create policy "homes_update_own"
  on public.homes for update to authenticated
  using (user_id = auth.uid());

create policy "homes_delete_own"
  on public.homes for delete to authenticated
  using (user_id = auth.uid());

-- 2) Create a public Storage bucket for GLBs (idempotent)
insert into storage.buckets (id, name, public)
values ('glbs', 'glbs', true)
on conflict (id) do update set public = excluded.public;

-- Recreate storage policies safely (drop-if-exists)
drop policy if exists "glbs_public_read" on storage.objects;
drop policy if exists "glbs_insert_own_folder" on storage.objects;
drop policy if exists "glbs_update_own_folder" on storage.objects;
drop policy if exists "glbs_delete_own_folder" on storage.objects;

-- Public read access (only needed if is_public = true)
create policy "glbs_public_read"
  on storage.objects for select to public
  using (bucket_id = 'glbs');

-- Allow authenticated users to upload to a folder named by their uid (e.g., uid/filename.glb)
create policy "glbs_insert_own_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'glbs'
    and (auth.uid())::text = coalesce((storage.foldername(name))[1], '')
  );

-- Allow authenticated users to manage (update/delete) their own folder contents
create policy "glbs_update_own_folder"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'glbs'
    and (auth.uid())::text = coalesce((storage.foldername(name))[1], '')
  );

create policy "glbs_delete_own_folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'glbs'
    and (auth.uid())::text = coalesce((storage.foldername(name))[1], '')
  );

-- Notes:
-- - If you prefer a PRIVATE bucket, set is_public => false above and remove the public read policy.
-- - In that case, return signed URLs from your API/app instead of getPublicUrl.
-- - The app currently calls storage.getPublicUrl and expects public access.
