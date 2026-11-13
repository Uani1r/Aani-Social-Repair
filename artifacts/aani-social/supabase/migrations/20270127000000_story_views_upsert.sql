-- ترقية دالة تسجيل مشاهدة القصة:
-- 1) تعمل على أعمدة story_views الفعلية (viewer_id) لا user_id — النسخة
--    السابقة من الترحيل 20261116000000 تُدرج user_id فتفشل 42703 صامتة
--    ويبقى عداد المشاهدات صفراً.
-- 2) upsert: أي سجل سابق (حتى "المعاينة" القديمة) يُحدَّث ويُرقّى فوراً
--    إلى مشاهدة كاملة محتسبة بتحديث created_at/viewed_at للآن.
-- 3) تسجيل المشاهدة فوري عند فتح القصة — لا وضع معلّق ولا مهلة.
begin;

create or replace function public.aani_record_story_view(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.stories as story
    where story.id = p_story_id
      and story.user_id <> viewer_id
      and public.aani_can_view_story(story.id, viewer_id)
  ) then
    raise exception 'Story is not available to this viewer' using errcode = '42501';
  end if;

  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, viewer_id)
  on conflict (story_id, viewer_id) do update
    set created_at = now();
end;
$$;

revoke all on function public.aani_record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
