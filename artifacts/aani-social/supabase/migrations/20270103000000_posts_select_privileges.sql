-- ترحيل: إصلاح صلاحيات القراءة من جدول المنشورات (خطأ 42501 permission denied)
-- يُطبق يدوياً في Supabase SQL Editor. آمن للتكرار (idempotent).

-- 1) منح القراءة للمجهولين والمستخدمين المسجلين
grant select on public.posts to anon, authenticated;

-- 2) التأكد من منح الكتابة للمستخدمين المسجلين (نشر/تعديل/حذف منشوراتهم)
grant insert, update, delete on public.posts to authenticated;

-- 3) سياسة RLS للقراءة للمستخدمين المسجلين (إن كانت مفقودة)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'Signed-in users can read posts'
  ) then
    create policy "Signed-in users can read posts"
      on public.posts for select to authenticated
      using (true);
  end if;
end $$;

-- 4) سياسة قراءة للمجهولين: المنشورات العامة فقط (دفاعي — التطبيق يتطلب تسجيل الدخول)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'Public can read public posts'
  ) then
    create policy "Public can read public posts"
      on public.posts for select to anon
      using (visibility = 'public' or visibility is null);
  end if;
end $$;
