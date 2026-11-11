-- أعمدة حدود قص الفيديو الصريحة لمنشورات الريلز:
-- التوقيتات كانت تُخزَّن فقط داخل ترميز HTML5 (#t=start,end) في media_url،
-- وأي فقد لهذا الرمز يفقد القص. نضيف عمودين صريحين مع تعبئة أولية
-- من الروابط الموجودة، مع قيد تحقق منطقي.
begin;

alter table public.posts
  add column if not exists trim_start double precision,
  add column if not exists trim_end double precision;

-- تعبئة أولية من ترميز #t=start,end المخزَّن في الروابط الحالية
update public.posts as p
set trim_start = src.bounds[1]::double precision,
    trim_end = src.bounds[2]::double precision
from (
  select id, regexp_match(media_url, '[#&]t=([0-9.]+),([0-9.]+)') as bounds
  from public.posts
  where type = 'reel'
    and media_url is not null
    and media_url ~ '[#&]t=[0-9.]+,[0-9.]+'
    and trim_start is null
) as src
where p.id = src.id
  and src.bounds[1]::double precision >= 0
  and src.bounds[2]::double precision > src.bounds[1]::double precision;

alter table public.posts
  drop constraint if exists posts_video_trim_check;

alter table public.posts
  add constraint posts_video_trim_check
    check (
      (trim_start is null and trim_end is null)
      or (trim_start >= 0 and trim_end > trim_start)
    );

commit;
