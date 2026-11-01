-- حصر سياسة followers guard في SELECT ومنعها من تطبيقها على INSERT.
begin;

grant usage on schema public to authenticated;
grant select, insert, delete on public.stories to authenticated;
grant execute on function public.aani_create_story(text, text, text, boolean, integer, jsonb, text, uuid, text, integer) to authenticated;
grant execute on function public.aani_can_reshare_story(uuid, uuid, text, text) to authenticated;

-- إزالة السياسات القديمة والمتضاربة لعمليات الإدخال.
drop policy if exists "Users can create their own stories" on public.stories;
drop policy if exists "Users can insert stories" on public.stories;
drop policy if exists "Users insert own stories" on public.stories;
drop policy if exists aani_stories_insert_guard on public.stories;
drop policy if exists aani_stories_insert_own on public.stories;

-- إعادة إنشاء هذه السياسة كـ RESTRICTIVE لقراءة القصص فقط.
drop policy if exists aani_stories_followers_guard on public.stories;
create policy aani_stories_followers_guard on public.stories
  as restrictive
  for select to authenticated
  using (public.aani_can_view_story(id, (select auth.uid())));

-- سياسة الإدخال الوحيدة؛ تمرر مرجع الأصل إلى حارس إعادة المشاركة فقط عند وجوده.
create policy aani_stories_insert_own on public.stories
  as permissive
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and created_at >= now() - interval '24 hours'
    and created_at <= now() + interval '5 minutes'
    and expires_at > now()
    and expires_at <= created_at + interval '24 hours'
    and (
      (original_story_id is null and share_type = 'original')
      or (
        original_story_id is not null
        and share_type = 'reshare'
        and public.aani_can_reshare_story(
          original_story_id,
          (select auth.uid()),
          media_url,
          media_type
        )
      )
    )
  );

commit;
