-- ============================================================================
-- إصلاح أعمدة المنشورات التي يطلبها استعلام الريلز/الواجهة
-- يُنفَّذ يدوياً في Supabase → SQL Editor. آمن للتكرار (idempotent).
--
-- السبب: استعلام جلب الريلز في usePosts.ts يطلب أعمدة العدّادات وخصائص
-- التفاعل (likes_count, comments_count, reposts_count, shares_count,
-- comments_disabled, hide_likes, hide_comments, comment_privacy) مع
-- media_urls / media_asset_id / trim_* … وكلها أضافتها ترحيلات قديمة.
-- عند إعادة بناء الجداول يدوياً يبقى أحدها ناقصاً فيرفض PostgREST الاستعلام
-- كاملاً (خطأ 42703) فلا يظهر أي ريل — مع أن الصفوف محفوظة وسليمة.
-- ============================================================================
begin;

do $$
begin
  if to_regclass('public.posts') is null then
    raise exception 'public.posts غير موجود: طبّق مخطط المشروع الأساسي أولاً.';
  end if;
end;
$$;

-- 1) عدّادات التفاعل (مصدرها ترحيلات 20261026000000 و20261030000000)
alter table public.posts
  add column if not exists likes_count integer not null default 0,
  add column if not exists comments_count integer not null default 0,
  add column if not exists reposts_count integer not null default 0,
  add column if not exists shares_count integer not null default 0;

-- 2) خصائص التفاعل والخصوصية (مصدرها ترحيلات 20261028000000 و20261125000000)
alter table public.posts
  add column if not exists comments_disabled boolean not null default false,
  add column if not exists hide_likes boolean not null default false,
  add column if not exists hide_comments boolean not null default false,
  add column if not exists comment_privacy text not null default 'public',
  add column if not exists allowed_commenters uuid[] not null default '{}'::uuid[];

-- 3) أعمدة الوسائط والصوت والوسوم (تُطلب في نفس الاستعلام)
alter table public.posts
  add column if not exists media_urls text[],
  add column if not exists media_asset_id uuid,
  add column if not exists tagged_user_ids uuid[],
  add column if not exists audio_url text,
  add column if not exists audio_title text,
  add column if not exists sound_id uuid,
  add column if not exists sound_trim_start real,
  add column if not exists sound_trim_end real,
  add column if not exists trim_start double precision,
  add column if not exists trim_end double precision,
  add column if not exists display_order integer not null default 0;

-- 4) تصحيح أي قيم فارغة/غير صالحة في الأعمدة الجديدة
update public.posts set likes_count = 0 where likes_count is null;
update public.posts set comments_count = 0 where comments_count is null;
update public.posts set reposts_count = 0 where reposts_count is null;
update public.posts set shares_count = 0 where shares_count is null;
update public.posts set comments_disabled = false where comments_disabled is null;
update public.posts set hide_likes = false where hide_likes is null;
update public.posts set hide_comments = false where hide_comments is null;
update public.posts
set comment_privacy = 'public'
where comment_privacy is null or comment_privacy not in ('public', 'followers', 'custom');

alter table public.posts drop constraint if exists posts_comment_privacy_check;
alter table public.posts
  add constraint posts_comment_privacy_check
  check (comment_privacy in ('public', 'followers', 'custom'))
  not valid;

-- 5) ضمان وجود ملف شخصي لكل ناشر (لا نضيف مفتاحاً أجنبياً: الواجهة تجلب
--    الملفات باستعلام منفصل ولا تعتمد على JOIN، والمفتاح قد يعطّل النشر)
do $$
begin
  insert into public.profiles (id, username, full_name)
  select distinct p.user_id,
         'user_' || substr(replace(p.user_id::text, '-', ''), 1, 8),
         'مستخدم'
  from public.posts p
  left join public.profiles pr on pr.id = p.user_id
  where p.user_id is not null
    and pr.id is null
  on conflict (id) do nothing;
exception
  when others then
    raise notice 'تخطّي تعبئة profiles: %', sqlerrm;
end;
$$;

-- 6) صلاحيات القراءة: الأعمدة العامة فقط (allowed_commenters يبقى خاصاً)
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'posts'
    and column_name in (
      'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
      'media_asset_id', 'type', 'destination', 'visibility', 'display_order',
      'created_at', 'likes_count', 'comments_count', 'reposts_count',
      'shares_count', 'comments_disabled', 'audio_url', 'audio_title',
      'sound_id', 'sound_trim_start', 'sound_trim_end', 'trim_start',
      'trim_end', 'tagged_user_ids', 'hide_likes', 'hide_comments',
      'comment_privacy'
    );

  if cols is not null then
    execute format('grant select (%s) on table public.posts to anon, authenticated', cols);
  end if;
end;
$$;

-- 7) صلاحيات الكتابة التي يحتاجها النشر والتعديل (Upsert = INSERT + UPDATE)
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by column_name)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'posts'
    and column_name in (
      'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
      'media_asset_id', 'type', 'destination', 'visibility', 'created_at',
      'tagged_user_ids', 'sound_id', 'audio_url', 'audio_title',
      'sound_trim_start', 'sound_trim_end', 'trim_start', 'trim_end',
      'display_order', 'hide_likes', 'hide_comments', 'comment_privacy'
    );

  if cols is not null then
    execute format('grant insert (%s) on table public.posts to authenticated', cols);
    execute format('grant update (%s) on table public.posts to authenticated', cols);
  end if;
end;
$$;

-- 8) فهارس مسار العرض
create index if not exists posts_destination_type_created_idx
  on public.posts (destination, type, created_at desc);
create index if not exists posts_user_created_idx
  on public.posts (user_id, created_at desc);
create index if not exists posts_media_asset_id_idx
  on public.posts (media_asset_id);

notify pgrst, 'reload schema';
commit;

-- ============================================================================
-- تحقق: أي عمود يتوقعه التطبيق ما زال ناقصاً؟ (يجب أن تكون كل القيم true)
-- ============================================================================
with expected(column_name) as (
  values
    ('id'), ('user_id'), ('content'), ('post_metadata'), ('media_url'),
    ('media_urls'), ('media_asset_id'), ('type'), ('destination'),
    ('visibility'), ('display_order'), ('created_at'), ('likes_count'),
    ('comments_count'), ('reposts_count'), ('shares_count'),
    ('comments_disabled'), ('audio_url'), ('audio_title'), ('sound_id'),
    ('sound_trim_start'), ('sound_trim_end'), ('trim_start'), ('trim_end'),
    ('tagged_user_ids'), ('hide_likes'), ('hide_comments'), ('comment_privacy')
)
select e.column_name,
       (c.column_name is not null) as exists
from expected e
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name = 'posts'
 and c.column_name = e.column_name
order by exists asc, e.column_name;
