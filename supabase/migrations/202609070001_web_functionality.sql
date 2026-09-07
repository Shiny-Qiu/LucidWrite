-- Additive migration for the existing LucidWrite schema.
-- Transactional and repeatable. Does not delete projects, drafts or user accounts.
begin;

alter table public.projects add column if not exists state jsonb not null default '{}'::jsonb;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  providers jsonb not null default '{}'::jsonb,
  default_model text not null default '',
  updated_at timestamptz not null default now(),
  constraint user_settings_providers_object check (jsonb_typeof(providers) = 'object')
);
alter table public.user_settings enable row level security;
do $policy$
begin
  create policy "own settings" on public.user_settings for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null;
end;
$policy$;
revoke all on public.user_settings from anon;
grant select, insert, update, delete on public.user_settings to authenticated;

create table if not exists public.writing_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  project_name text not null,
  mode text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  request jsonb not null default '{}'::jsonb,
  output text not null default '',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists writing_tasks_user_project_created
  on public.writing_tasks (user_id, project_id, created_at desc);
alter table public.writing_tasks enable row level security;
do $policy$
begin
  create policy "own project tasks" on public.writing_tasks for all to authenticated
    using (user_id = auth.uid() and exists (
      select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
    ))
    with check (user_id = auth.uid() and exists (
      select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
    ));
exception when duplicate_object then null;
end;
$policy$;
revoke all on public.writing_tasks from anon;
grant select, insert, update, delete on public.writing_tasks to authenticated;

-- A user-owned draft/final must also reference a project owned by that user.
-- Restrictive policies combine with the original schema's ownership policies.
do $policy$
begin
  create policy "draft belongs to own project" on public.drafts as restrictive for all to authenticated
    using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
    with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));
exception when duplicate_object then null;
end;
$policy$;
do $policy$
begin
  create policy "final belongs to own project" on public.finals as restrictive for all to authenticated
    using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
    with check (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));
exception when duplicate_object then null;
end;
$policy$;

notify pgrst, 'reload schema';
commit;
