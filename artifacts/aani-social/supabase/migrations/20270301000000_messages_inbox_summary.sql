begin;

-- SECURITY DEFINER bypasses message RLS, so both RPCs explicitly restore the
-- participant, block, and per-user hide constraints used by the direct read path.
-- Parse client-side read cutoffs defensively: malformed local storage must not
-- make the authenticated inbox RPC fail.
create or replace function public.aani_try_parse_messages_inbox_cutoff(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public.aani_get_messages_inbox_summaries(
  p_read_at_by_contact jsonb default '{}'::jsonb,
  p_request_tab_read_at timestamptz default null
)
returns table (
  contact_id uuid,
  last_message jsonb,
  unread_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  return query
  with visible_messages as (
    select
      message.id,
      message.sender_id,
      message.recipient_id,
      message.content,
      message.created_at,
      message.delivered_at,
      message.read_at,
      case
        when message.sender_id = actor_id then message.recipient_id
        else message.sender_id
      end as contact_id
    from public.messages as message
    where (message.sender_id = actor_id or message.recipient_id = actor_id)
      and not public.aani_is_user_blocked(
        actor_id,
        case
          when message.sender_id = actor_id then message.recipient_id
          else message.sender_id
        end
      )
      and not exists (
        select 1
        from public.message_hides as hidden
        where hidden.user_id = actor_id
          and hidden.message_id = message.id
      )
  ), latest_messages as (
    select distinct on (visible.contact_id)
      visible.contact_id,
      visible.id,
      visible.sender_id,
      visible.recipient_id,
      visible.content,
      visible.created_at,
      visible.delivered_at,
      visible.read_at
    from visible_messages as visible
    order by visible.contact_id, visible.created_at desc, visible.id desc
  ), unread_messages as (
    select
      message.sender_id as contact_id,
      count(*) as unread_count
    from public.messages as message
    where message.recipient_id = actor_id
      and message.read_at is null
       and not public.aani_is_user_blocked(actor_id, message.sender_id)
      and message.created_at > greatest(
        coalesce(
          public.aani_try_parse_messages_inbox_cutoff(p_read_at_by_contact ->> message.sender_id::text),
          'epoch'::timestamptz
        ),
        coalesce(p_request_tab_read_at, 'epoch'::timestamptz)
      )
      and not exists (
        select 1
        from public.message_hides as hidden
        where hidden.user_id = actor_id
          and hidden.message_id = message.id
      )
    group by message.sender_id
  )
  select
    latest.contact_id,
    jsonb_build_object(
      'id', latest.id,
      'sender_id', latest.sender_id,
      'recipient_id', latest.recipient_id,
      'content', latest.content,
      'created_at', latest.created_at,
      'delivered_at', latest.delivered_at,
      'read_at', latest.read_at
    ),
    coalesce(unread.unread_count, 0)::bigint
  from latest_messages as latest
  left join unread_messages as unread on unread.contact_id = latest.contact_id
  order by latest.created_at desc, latest.id desc;
end;
$$;

-- Preserve the old inbox-load delivery acknowledgement without sending every
-- visible message row (or a potentially huge list of message IDs) to the client.
create or replace function public.aani_mark_inbox_messages_delivered()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  update public.messages as message
     set delivered_at = now()
   where message.recipient_id = actor_id
     and message.delivered_at is null
       and not public.aani_is_user_blocked(actor_id, message.sender_id)
     and not exists (
       select 1
       from public.message_hides as hidden
       where hidden.user_id = actor_id
         and hidden.message_id = message.id
     );
end;
$$;

revoke all on function public.aani_try_parse_messages_inbox_cutoff(text) from public, anon, authenticated;
revoke all on function public.aani_get_messages_inbox_summaries(jsonb, timestamptz) from public, anon;
revoke all on function public.aani_mark_inbox_messages_delivered() from public, anon;
grant execute on function public.aani_get_messages_inbox_summaries(jsonb, timestamptz) to authenticated;
grant execute on function public.aani_mark_inbox_messages_delivered() to authenticated;

commit;
