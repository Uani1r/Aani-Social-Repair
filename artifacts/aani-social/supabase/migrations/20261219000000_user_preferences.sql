begin;

alter table public.profiles
  add column if not exists notification_settings jsonb not null default '{"messages": true, "followers": true, "interactions": true, "stories": true}'::jsonb,
  add column if not exists appearance_preference text not null default 'dark' check (appearance_preference in ('dark', 'light', 'system')),
  add column if not exists language_preference text not null default 'ar' check (language_preference in ('ar', 'en')),
  add column if not exists hd_uploads boolean not null default true,
  add column if not exists data_saver boolean not null default false;

comment on column public.profiles.notification_settings is 'Per-user in-app notification category preferences.';
comment on column public.profiles.hd_uploads is 'Whether image uploads should retain their original quality.';
comment on column public.profiles.data_saver is 'Whether image uploads should be compressed to save data.';

commit;
