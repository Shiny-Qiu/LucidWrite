-- ============================================================
-- editAI — Supabase schema + Row Level Security
-- Run this in the Supabase SQL editor to initialise the database.
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "uuid-ossp";

-- ---------- Tables ----------

-- User profiles (auto-created via trigger on auth.users insert)
create table if not exists public.profiles (
  id         uuid references auth.users on delete cascade primary key,
  email      text,
  created_at timestamptz default now()
);

-- Writing projects
create table if not exists public.projects (
  id         uuid default uuid_generate_v4() primary key,
  user_id    uuid references auth.users on delete cascade not null,
  name       text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, name)
);

-- Draft content (one per project)
create table if not exists public.drafts (
  id         uuid default uuid_generate_v4() primary key,
  project_id uuid references public.projects on delete cascade not null unique,
  user_id    uuid references auth.users on delete cascade not null,
  content    text not null default '',
  updated_at timestamptz default now()
);

-- Final article content (one per project)
create table if not exists public.finals (
  id         uuid default uuid_generate_v4() primary key,
  project_id uuid references public.projects on delete cascade not null unique,
  user_id    uuid references auth.users on delete cascade not null,
  content    text not null default '',
  updated_at timestamptz default now()
);

-- Per-user writing style fingerprint
create table if not exists public.style_fingerprints (
  user_id    uuid references auth.users on delete cascade primary key,
  content    text not null default '',
  skipped    boolean not null default false,
  updated_at timestamptz default now()
);

-- ---------- Row Level Security ----------

alter table public.profiles          enable row level security;
alter table public.projects          enable row level security;
alter table public.drafts            enable row level security;
alter table public.finals            enable row level security;
alter table public.style_fingerprints enable row level security;

-- profiles
create policy "select own profile"  on public.profiles for select using (auth.uid() = id);
create policy "update own profile"  on public.profiles for update using (auth.uid() = id);

-- projects
create policy "select own projects" on public.projects for select using (auth.uid() = user_id);
create policy "insert own projects" on public.projects for insert with check (auth.uid() = user_id);
create policy "update own projects" on public.projects for update using (auth.uid() = user_id);
create policy "delete own projects" on public.projects for delete using (auth.uid() = user_id);

-- drafts
create policy "select own drafts"   on public.drafts for select using (auth.uid() = user_id);
create policy "insert own drafts"   on public.drafts for insert with check (auth.uid() = user_id);
create policy "update own drafts"   on public.drafts for update using (auth.uid() = user_id);
create policy "delete own drafts"   on public.drafts for delete using (auth.uid() = user_id);

-- finals
create policy "select own finals"   on public.finals for select using (auth.uid() = user_id);
create policy "insert own finals"   on public.finals for insert with check (auth.uid() = user_id);
create policy "update own finals"   on public.finals for update using (auth.uid() = user_id);
create policy "delete own finals"   on public.finals for delete using (auth.uid() = user_id);

-- style_fingerprints
create policy "select own fingerprint" on public.style_fingerprints for select using (auth.uid() = user_id);
create policy "insert own fingerprint" on public.style_fingerprints for insert with check (auth.uid() = user_id);
create policy "update own fingerprint" on public.style_fingerprints for update using (auth.uid() = user_id);

-- ---------- Trigger: auto-create profile on signup ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
