-- ============================================================================
-- إصلاح خطأ PostgreSQL 42702 في public.aani_record_story_view
--   column reference "viewer_id" is ambiguous
--
-- السبب: كان المتغير المحلي في الدالة اسمه viewer_id، وهو نفس اسم عمود
-- public.story_views.viewer_id المذكور في INSERT وON CONFLICT، فيلتبس على
-- المحلّل أيهما المقصود.
--
-- هذا الترحيل يعيد تعريف الدالة نفسها بتوقيعها نفسها، ويُسمّي المتغير
-- v_viewer_id. لا تغيير على اسم الدالة أو توقيعها ولا على جدول story_views
-- أو أعمدته (story_id, viewer_id) ولا على ON CONFLICT ولا على فحص
-- aani_can_view_story ولا على استثناء صاحب القصة من مشاهدة قصته.
-- يعيد النسخة المطبَّقة فعلاً في قاعدة الإنتاج إلى المستودع.
-- ============================================================================

create or replace function public.aani_record_story_view(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_viewer_id uuid := auth.uid();
begin
  if v_viewer_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_story_id is null then
    raise exception 'Story id is required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.stories as story
    where story.id = p_story_id
      and story.user_id <> v_viewer_id
      and public.aani_can_view_story(story.id, v_viewer_id)
  ) then
    raise exception 'Story is not available to this viewer' using errcode = '42501';
  end if;
  insert into public.story_views (story_id, viewer_id)
  values (p_story_id, v_viewer_id)
  on conflict (story_id, viewer_id) do update
    set created_at = now();
end;
$function$;
revoke all on function public.aani_record_story_view(uuid)
from public, anon, authenticated;
grant execute on function public.aani_record_story_view(uuid)
to authenticated;
