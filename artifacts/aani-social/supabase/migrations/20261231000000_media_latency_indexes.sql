-- فهارس تسريع جلب الميديا والمنشورات والستوريات (بالملي ثانية):
-- تغطي استعلامات: شبكة الملف الشخصي، تبويب الفيديوهات، تبويب
-- الريبوست، صفحة الريلز، التعليقات، والستوريات النشطة.
-- طبّقها على Supabase (SQL Editor) أو عبر الإطلاق التلقائي للمigrations.

-- شبكة الملف الشخصي: منشورات المستخدم بالترتيب الزمني
create index if not exists posts_user_created_idx
  on public.posts (user_id, created_at desc);

-- فلتر التبويبات: نوع المنشور + وجهته (ريلز/تغذية) بالتاريخ
create index if not exists posts_type_destination_created_idx
  on public.posts (type, destination, created_at desc);

-- تبويب إعادات النشر: ريبوستات المستخدم من الأحدث للأقدم
create index if not exists reposts_user_created_idx
  on public.reposts (user_id, created_at desc);

-- انضمام الريبوست إلى منشوره الأصلي
create index if not exists reposts_post_idx
  on public.reposts (post_id);

-- ستوريات المستخدم النشطة (غير منتهية) للشرائط والعارض
create index if not exists stories_user_expires_idx
  on public.stories (user_id, expires_at desc);

-- تنظيف/استعلام الستوريات المنتهية
create index if not exists stories_expires_idx
  on public.stories (expires_at);

-- التعليقات لمنشور محدد بالترتيب (درج التعليقات يفتح بعد الميديا)
create index if not exists comments_post_created_idx
  on public.comments (post_id, created_at desc);
