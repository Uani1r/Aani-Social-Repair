-- ترحيل: توسيع تغطية aani_can_read_media_object لتصبح كل وسائط التطبيق محسومة
--
-- 20270206000000 أنشأت الدالة، لكنها تغطي صورة/غلاف الملف، ووسائط المنشور،
-- والقصص، وأبرز القصص فقط. نتيجةً لذلك، تفعيل Restricted access في ImageKit
-- (أو VITE_IMAGEKIT_SIGNED_URLS في الواجهة) يعني رفض كل وسيط خارج تلك الأنواع
-- بـ403 — أي صور المحادثات والرسائل الصوتية والمستندات ومرفقات التعليقات
-- والملصقات وأصوات الستوري. وهذا الترحيل يُغلق تلك الفجوات دون توسيع الصلاحيات:
-- كل فرع جديد مربوط بنفس صلاحية قراءة المحتوى الذي يستخدم الملف.
--
-- 1) aani_media_path: تطبيع أوسع
--    * يحذف أي مقطع تحويلات `tr:...` (تحويلات ImageKit) قبل المقارنة، فلا
--      يستطيع طلب مسار محوَّل أن يتجاوز مطابقة المسار المخزَّن.
--    * يحذف مقطع `ik-thumbnail.jpg` الأخير، فتُقاس صلاحية المصغّرة بصلاحية
--      الفيديو نفسه — لا صلاحية مستقلة تُفتح للمصغّرات.
--    * لا يقبل مخططاً/مضيفاً ولا مقاطع فارغة، و`..` لا تُطبَّع إلى مسار آخر:
--      النتيجة سلسلة مقارنة واحدة بالتساوي (لا بـLIKE)، فلا تعمل `%` و`_`
--      في اسم الملف كبدائل، ولا يطابق مسارٌ مُلفَّق مساراً مخزَّناً.
--
-- 2) aani_media_owner_id: معرّف صاحب الملف من بنية الرفع الفعلية
--    الرفع يضع الملف في `<endpointId>/aani/<userId>/<folder>/<file>`
--    (storyUpload.ts: folder = `/aani/${cleanPath}`). التعريف السابق كان
--    يقارن المقطع الأول بـauth.uid()، أي بمعرّف حساب ImageKit — فلا يتحقق أبداً.
--
-- 3) aani_can_read_media_object: يُعاد بناؤها بأفرع مشروطة بالجداول الموجودة
--    فعلاً (قاعدة بُنيت من schema.sql تفتقد بعضها).
--
--    القاعدة الحاكمة في كل فرع: **صلاحية قراءة المحتوى + صاحب الملف**.
--    الشرط الثاني ليس تحصيلاً حاصلاً: بدونه يكفي أن يضع مستخدم مسار ملف شخص
--    آخر في تعليقه أو في رسالة يرسلها لنفسه ليحصل على توقيع الملف.
--
--      * الملفات      : صاحب المسار = المشاهد (بنية الرفع الفعلية أدناه).
--      * الملفات      : أو صورة/غلاف ملف شخصي (معلومة عامة لكل مسجّل).
--      * المنشورات    : media_url / media_urls / audio_url + media_assets
--                       عبر aani_can_read_post (خصوصية + حجب).
--      * القصص        : media_url / thumbnail_url عبر aani_can_view_story.
--      * أبرز القصص   : via aani_can_view_profile_highlight + أغلفة المجموعات.
--      * التعليقات    : comments.image_url عبر aani_can_view_post_comments
--                       **و** الملف من رفع كاتب التعليق.
--      * المحادثات    : المستدعي طرف في الرسالة، والرابط مذكور في content،
--                       **و** صاحب الملف أحد طرفيها — يغطي [aani-image]
--                       و[aani-voice] و[aani-document] و[aani-sticker]
--                       وردود الستوري بصورة.
--      * الإشعارات    : metadata إشعار يملكه المستدعي **و** الملف من رفعه.
--      * الأصوات      : preview_url/cover_url/audio_url مكتبة عامة لكل مسجّل
--                       (سياسة sounds نفسها using(true))، أما source_video_url
--                       فيتبع صلاحية منشوره الأصلي أو منشورات تستخدمه.
--
-- لا يغيّر أي جدول أو عمود أو سياسة، ولا يمس RLS، ولا يطبّق إعداداً على
-- ImageKit. آمن للتكرار.
begin;

-- ---------------------------------------------------------------------
-- 0) المتطلبات المسبقة
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.posts') is null then
    raise exception 'الجداول الأساسية (profiles, posts) غير موجودة — لا يمكن تطبيق هذا الترحيل';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_media_path'
  ) then
    raise exception 'الدالة public.aani_media_path مفقودة — طبّق 20270206000000 أولاً';
  end if;

  if not exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname = 'aani_can_read_post'
  ) then
    raise exception 'الدالة public.aani_can_read_post مفقودة — طبّق 20270203000000 أولاً';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) تطبيع المسار — أوسع من 20270206000000 (تحويلات + مصغّرة الفيديو)
-- ---------------------------------------------------------------------
create or replace function public.aani_media_path(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with cleaned as (
    select ltrim(
      regexp_replace(
        regexp_replace(
          split_part(split_part(btrim(coalesce(p_value, '')), '#', 1), '?', 1),
          '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+',
          ''
        ),
        '^/?storage/v1/object/(public|sign)/[^/]+/',
        ''
      ),
      '/'
    ) as value
  ),
  segments as (
    select array(
      select segment
      from unnest(string_to_array(value, '/')) as segment
      where segment <> ''
        -- مقاطع تحويلات ImageKit (tr:w-400,h-300) ليست جزءاً من اسم الملف
        and segment !~* '^tr:'
    ) as parts
    from cleaned
  )
  select nullif(
    array_to_string(
      case
        -- مصغّرة الفيديو التلقائية تُقاس بصلاحية الفيديو نفسه
        when cardinality(parts) > 1
         and parts[cardinality(parts)] ~* '^ik-thumbnail\.(jpg|jpeg|png|webp)$'
          then parts[1:cardinality(parts) - 1]
        else parts
      end,
      '/'
    ),
    ''
  )
  from segments;
$$;

revoke all on function public.aani_media_path(text) from public, anon;
grant execute on function public.aani_media_path(text) to authenticated;

-- ---------------------------------------------------------------------
-- 2) صاحب الملف من بنية الرفع الفعلية
--    <endpointId>/aani/<userId>/... أو /aani/<userId>/... (بلا البادئة)
--    يُعيد null لأي مسار لا يطابق ذلك، فلا تُمنح أولوية بالخطأ.
--    مقارنة المعرّف بـauth.uid() تجري في الدالة الكبرى.
-- ---------------------------------------------------------------------
create or replace function public.aani_media_owner_id(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with parts as (
    select string_to_array(coalesce(public.aani_media_path(p_value), ''), '/') as segments
  ),
  candidate as (
    select case
      when cardinality(segments) >= 3 and segments[2] = 'aani' then segments[3]
      when cardinality(segments) >= 2 and segments[1] = 'aani' then segments[2]
      -- احتياط لمسار التخزين القديم: <userId>/<file>
      when cardinality(segments) >= 1 then segments[1]
      else null
    end as owner_id
    from parts
  )
  select case
    when owner_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then lower(owner_id)
    else null
  end
  from candidate;
$$;

revoke all on function public.aani_media_owner_id(text) from public, anon;
grant execute on function public.aani_media_owner_id(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3) قرار الوصول: يُبنى الجسم بحسب الجداول والأعمدة الموجودة فعلاً
-- ---------------------------------------------------------------------
do $$
declare
  checks text := '';
  has_column boolean;
  url_columns text[];
  column_name text;
  match_terms text[];
  term text;

  has_audio_url boolean := false;
  has_media_asset_field boolean := false;
  has_story boolean := false;
  has_story_thumbnail boolean := false;
  has_highlight boolean := false;
  has_highlight_collections boolean := false;
  has_comment_attachments boolean := false;
  has_messages boolean := false;
  has_notification_metadata boolean := false;
  has_sounds boolean := false;
  has_sounds_source_post boolean := false;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'posts' and column_name = 'audio_url'
  ) into has_audio_url;

  -- وسائط سجلّات المعالجة (video_url/poster_url/original_path...) — عبر المنشور
  select
    to_regclass('public.media_assets') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'posts' and column_name = 'media_asset_id'
    )
  into has_media_asset_field;

  select
    to_regclass('public.stories') is not null
    and exists (
      select 1 from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public' and proc.proname = 'aani_can_view_story'
    )
  into has_story;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stories' and column_name = 'thumbnail_url'
  ) into has_story_thumbnail;

  select
    to_regclass('public.profile_highlights') is not null
    and exists (
      select 1 from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public' and proc.proname = 'aani_can_view_profile_highlight'
    )
  into has_highlight;

  select has_highlight and to_regclass('public.profile_highlight_collections') is not null
  into has_highlight_collections;

  select
    to_regclass('public.comments') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'comments' and column_name = 'image_url'
    )
    and exists (
      select 1 from pg_proc as proc
      join pg_namespace as namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public' and proc.proname = 'aani_can_view_post_comments'
    )
  into has_comment_attachments;

  select to_regclass('public.messages') is not null into has_messages;

  select
    to_regclass('public.notifications') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'notifications' and column_name = 'metadata'
    )
  into has_notification_metadata;

  select to_regclass('public.sounds') is not null into has_sounds;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sounds' and column_name = 'source_post_id'
  ) into has_sounds_source_post;

  -- ((أ)) رفعات المستخدم نفسه وفق بنية ImageKit الفعلية، ثم بنية التخزين القديمة
  checks := checks || $chunk$
  if public.aani_media_owner_id(p_object_name) = v_viewer::text then
    return true;
  end if;

  if split_part(v_target, '/', 1) = v_viewer::text then
    return true;
  end if;
  $chunk$;

  -- ((ب)) صورة أو غلاف ملف شخصي: معلومة عامة لكل مستخدم مسجّل
  checks := checks || $chunk$
  if exists (
    select 1
    from public.profiles as profile
    where public.aani_media_path(profile.avatar_url) = v_target
       or public.aani_media_path(profile.cover_url) = v_target
  ) then
    return true;
  end if;
  $chunk$;

  -- ((ج)) وسائط منشور: media_url / media_urls / audio_url — بصلاحية قراءة المنشور
  match_terms := array['public.aani_media_path(post.media_url) = v_target'];
  if has_audio_url then
    match_terms := match_terms || 'public.aani_media_path(post.audio_url) = v_target'::text;
  end if;
  match_terms := match_terms || $term$exists (
          select 1
          from unnest(coalesce(post.media_urls, '{}'::text[])) as media_url
          where public.aani_media_path(media_url) = v_target
        )$term$::text;

  checks := checks || format($chunk$
  if exists (
    select 1
    from public.posts as post
    where (%s)
      and public.aani_can_read_post(post.id, v_viewer)
  ) then
    return true;
  end if;
  $chunk$, array_to_string(match_terms, ' or '));

  -- ((د)) سجلّات معالجة الوسائط المرتبطة بمنشور
  if has_media_asset_field then
    match_terms := array[]::text[];
    foreach column_name in array array[
      'video_url', 'poster_url', 'original_path', 'storage_path', 'processed_path'
    ]
    loop
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'media_assets' and column_name = column_name
      ) into has_column;
      if has_column then
        match_terms := match_terms
          || format('public.aani_media_path(asset.%I) = v_target', column_name);
      end if;
    end loop;

    if cardinality(match_terms) > 0 then
      checks := checks || format($chunk$
  if exists (
    select 1
    from public.posts as post
    join public.media_assets as asset on asset.id = post.media_asset_id
    where (%s)
      and public.aani_can_read_post(post.id, v_viewer)
  ) then
    return true;
  end if;
  $chunk$, array_to_string(match_terms, ' or '));
    end if;
  end if;

  -- ((هـ)) وسائط القصص + مصغّراتها عبر aani_can_view_story
  if has_story then
    match_terms := array['public.aani_media_path(story.media_url) = v_target'];
    if has_story_thumbnail then
      match_terms := match_terms
        || 'public.aani_media_path(story.thumbnail_url) = v_target'::text;
    end if;

    checks := checks || format($chunk$
  if exists (
    select 1
    from public.stories as story
    where (%s)
      and public.aani_can_view_story(story.id, v_viewer)
  ) then
    return true;
  end if;
  $chunk$, array_to_string(match_terms, ' or '));
  end if;

  -- ((و)) أبرز القصص: العنصر ثم غلاف المجموعة
  if has_highlight then
    checks := checks || $chunk$
  if exists (
    select 1
    from public.profile_highlights as highlight
    where public.aani_media_path(highlight.media_url) = v_target
      and public.aani_can_view_profile_highlight(highlight.user_id, highlight.is_close_friends)
  ) then
    return true;
  end if;
    $chunk$;
  end if;

  if has_highlight_collections then
    checks := checks || $chunk$
  if exists (
    select 1
    from public.profile_highlight_collections as collection
    where public.aani_media_path(collection.cover_url) = v_target
      and (
        collection.user_id = v_viewer
        or exists (
          select 1
          from public.profile_highlights as item
          where item.collection_id = collection.id
            and public.aani_can_view_profile_highlight(item.user_id, item.is_close_friends)
        )
      )
  ) then
    return true;
  end if;
    $chunk$;
  end if;

  -- ((ز)) مرفقات التعليقات: صلاحية قراءة تعليقات المنشور + الملف من رفع كاتب
  --    التعليق. الشرط الثاني يمنع إدراج رابط ملف خاص في تعليق على منشور عام
  --    كطريق لقراءته.
  if has_comment_attachments then
    checks := checks || $chunk$
  if exists (
    select 1
    from public.comments as comment_row
    where public.aani_media_path(comment_row.image_url) = v_target
      and public.aani_can_view_post_comments(comment_row.post_id, v_viewer)
      and public.aani_media_owner_id(p_object_name) = comment_row.user_id::text
  ) then
    return true;
  end if;
    $chunk$;
  end if;

  -- ((ح)) المحادثات: المستدعي طرف في الرسالة، والرابط مذكور في content،
  --    وصاحب الملف أحد طرفي المحادثة.
  --    كل وسائط المحادثات تُخزَّن كروابط داخل messages.content:
  --    [aani-image:v1]{urls:[...]} / [aani-voice:v1]{url} /
  --    [aani-document:v1]{url} / [aani-sticker:v1]{url} / ردود ستوري بصورة.
  --    تُستخرج كل روابط https من المحتوى، تُطبَّع، ثم تُقارن بالتساوي مع المسار
  --    المطلوب — لا مطابقة جزئية. وشرط صاحب الملف ضروري: بدونه يكفي أن يرسل
  --    مستخدم لنفسه رابط ملف شخص آخر ليحصل على توقيعه.
  --    (regexp_matches بلا مجموعات التقاط تُعيد مصفوفة نصية: [1] هي المطابقة.)
  if has_messages then
    checks := checks || $chunk$
  if exists (
    select 1
    from public.messages as message
    where (message.sender_id = v_viewer or message.recipient_id = v_viewer)
      and message.content like '%' || v_file_name || '%'
      and exists (
        select 1
        from regexp_matches(message.content, 'https?://[^[:space:]"<>]+', 'g') as found(match)
        where public.aani_media_path(found.match[1]) = v_target
      )
      and public.aani_media_owner_id(p_object_name) in (
        message.sender_id::text,
        message.recipient_id::text
      )
  ) then
    return true;
  end if;
    $chunk$;
  end if;

  -- ((ط)) بيانات إشعار يملكه المستدعي، والملف من رفعه (مصغّرة ستوري صاحب
  --    الإشعار). لا يُقبل ملف غيره في metadata إشعاره.
  if has_notification_metadata then
    checks := checks || $chunk$
  if exists (
    select 1
    from public.notifications as notification
    where notification.user_id = v_viewer
      and public.aani_media_owner_id(p_object_name) = notification.user_id::text
      and coalesce(notification.metadata, '{}'::jsonb)::text like '%' || v_file_name || '%'
      and exists (
        select 1
        from regexp_matches(coalesce(notification.metadata, '{}'::jsonb)::text, 'https?://[^[:space:]"<>]+', 'g') as found(match)
        where public.aani_media_path(found.match[1]) = v_target
      )
  ) then
    return true;
  end if;
    $chunk$;
  end if;

  -- ((ي)) الأصوات: المعاينة والغلاف مكتبة عامة لكل مسجّل (سياسة sounds using(true))،
  --    أما فيديو المصدر فيتبع صلاحية منشوره الأصلي أو المنشورات التي تستخدمه.
  if has_sounds then
    url_columns := array[]::text[];
    foreach column_name in array array['preview_url', 'cover_url', 'audio_url']
    loop
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'sounds' and column_name = column_name
      ) into has_column;
      if has_column then
        url_columns := url_columns
          || format('public.aani_media_path(sound.%I) = v_target', column_name);
      end if;
    end loop;

    if cardinality(url_columns) > 0 then
      checks := checks || format($chunk$
  if exists (
    select 1
    from public.sounds as sound
    where %s
  ) then
    return true;
  end if;
      $chunk$, array_to_string(url_columns, ' or '));
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'sounds' and column_name = 'source_video_url'
    ) then
      term := 'sound.creator_id = v_viewer';
      if has_sounds_source_post then
        term := term || ' or public.aani_can_read_post(sound.source_post_id, v_viewer)';
      end if;
      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'posts' and column_name = 'sound_id'
      ) then
        term := term || $term$
        or exists (
          select 1
          from public.posts as using_post
          where using_post.sound_id = sound.id
            and public.aani_can_read_post(using_post.id, v_viewer)
        )$term$;
      end if;

      checks := checks || format($chunk$
  if exists (
    select 1
    from public.sounds as sound
    where public.aani_media_path(sound.source_video_url) = v_target
      and (%s)
  ) then
    return true;
  end if;
      $chunk$, term);
    end if;
  end if;

  -- تحذيرات صريحة لأنواع لم تُشمل بسبب جدول غائب (لا فشل: قاعدة أقدم)
  if not has_messages then
    raise warning 'الجدول public.messages غائب: وسائط المحادثات خارج قرار الوسائط';
  end if;
  if not has_comment_attachments then
    raise warning 'comments.image_url أو aani_can_view_post_comments غائبة: مرفقات التعليقات خارج قرار الوسائط';
  end if;

  execute format($fn$
    create or replace function public.aani_can_read_media_object(p_object_name text)
    returns boolean
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $body$
    declare
      v_target text := public.aani_media_path(p_object_name);
      v_viewer uuid := auth.uid();
      -- اسم الملف وحده: مُرشِّح رخيص قبل مسح حقول النصوص الطويلة
      -- (content و metadata)، ثم تُجرى المطابقة الدقيقة على المسار الكامل.
      v_file_name text := regexp_replace(
        coalesce(public.aani_media_path(p_object_name), ''), '^.*/', ''
      );
    begin
      if v_viewer is null or v_target is null then
        return false;
      end if;
%s
      return false;
    end;
    $body$;
  $fn$, checks);

  execute 'revoke all on function public.aani_can_read_media_object(text) from public, anon';
  execute 'grant execute on function public.aani_can_read_media_object(text) to authenticated';

  raise notice 'أفرع قرار الوسائط المفعّلة: owner, profile, posts%s%s%s%s%s%s%s',
    case when has_media_asset_field then ', media_assets' else '' end,
    case when has_story then ', stories' else '' end,
    case when has_highlight then ', highlights' else '' end,
    case when has_highlight_collections then ', collections' else '' end,
    case when has_comment_attachments then ', comments' else '' end,
    case when has_messages then ', messages' else '' end,
    case when has_sounds then ', sounds' else '' end;
end $$;

-- ---------------------------------------------------------------------
-- 4) تحقق داخل الترحيل
-- ---------------------------------------------------------------------
do $$
declare
  source text;
  is_definer boolean;
  is_stable boolean;
  config text;
  sample_owner text;
begin
  select proc.prosrc, proc.prosecdef, proc.provolatile = 's', array_to_string(proc.proconfig, ',')
  into source, is_definer, is_stable, config
  from pg_proc as proc
  join pg_namespace as namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public' and proc.proname = 'aani_can_read_media_object'
  limit 1;

  if source is null or not is_definer then
    raise exception 'aani_can_read_media_object مفقودة أو ليست SECURITY DEFINER';
  end if;

  if not is_stable then
    raise exception 'aani_can_read_media_object ليست STABLE';
  end if;

  if coalesce(config, '') not like '%search_path=%' then
    raise exception 'aani_can_read_media_object بلا search_path مغلق';
  end if;

  if source not like '%aani_media_owner_id%' then
    raise exception 'aani_can_read_media_object لا تستخدم بنية رفع المستخدم aani_media_owner_id';
  end if;

  if source not like '%aani_can_read_post%' then
    raise exception 'aani_can_read_media_object لا تتحقق من صلاحية قراءة المنشور';
  end if;

  -- كل نوع طُلب في هذا الترحيل لا بد أن يظهر في الجسم متى كانت جدوله موجودة،
  -- وأن يحمل شرط صاحب الملف حيث يلزم (وإلا صار إدراج رابط الغير طريقاً للوصول).
  if to_regclass('public.messages') is not null then
    if source not like '%public.messages%' then
      raise exception 'وسائط المحادثات غير مشمولة في قرار الوسائط';
    end if;
    if source not like '%message.sender_id::text%' then
      raise exception 'المحادثات بلا تحقق من صاحب الملف — يمكن إدراج رابط غيره في رسالة';
    end if;
  end if;

  if to_regclass('public.comments') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'comments' and column_name = 'image_url'
     ) then
    if source not like '%comment_row.image_url%' then
      raise exception 'مرفقات التعليقات غير مشمولة في قرار الوسائط';
    end if;
    if source not like '%comment_row.user_id::text%' then
      raise exception 'مرفقات التعليقات بلا تحقق من كاتب التعليق — يمكن إدراج رابط غيره';
    end if;
  end if;

  if to_regclass('public.sounds') is not null and source not like '%public.sounds%' then
    raise exception 'أصوات القصص غير مشمولة في قرار الوسائط';
  end if;

  if to_regclass('public.notifications') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'notifications' and column_name = 'metadata'
     )
     and source not like '%notification.user_id::text%' then
    raise exception 'الإشعارات بلا تحقق من صاحب الملف';
  end if;

  -- تطبيع المسار: التحويلات والمصغّرة لا تُغيّر هوية الملف
  if public.aani_media_path('https://ik.imagekit.io/abc123/aani/7f1c/a.jpg?ik-t=1&ik-s=2&tr=q-auto')
     is distinct from 'abc123/aani/7f1c/a.jpg' then
    raise exception 'تطبيع مسار ImageKit فشل: %',
      public.aani_media_path('https://ik.imagekit.io/abc123/aani/7f1c/a.jpg?ik-t=1&ik-s=2&tr=q-auto');
  end if;

  if public.aani_media_path('https://ik.imagekit.io/abc123/tr:w-300,h-300/aani/7f1c/a.jpg')
     is distinct from 'abc123/aani/7f1c/a.jpg' then
    raise exception 'حذف مقاطع التحويلات tr: فشل: %',
      public.aani_media_path('https://ik.imagekit.io/abc123/tr:w-300,h-300/aani/7f1c/a.jpg');
  end if;

  if public.aani_media_path('https://ik.imagekit.io/abc123/aani/7f1c/v.mp4/ik-thumbnail.jpg')
     is distinct from 'abc123/aani/7f1c/v.mp4' then
    raise exception 'مصغّرة الفيديو لا تُطبَّع إلى الفيديو الأصلي: %',
      public.aani_media_path('https://ik.imagekit.io/abc123/aani/7f1c/v.mp4/ik-thumbnail.jpg');
  end if;

  -- بنية الرفع: <endpointId>/aani/<userId>/...
  sample_owner := public.aani_media_owner_id(
    'https://ik.imagekit.io/abc123/aani/7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/story-1.jpg'
  );
  if sample_owner is distinct from '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f' then
    raise exception 'استخراج صاحب الملف من بنية الرفع فشل: %', coalesce(sample_owner, 'null');
  end if;

  if public.aani_media_owner_id('https://ik.imagekit.io/abc123/aani/not-a-uuid/x.jpg') is not null then
    raise exception 'استخراج صاحب الملف يقبل مقطعاً ليس معرّف مستخدم';
  end if;

  -- الزائر لا ينفّذ الدالة، والمسجّل ينفّذها
  if has_function_privilege('anon', 'public.aani_can_read_media_object(text)', 'execute') then
    raise exception 'aani_can_read_media_object ما زالت ممنوحة لـanon';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_can_read_media_object(text)', 'execute') then
    raise exception 'aani_can_read_media_object غير ممنوحة لـauthenticated — مسار التوقيع سيتعطل';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 1) الأفرع المشمولة في الجسم
--    select p.prosrc ~* 'aani_media_owner_id'   as owner_rule,
--           p.prosrc ~* 'public.messages'       as messages_rule,
--           p.prosrc ~* 'message.sender_id'     as messages_owner_rule,
--           p.prosrc ~* 'comment_row.image_url' as comments_rule,
--           p.prosrc ~* 'comment_row.user_id'   as comments_owner_rule,
--           p.prosrc ~* 'public.sounds'         as sounds_rule,
--           p.prosrc ~* 'aani_can_read_post'    as posts_rule,
--           p.prosrc ~* 'aani_can_view_story'   as stories_rule
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'aani_can_read_media_object';
--    -- المتوقع: كل الأعمدة true (عدا ما غاب جدوله فعلاً).
--
-- 2) التطبيع
--    select public.aani_media_path('https://ik.imagekit.io/<id>/tr:w-200/aani/<uid>/a.jpg?tr=q-auto');
--    -- المتوقع: <id>/aani/<uid>/a.jpg
--    select public.aani_media_owner_id('https://ik.imagekit.io/<id>/aani/<uid>/a.jpg');
--    -- المتوقع: <uid>
--
-- 3) المحادثات — بصفتك طرفاً في المحادثة
--    select public.aani_can_read_media_object('<media_path_of_the_conversation>'); -- true
--    نفس المسار بحساب ثالث لا يشارك:                                        -- false
--    ثم بحساب أرسل لنفسه مسار ملف شخص آخر:                                  -- false
--      (يجب أن يبقى false لأن صاحب الملف ليس طرفاً في تلك الرسالة)
--
-- 4) بصفتك غير متابع لحساب خاص A: كل ما يلي false
--    select public.aani_can_read_media_object('<A_post_media>');
--    select public.aani_can_read_media_object('<A_story_media>');
--    select public.aani_can_read_media_object('<A_comment_image>');
--    select public.aani_can_read_media_object('<A_voice_message>');
--    select public.aani_can_read_media_object('<A_document>');
--    select public.aani_can_read_media_object('<A_custom_sticker>');
--
-- 5) معاينة صوت عامة (مكتبة الأصوات) لكل مسجّل: true
--    select public.aani_can_read_media_object('<sound_preview_path>');
--    وفيديو مصدر الصوت لمنشور خاص لحساب آخر: false
--
-- 6) مصغّرة فيديو خاصة: نفس قرار الفيديو نفسه
--    select public.aani_can_read_media_object('<private_video_path>/ik-thumbnail.jpg'); -- false
--
-- 7) تحويلات المسار لا تفتح تجاوزاً
--    select public.aani_can_read_media_object('<private_video_path>?tr=w-100');          -- false
