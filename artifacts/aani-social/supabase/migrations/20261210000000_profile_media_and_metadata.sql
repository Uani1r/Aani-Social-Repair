begin;

alter table public.profiles
  add column if not exists cover_url text,
  add column if not exists location text,
  add column if not exists website text;

comment on column public.profiles.cover_url is 'رابط صورة غلاف الملف الشخصي';
comment on column public.profiles.location is 'موقع يختاره صاحب الملف الشخصي';
comment on column public.profiles.website is 'رابط الموقع الذي يختاره صاحب الملف الشخصي';

commit;
