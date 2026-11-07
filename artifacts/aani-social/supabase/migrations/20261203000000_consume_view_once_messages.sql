begin;

create or replace function public.aani_view_once_references_storage_object(
  p_content text,
  p_bucket_id text,
  p_object_name text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  media_payload jsonb;
  media_url text;
  object_path_suffix text;
begin
  if left(coalesce(p_content, ''), char_length('[aani-image:v1]')) <> '[aani-image:v1]' then
    return false;
  end if;

  begin
    media_payload := substring(p_content from char_length('[aani-image:v1]') + 1)::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(media_payload) is distinct from 'object'
     or media_payload ->> 'viewOnce' is distinct from 'true'
     or jsonb_typeof(media_payload -> 'urls') is distinct from 'array' then
    return false;
  end if;

  object_path_suffix := '/storage/v1/object/public/' || p_bucket_id || '/' || p_object_name;
  for media_url in select jsonb_array_elements_text(media_payload -> 'urls') loop
    if right(media_url, char_length(object_path_suffix)) = object_path_suffix then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

revoke all on function public.aani_view_once_references_storage_object(text, text, text) from public, anon;
grant execute on function public.aani_view_once_references_storage_object(text, text, text) to authenticated;

drop policy if exists "Recipients can delete consumed view-once media" on storage.objects;
create policy "Recipients can delete consumed view-once media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'aani-media'
    and exists (
      select 1
      from public.messages as message
      where message.recipient_id = (select auth.uid())
        and message.sender_id::text = (storage.foldername(name))[1]
        and public.aani_view_once_references_storage_object(message.content, bucket_id, name)
    )
  );

create or replace function public.aani_consume_view_once_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  target_message public.messages%rowtype;
  media_payload jsonb;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select message.*
    into target_message
    from public.messages as message
    where message.id = p_message_id
      and message.recipient_id = actor_id
    for update;

  if not found then
    raise exception 'View-once message is not available' using errcode = '42501';
  end if;

  if left(target_message.content, char_length('[aani-image:v1]')) <> '[aani-image:v1]' then
    raise exception 'Message is not a view-once image' using errcode = '22023';
  end if;

  begin
    media_payload := substring(target_message.content from char_length('[aani-image:v1]') + 1)::jsonb;
  exception when others then
    raise exception 'Invalid view-once message payload' using errcode = '22023';
  end;

  if jsonb_typeof(media_payload) <> 'object' or media_payload ->> 'viewOnce' is distinct from 'true' then
    raise exception 'Message is not a view-once image' using errcode = '22023';
  end if;

  if media_payload ->> 'opened' = 'true' then
    return;
  end if;

  update public.messages
    set content = '[aani-image:v1]' || jsonb_build_object(
      'urls', '[]'::jsonb,
      'caption', '',
      'viewOnce', true,
      'opened', true
    )::text
    where id = p_message_id;
end;
$$;

revoke all on function public.aani_consume_view_once_message(uuid) from public, anon;
grant execute on function public.aani_consume_view_once_message(uuid) to authenticated;

commit;
