begin;

alter table public.profiles
  add column if not exists city text,
  add column if not exists job text,
  add column if not exists birth_date date,
  add column if not exists show_city boolean not null default true,
  add column if not exists show_job boolean not null default false,
  add column if not exists show_birth_date boolean not null default false;

update public.profiles
set city = nullif(btrim(location), '')
where city is null and nullif(btrim(location), '') is not null;

comment on column public.profiles.city is 'City displayed in the public profile when show_city is enabled.';
comment on column public.profiles.job is 'Job title displayed in the public profile when show_job is enabled.';
comment on column public.profiles.birth_date is 'Profile owner birth date; hidden unless show_birth_date is enabled.';
comment on column public.profiles.show_city is 'Whether the profile owner allows their city to appear publicly.';
comment on column public.profiles.show_job is 'Whether the profile owner allows their job title to appear publicly.';
comment on column public.profiles.show_birth_date is 'Whether the profile owner allows their birth date to appear publicly.';

notify pgrst, 'reload schema';

commit;
