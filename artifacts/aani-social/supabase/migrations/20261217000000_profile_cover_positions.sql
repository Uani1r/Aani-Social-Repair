begin;

alter table public.profiles
  add column if not exists cover_position_x real not null default 50,
  add column if not exists cover_position_y real not null default 50;

comment on column public.profiles.cover_position_x is 'الموضع الأفقي لصورة غلاف الملف الشخصي كنسبة مئوية';
comment on column public.profiles.cover_position_y is 'الموضع العمودي لصورة غلاف الملف الشخصي كنسبة مئوية';

notify pgrst, 'reload schema';

commit;
