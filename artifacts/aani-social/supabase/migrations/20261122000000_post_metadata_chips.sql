-- Store post tags separately and migrate legacy inline tag suffixes when possible.
begin;

alter table public.posts
  add column if not exists post_metadata jsonb not null default '[]'::jsonb;

alter table public.posts drop constraint if exists posts_content_check;
alter table public.posts drop constraint if exists posts_content_length_check;

do $$
declare
  post_row record;
  remaining_lines text[];
  current_line text;
  captures text[];
  mention_profile_id uuid;
  tag jsonb;
  parsed_metadata jsonb;
begin
  for post_row in
    select id, content
    from public.posts
    where post_metadata = '[]'::jsonb
      and (
        content like '%الموقع: %'
        or content like '%الرابط: %'
        or content like E'%\n@%'
        or content like '@%'
      )
  loop
    remaining_lines := string_to_array(coalesce(post_row.content, ''), E'\n');
    parsed_metadata := '[]'::jsonb;

    loop
      exit when coalesce(cardinality(remaining_lines), 0) = 0;
      current_line := remaining_lines[array_length(remaining_lines, 1)];
      tag := null;

      captures := regexp_match(current_line, '^الموقع: (.+) — (https?://[^[:space:]]+)$');
      if captures is not null then
        tag := jsonb_build_object('kind', 'location', 'label', captures[1], 'href', captures[2]);
      else
        captures := regexp_match(current_line, '^الرابط: (https?://[^[:space:]]+)$');
        if captures is not null then
          tag := jsonb_build_object(
            'kind', 'link',
            'label', regexp_replace(captures[1], '^https?://([^/?#]+).*$', '\1', 'i'),
            'href', captures[1]
          );
        else
          captures := regexp_match(current_line, '^@([[:alnum:]_.]{3,32})$');
          if captures is not null then
            mention_profile_id := null;
            select id into mention_profile_id
            from public.profiles
            where lower(username) = lower(captures[1])
            limit 1;

            if mention_profile_id is not null then
              tag := jsonb_build_object(
                'kind', 'mention',
                'label', captures[1],
                'href', '/profile/' || mention_profile_id::text,
                'profileId', mention_profile_id::text
              );
            end if;
          end if;
        end if;
      end if;

      exit when tag is null;
      parsed_metadata := jsonb_build_array(tag) || parsed_metadata;
      if array_length(remaining_lines, 1) = 1 then
        remaining_lines := array[]::text[];
      else
        remaining_lines := remaining_lines[1:array_length(remaining_lines, 1) - 1];
      end if;
    end loop;

    if parsed_metadata <> '[]'::jsonb then
      update public.posts
      set content = coalesce(array_to_string(remaining_lines, E'\n'), ''),
          post_metadata = parsed_metadata
      where id = post_row.id;
    end if;
  end loop;
end
$$;

alter table public.posts drop constraint if exists posts_post_metadata_array_check;
alter table public.posts
  add constraint posts_post_metadata_array_check
  check (jsonb_typeof(post_metadata) = 'array') not valid;

alter table public.posts
  add constraint posts_content_length_check
  check (
    char_length(content) <= 2000
    and (
      char_length(btrim(content)) > 0
      or media_url is not null
      or post_metadata <> '[]'::jsonb
    )
  ) not valid;

notify pgrst, 'reload schema';

commit;
