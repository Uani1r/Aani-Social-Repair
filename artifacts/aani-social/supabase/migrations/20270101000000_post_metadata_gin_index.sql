-- فهرس GIN لعمود post_metadata (خانة الإشارات/الوسوم jsonb):
-- يسرّع فلتر الإشارات في تبويب «المنشورات المشار فيها»
-- (post_metadata @> {"kind":"mention","profileId":...}) وتجعل
-- الاستعلام يعمل بملي ثانية بدل الفحص الكامل للجدول.
-- عمود post_metadata موجود أصلاً من ترحيل 20261122000000 — لا تعديل مخطط هنا.
begin;

create index if not exists posts_post_metadata_gin_idx
  on public.posts using gin (post_metadata jsonb_path_ops);

notify pgrst, 'reload schema';

commit;
