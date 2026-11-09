begin;

alter table public.profiles
  add column if not exists is_deactivated boolean not null default false;

comment on column public.profiles.is_deactivated is 'يشير إلى تعطيل الحساب مؤقتاً حتى يسجل المستخدم الدخول مجدداً';

notify pgrst, 'reload schema';

commit;
