-- Create/ensure public avatars bucket (idempotent across versions)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

-- Ensure glbs bucket is public (noop if already public)
-- Ensure glbs bucket is public
update storage.buckets set public = true where id = 'glbs';

-- RLS policies on storage.objects for avatars
-- Allow anyone to read avatars (they are public)
drop policy if exists "Public read for avatars" on storage.objects;
create policy "Public read for avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Only authenticated users can upload their own avatar object path
drop policy if exists "Users can upload their own avatars" on storage.objects;
create policy "Users can upload their own avatars"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and auth.role() = 'authenticated'
    and left(name, length(auth.uid()::text) + 1) = auth.uid()::text || '/'
  );

-- Users can update their own avatar objects
drop policy if exists "Users can update their own avatars" on storage.objects;
create policy "Users can update their own avatars"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and left(name, length(auth.uid()::text) + 1) = auth.uid()::text || '/'
  )
  with check (
    bucket_id = 'avatars'
    and left(name, length(auth.uid()::text) + 1) = auth.uid()::text || '/'
  );

-- Users can delete their own avatar objects
drop policy if exists "Users can delete their own avatars" on storage.objects;
create policy "Users can delete their own avatars"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and left(name, length(auth.uid()::text) + 1) = auth.uid()::text || '/'
  );

-- Public read for glbs (thumbnails/models)
drop policy if exists "Public read for glbs" on storage.objects;
create policy "Public read for glbs"
  on storage.objects for select
  using (bucket_id = 'glbs');
