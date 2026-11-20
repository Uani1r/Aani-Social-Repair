-- ============================================================================
-- فهارس أداء البحث عن الحسابات في public.profiles
--
-- الهدف: دعم استعلامات SearchPage الستة (exact / prefix / contains) لاسم
-- المستخدم والاسم الكامل والاسم المعروض، مع استبعاد الحسابات المعطلة.
--
-- ما يفعله هذا الترحيل فقط:
--   1) يضمن توفر امتداد pg_trgm: إن كان مثبتاً فاكتشاف مخططه الفعلي من
--      pg_extension/pg_namespace دون نقله أو حذفه أو تغيير صلاحياته، وإن لم يكن
--      مثبتاً فيُنشأ في مخطط extensions شرط وجوده؛ وإلا يتوقف الترحيل برسالة
--      واضحة بدل إنشاء مخطط جديد.
--   2) يتحقق من أن gin_trgm_ops يخص pg_trgm وأنه operator class لـ GIN.
--   3) ينشئ ثلاثة فهارس GIN ثلاثية الأحرف + فهرس B-tree لبادئة اسم المستخدم،
--      كلها WHERE is_deactivated = false، وبأسماء ثابتة مع if not exists.
--   4) يتحقق بعد الإنشاء من الاسم والجدول والصلاحية والجاهزية ووجود الشرط
--      والعمود ونوع الفهرس، ويرفع استثناءً إن اختل أي شرط.
--
-- ما لا يفعله:
--   * لا يغيّر أي عمود أو قيد أو بيان.
--   * لا يغيّر سياسة RLS ولا صلاحية ولا دالة ولا trigger.
--   * لا يحذف أو يعدّل أي فهرس موجود.
--   * لا ينفذ ANALYZE ولا أي SQL تشغيلي إضافي.
-- ============================================================================

begin;

do $$
declare
  v_trgm_schema text;
  v_index_name text;
  v_column text;
  v_conflicts integer;
begin
  -- 1) ضمان وجود الامتداد دون افتراض مخطط ثابت.
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if not exists (select 1 from pg_namespace where nspname = 'extensions') then
      raise exception 'pg_trgm غير مثبت ومخطط extensions غير موجود. ثبّت الامتداد في مخطط الامتدادات المعتمد للمشروع قبل تطبيق هذا الترحيل.'
        using errcode = '42704';
    end if;

    create extension pg_trgm with schema extensions;
  end if;

  -- 2) اكتشاف مخطط الامتداد الفعلي من الكتالوجات.
  select namespace.nspname
    into v_trgm_schema
  from pg_extension as extension
  join pg_namespace as namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if v_trgm_schema is null then
    raise exception 'تعذر تحديد مخطط امتداد pg_trgm من pg_extension/pg_namespace. أوقف الترحيل.'
      using errcode = '42704';
  end if;

  -- 3) التحقق أن gin_trgm_ops تابع لـ pg_trgm وأنه operator class لـ GIN.
  if not exists (
    select 1
    from pg_opclass as opclass
    join pg_namespace as namespace on namespace.oid = opclass.opcnamespace
    join pg_extension as extension on extension.extnamespace = namespace.oid
    join pg_am as access_method on access_method.oid = opclass.opcmethod
    where extension.extname = 'pg_trgm'
      and opclass.opcname = 'gin_trgm_ops'
      and access_method.amname = 'gin'
  ) then
    raise exception 'gin_trgm_ops غير متاح ضمن امتداد pg_trgm كـ GIN operator class. أوقف الترحيل.'
      using errcode = '42704';
  end if;

  -- 4) رفض تعارض الأسماء: أي فهرس يحمل الاسم نفسه على جدول أو مخطط آخر.
  foreach v_index_name in array array[
    'profiles_username_trgm_search_idx',
    'profiles_full_name_trgm_search_idx',
    'profiles_display_name_trgm_search_idx',
    'profiles_username_prefix_search_idx'
  ]
  loop
    select count(*)
      into v_conflicts
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    join pg_index as index on index.indexrelid = class.oid
    where class.relkind = 'i'
      and class.relname = v_index_name
      and not (namespace.nspname = 'public' and index.indrelid = 'public.profiles'::regclass);

    if v_conflicts > 0 then
      raise exception 'تعارض اسم فهرس: % موجود مسبقاً على جدول أو مخطط مختلف عن public.profiles. أوقف الترحيل.', v_index_name
        using errcode = '42710';
    end if;
  end loop;

  -- 5) إنشاء الفهارس الثلاثة، مع تأهيل operator class بالمخطط المكتشف.
  for v_index_name, v_column in
    select targets.index_name, targets.column_name
    from (
      values
        ('profiles_username_trgm_search_idx', 'username'),
        ('profiles_full_name_trgm_search_idx', 'full_name'),
        ('profiles_display_name_trgm_search_idx', 'display_name')
    ) as targets(index_name, column_name)
  loop
    execute format(
      'create index if not exists %I on public.profiles using gin (%I %I.gin_trgm_ops) where is_deactivated = false',
      v_index_name,
      v_column,
      v_trgm_schema
    );
  end loop;

  -- 6) فهرس B-tree لبادئة اسم المستخدم (حروف لاتينية صغيرة وفق قيد الجدول).
  execute
    'create index if not exists profiles_username_prefix_search_idx on public.profiles using btree (username text_pattern_ops, id) where is_deactivated = false';
end $$;

-- 7) التحقق البعدي: الاسم والجدول والصلاحية والجاهزية والعمود ونوع الفهرس والشرط.
do $$
declare
  v_targets text[] := array[
    'profiles_username_trgm_search_idx',
    'profiles_full_name_trgm_search_idx',
    'profiles_display_name_trgm_search_idx'
  ];
  v_index_name text;
  v_definition text;
  v_access_method text;
  v_is_valid boolean;
  v_is_ready boolean;
  v_has_predicate boolean;
  v_key_count integer;
  v_table_oid oid;
  v_column_name text;
begin
  foreach v_index_name in array v_targets
  loop
    v_column_name := case v_index_name
      when 'profiles_username_trgm_search_idx' then 'username'
      when 'profiles_full_name_trgm_search_idx' then 'full_name'
      else 'display_name'
    end;

    select
      pg_get_indexdef(class.oid),
      access_method.amname,
      index.indisvalid,
      index.indisready,
      index.indpred is not null,
      index.indnkeyatts,
      index.indrelid
    into
      v_definition,
      v_access_method,
      v_is_valid,
      v_is_ready,
      v_has_predicate,
      v_key_count,
      v_table_oid
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    join pg_index as index on index.indexrelid = class.oid
    join pg_am as access_method on access_method.oid = class.relam
    where namespace.nspname = 'public'
      and class.relname = v_index_name
      and class.relkind = 'i';

    if v_definition is null then
      raise exception 'الفهرس % غير موجود في public بعد الإنشاء.', v_index_name
        using errcode = '42704';
    end if;
    if v_table_oid <> 'public.profiles'::regclass then
      raise exception 'الفهرس % ليس على public.profiles.', v_index_name
        using errcode = '42809';
    end if;
    if not v_is_valid or not v_is_ready then
      raise exception 'الفهرس % غير صالح أو غير جاهز (indisvalid=% indisready=%).', v_index_name, v_is_valid, v_is_ready
        using errcode = '55000';
    end if;
    if v_access_method <> 'gin' or v_key_count <> 1 then
      raise exception 'الفهرس % ليس GIN بعمود واحد.', v_index_name
        using errcode = '42809';
    end if;
    if not v_has_predicate
       or position('is_deactivated' in lower(v_definition)) = 0 then
      raise exception 'الفهرس % لا يستبعد الحسابات المعطلة (WHERE is_deactivated = false).', v_index_name
        using errcode = '42809';
    end if;
    if position('gin_trgm_ops' in lower(v_definition)) = 0
       or position(v_column_name in lower(v_definition)) = 0 then
      raise exception 'الفهرس % لا يطابق العمود/الـoperator class المتوقع (% gin_trgm_ops).', v_index_name, v_column_name
        using errcode = '42809';
    end if;
  end loop;

  select
    pg_get_indexdef(class.oid),
    access_method.amname,
    index.indisvalid,
    index.indisready,
    index.indpred is not null,
    index.indnkeyatts,
    index.indrelid
  into
    v_definition,
    v_access_method,
    v_is_valid,
    v_is_ready,
    v_has_predicate,
    v_key_count,
    v_table_oid
  from pg_class as class
  join pg_namespace as namespace on namespace.oid = class.relnamespace
  join pg_index as index on index.indexrelid = class.oid
  join pg_am as access_method on access_method.oid = class.relam
  where namespace.nspname = 'public'
    and class.relname = 'profiles_username_prefix_search_idx'
    and class.relkind = 'i';

  if v_definition is null then
    raise exception 'فهرس البادئة profiles_username_prefix_search_idx غير موجود في public بعد الإنشاء.'
      using errcode = '42704';
  end if;
  if v_table_oid <> 'public.profiles'::regclass then
    raise exception 'فهرس البادئة ليس على public.profiles.'
      using errcode = '42809';
  end if;
  if not v_is_valid or not v_is_ready then
    raise exception 'فهرس البادئة غير صالح أو غير جاهز (indisvalid=% indisready=%).', v_is_valid, v_is_ready
      using errcode = '55000';
  end if;
  if v_access_method <> 'btree' or v_key_count <> 2 then
    raise exception 'فهرس البادئة ليس B-tree بعمودين.'
      using errcode = '42809';
  end if;
  if not v_has_predicate
     or position('is_deactivated' in lower(v_definition)) = 0 then
    raise exception 'فهرس البادئة لا يستبعد الحسابات المعطلة (WHERE is_deactivated = false).'
      using errcode = '42809';
  end if;
  if position('username text_pattern_ops' in lower(v_definition)) = 0 then
    raise exception 'فهرس البادئة لا يستخدم username text_pattern_ops كما هو متوقع.'
      using errcode = '42809';
  end if;
end $$;

commit;
