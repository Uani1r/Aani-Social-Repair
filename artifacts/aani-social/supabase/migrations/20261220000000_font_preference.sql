begin;

alter table public.profiles
  add column if not exists font_preference text not null default 'alexandria'
    check (font_preference in ('alexandria', 'ibm-plex-sans-arabic', 'tajawal', 'cairo', 'noto-sans-arabic'));

comment on column public.profiles.font_preference is 'The user-selected application-wide Arabic font family.';

commit;
