-- ملف يدوي (ليس ترحيلاً): نقل قصص قديمة منشورة/منتهية إلى public.stories.
--
-- لماذا يدوي: البيانات القديمة غير متاحة من هذا المستودع (لا اتصال ولا اعتماد)،
-- وخطوة النقل تحتاج قراراً بشرياً في تطابق المستخدمين ووصول ملفات الوسائط.
-- لا يصح أن يدخل هذا الملف سلسلة الترحيلات لأنه لا ينقل مخططاً بل بيانات.
--
-- المتطلبات قبل التشغيل:
--   1. جدول الاستقبال public.story_archive_import_staging مملوء من تصدير
--      القاعدة القديمة (انظر docs/STORY_ARCHIVE_BACKFILL_AR.md).
--   2. مراجعة النتائج أدناه قبل commit: أي استثناء يوقف كل شيء بلا إدخال.
--
-- الضمانات:
--   - لا حذف ولا تحديث لصف موجود: on conflict (id) do nothing.
--   - يحافظ على id وuser_id والتواريخ كما هي (لا اختراع ولا إعادة تأريخ).
--   - يرفض القصص غير المنتهية: إدخال قصة نشطة قديمة يعيد إحياءها كقصة جديدة.
--   - يرفض أي صف بلا مالك موجود في profiles، أو بمدة خارج 1..60، أو بنوع غير
--     متوافق مع وجود media_url.
--   - يُدرج فقط الأعمدة المشتركة بين جدول الاستقبال وpublic.stories فعلاً.
begin;

do $$
declare
  v_missing_users bigint;
  v_active_rows bigint;
  v_bad_duration bigint;
  v_bad_media bigint;
  v_bad_expiry bigint;
  v_duplicate_ids bigint;
  v_rows bigint;
  v_inserted bigint;
  v_columns text;
begin
  if to_regclass('public.story_archive_import_staging') is null then
    raise exception 'جدول الاستقبال public.story_archive_import_staging غير موجود — راجع docs/STORY_ARCHIVE_BACKFILL_AR.md';
  end if;

  execute 'select count(*) from public.story_archive_import_staging' into v_rows;
  if v_rows = 0 then
    raise exception 'جدول الاستقبال فارغ — لا شيء لنقله';
  end if;

  -- 1) كل قصة يجب أن يكون صاحبها موجوداً في profiles الجديدة.
  execute $q$
    select count(*)
    from public.story_archive_import_staging as imported
    where not exists (select 1 from public.profiles as owner where owner.id = imported.user_id)
  $q$ into v_missing_users;
  if v_missing_users > 0 then
    raise exception 'public.story_archive_import_staging: % صفاً بلا مالك في profiles — أوقف النقل وطابق المستخدمين أولاً', v_missing_users;
  end if;

  -- 2) القصص القديمة منتهية فعلاً: النشطة لا تُنقل (ستظهر كقصة جديدة).
  execute $q$
    select count(*)
    from public.story_archive_import_staging
    where expires_at > now()
  $q$ into v_active_rows;
  if v_active_rows > 0 then
    raise exception 'public.story_archive_import_staging: % قصة لم تنتهِ صلاحيتها بعد — استبعدها أو صحّح expires_at قبل النقل', v_active_rows;
  end if;

  -- 3) المدة داخل قيد public.stories (1..60).
  execute $q$
    select count(*)
    from public.story_archive_import_staging
    where duration_seconds is not null
      and (duration_seconds < 1 or duration_seconds > 60)
  $q$ into v_bad_duration;
  if v_bad_duration > 0 then
    raise exception 'public.story_archive_import_staging: % صفاً بمدة خارج 1..60 — صحّحها قبل النقل', v_bad_duration;
  end if;

  -- 4) توافق النوع مع الوسيط: النصي بلا رابط، والصورة/الفيديو برابط.
  execute $q$
    select count(*)
    from public.story_archive_import_staging
    where (media_type = 'text' and media_url is not null)
       or (media_type in ('image', 'video') and media_url is null)
       or media_type not in ('text', 'image', 'video')
  $q$ into v_bad_media;
  if v_bad_media > 0 then
    raise exception 'public.story_archive_import_staging: % صفاً بنوع وسيط غير متوافق مع media_url — راجعها قبل النقل', v_bad_media;
  end if;

  -- 5) الانتهاء بعد الإنشاء وداخل 24 ساعة (نفس قاعدة القصص الحالية).
  execute $q$
    select count(*)
    from public.story_archive_import_staging
    where expires_at <= created_at
       or expires_at > created_at + interval '24 hours'
  $q$ into v_bad_expiry;
  if v_bad_expiry > 0 then
    raise exception 'public.story_archive_import_staging: % صفاً بتاريخ انتهاء غير متوافق مع created_at — صحّحه قبل النقل', v_bad_expiry;
  end if;

  -- 6) لا معرّفات مكررة في الاستقبال نفسه.
  execute $q$
    select count(*) from (
      select id from public.story_archive_import_staging group by id having count(*) > 1
    ) as duplicates
  $q$ into v_duplicate_ids;
  if v_duplicate_ids > 0 then
    raise exception 'public.story_archive_import_staging: % معرّفاً مكرراً — نظّف التصدير قبل النقل', v_duplicate_ids;
  end if;

  -- 7) الإدراج في الأعمدة المشتركة فعلاً فقط (المخطط قد يختلف بين نسختين).
  select string_agg(quote_ident(staging.column_name), ', ' order by staging.column_name)
    into v_columns
  from information_schema.columns as staging
  join information_schema.columns as target
    on target.table_schema = 'public'
   and target.table_name = 'stories'
   and target.column_name = staging.column_name
  where staging.table_schema = 'public'
    and staging.table_name = 'story_archive_import_staging';

  if v_columns is null then
    raise exception 'لا عمود مشترك بين جدول الاستقبال وpublic.stories — راجع أسماء الأعمدة';
  end if;

  execute format(
    'insert into public.stories (%s) select %s from public.story_archive_import_staging on conflict (id) do nothing',
    v_columns, v_columns
  );
  get diagnostics v_inserted = row_count;

  raise notice 'نُقل % صفاً من % صفاً في الاستقبال (المعرّفات الموجودة سابقاً لم تُمس).',
    v_inserted, v_rows;
  raise notice 'تحقق الآن: select count(*) from public.stories where expires_at <= now();';
end $$;

-- لا commit تلقائي: راجع الرسائل أعلاه ثم commit أو rollback بنفسك.
