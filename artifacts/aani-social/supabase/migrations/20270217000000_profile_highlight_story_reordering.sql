begin;

-- إعادة ترتيب القصص داخل مجموعة أبرز قصص واحدة.
--
-- aani_reorder_profile_content تدعم 'posts' و'highlights' فقط، وتوقيعها يبقى
-- كما هو بلا أي تغيير. هذه الدالة المستقلة تضيف ترتيب القصص داخل مجموعة،
-- بعقد واضح: معرف المجموعة + قائمة معرفات القصص بالترتيب الجديد.
--
-- كل التحققات قبل أي تحديث، والعملية كلها في استدعاء واحد (transaction):
--   1. تسجيل الدخول مطلوب.
--   2. المجموعة يجب أن تكون ملك المستخدم الحالي.
--   3. لا معرفات مكررة في القائمة.
--   4. كل معرف في القائمة يجب أن يكون قصة داخل هذه المجموعة ويملكها المستخدم.
--   5. القائمة يجب أن تشمل كل قصص المجموعة بلا إسقاط أي قصة.
--   6. position يُحدَّث متسلسلاً من الصفر.
--   7. لا تُلمس أي مجموعة أو قصص أخرى (كل التحديثات مقيّدة بالمجموعة والمستخدم).
create or replace function public.aani_reorder_profile_highlight_stories(
  p_collection_id uuid,
  p_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_collection_owned boolean;
  v_requested_count bigint;
  v_owned_story_count bigint;
  v_collection_story_count bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_collection_id is null then
    raise exception using errcode = '22023', message = 'A highlight collection id is required';
  end if;

  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception using errcode = '22023', message = 'An ordered story list is required';
  end if;

  select exists (
    select 1
    from public.profile_highlight_collections as collection
    where collection.id = p_collection_id
      and collection.user_id = v_user_id
  ) into v_collection_owned;

  if not v_collection_owned then
    raise exception using errcode = '42501', message = 'The highlight collection is not owned by the current user';
  end if;

  v_requested_count := cardinality(p_ids);

  if v_requested_count <> (
    select count(distinct requested.id)
    from unnest(p_ids) as requested(id)
  ) then
    raise exception using errcode = '22023', message = 'The ordered story list contains duplicates';
  end if;

  select count(*)
  into v_owned_story_count
  from public.profile_highlights as highlight
  where highlight.collection_id = p_collection_id
    and highlight.user_id = v_user_id
    and highlight.id = any(p_ids);

  if v_owned_story_count <> v_requested_count then
    raise exception using errcode = '42501', message = 'One or more highlight stories do not belong to this collection';
  end if;

  select count(*)
  into v_collection_story_count
  from public.profile_highlights as highlight
  where highlight.collection_id = p_collection_id
    and highlight.user_id = v_user_id;

  if v_collection_story_count <> v_requested_count then
    raise exception using errcode = '22023', message = 'The ordered story list must contain every story of the collection';
  end if;

  update public.profile_highlights as highlight
  set position = requested.ordinality::integer - 1
  from unnest(p_ids) with ordinality as requested(id, ordinality)
  where highlight.id = requested.id
    and highlight.collection_id = p_collection_id
    and highlight.user_id = v_user_id;
end;
$$;

alter function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) owner to postgres;
revoke all on function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) from public;
grant execute on function public.aani_reorder_profile_highlight_stories(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
