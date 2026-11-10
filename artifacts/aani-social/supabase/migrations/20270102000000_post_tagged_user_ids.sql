-- ترحيل: عمود معرفات المشار إليهم الصريح للمنشورات (tagged_user_ids)
-- يُطبق يدوياً في Supabase SQL Editor. آمن للتكرار (idempotent).

-- 1) العمود الجديد: مصفوفة UUIDs صريحة، افتراضياً فارغة
alter table public.posts
  add column if not exists tagged_user_ids uuid[] not null default '{}';

-- 2) فهرس GIN للسؤال السريع: المنشورات التي تحتوي معرفاً معيناً
create index if not exists posts_tagged_user_ids_idx
  on public.posts using gin (tagged_user_ids);

-- 3) تعبئة رجعية 1: من وسوم الإشارة المخزنة في post_metadata (kind: mention + profileId)
update public.posts p
set tagged_user_ids = array_cat(p.tagged_user_ids, sub.ids)
from (
  select
    p2.id,
    array_agg(distinct (m.value->>'profileId')::uuid) as ids
  from public.posts p2
  cross join lateral jsonb_array_elements(p2.post_metadata) as m(value)
  where jsonb_typeof(p2.post_metadata) = 'array'
    and m.value->>'kind' = 'mention'
    and m.value->>'profileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  group by p2.id
) sub
where p.id = sub.id
  and not (p.tagged_user_ids @> sub.ids);

-- 4) تعبئة رجعية 2: منوص المنشور الذي يحتوي @username كإشارة كاملة
update public.posts p
set tagged_user_ids = array_cat(p.tagged_user_ids, sub.ids)
from (
  select
    p2.id,
    array_agg(distinct u.id) as ids
  from public.posts p2
  join public.profiles u
    on u.username is not null
   and u.username <> ''
   and p2.content is not null
   and p2.content ~* ('@' || regexp_replace(u.username, '([.*+?^$|()\[\]{}\\])', '\\\1', 'g') || '([^A-Za-z0-9_.]|$)')
  group by p2.id
) sub
where p.id = sub.id
  and not (p.tagged_user_ids @> sub.ids);

-- ملاحظة: صلاحيات الجدول الحالية (grant select/insert/update/delete على public.posts)
-- تشمل الأعمدة الجديدة تلقائياً ولا حاجة لـ GRANT إضافي.
