-- Minimal schema for the account phone alias migration test: the pieces of
-- Supabase the migration and the test touch, nothing else.
--
-- auth.users is reduced to its primary key, the PostgREST/Supabase roles are
-- created when missing, and the public schema is left as it is.

create extension if not exists "pgcrypto";

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

-- Some Supabase databases carry a pre-existing public table with this name from
-- an earlier attempt; drop it so the migration creates it from scratch.
drop table if exists public.account_phone_aliases;

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333')
on conflict (id) do nothing;
