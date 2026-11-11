-- إصلاح صلاحيات قراءة جدول الملفات الشخصية:
-- خطأ 42501 "permission denied for table profiles" عند قراءة الملف الشخصي
-- يعني فقدان GRANT SELECT لدور authenticated على public.profiles.
-- تُعاد الصلاحيات هنا؛ سياسات RLS تبقى هي الحارس الفعلي للصفوف.
begin;

grant select on public.profiles to anon, authenticated;
grant insert, update on public.profiles to authenticated;

commit;
