-- Supabase setup for Projects table (run in SQL Editor or via Supabase CLI)

-- 1) Create public.projects table
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- Optional descriptive fields used by the app
  location text,
  style text,
  sqft numeric,
  price_amount numeric,
  description text,
  image_urls text[] not null default '{}',
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

-- Helpful indexes
create index if not exists projects_created_by_idx on public.projects(created_by);
create index if not exists projects_is_public_idx on public.projects(is_public);

-- 2) Enable Row Level Security and (re)create policies
alter table public.projects enable row level security;

drop policy if exists "projects_select_public" on public.projects;
drop policy if exists "projects_select_own" on public.projects;
drop policy if exists "projects_insert_own" on public.projects;
drop policy if exists "projects_update_own" on public.projects;
drop policy if exists "projects_delete_own" on public.projects;

-- Anyone can view public projects
create policy "projects_select_public"
  on public.projects for select to public
  using (is_public = true);

-- Owners can view their own projects (even if not public)
create policy "projects_select_own"
  on public.projects for select to authenticated
  using (created_by = auth.uid());

-- Owners can insert/update/delete their own projects
create policy "projects_insert_own"
  on public.projects for insert to authenticated
  with check (created_by = auth.uid());

create policy "projects_update_own"
  on public.projects for update to authenticated
  using (created_by = auth.uid());

create policy "projects_delete_own"
  on public.projects for delete to authenticated
  using (created_by = auth.uid());
