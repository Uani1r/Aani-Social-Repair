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
--   2) يثبت أن gin_trgm_ops عضو في امتداد pg_trgm عبر pg_depend (deptype = 'e')
--      وأنه operator class لـ GIN، ويأخذ مخططه من pg_opclass.opcnamespace.
--   3) ينشئ ثلاثة فهارس GIN ثلاثية الأحرف + فهرس B-tree لبادئة اسم المستخدم،
--      كلها WHERE is_deactivated = false، بأسماء ثابتة مع if not exists.
--   4) يتحقق بعد الإنشاء من الكتالوجات مباشرة: الجدول والصلاحية والجاهزية ونوع
--      الوصول، والأعمدة بالضبط من pg_index.indkey مع pg_attribute، والـoperator
--      class لكل مفتاح من pg_index.indclass مع pg_opclass، وشرط الفهرس من
--      pg_get_expr(indpred) بمساواة تامة بـ is_deactivated = false.
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
  v_trgm_opclass_schema text;
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

  -- 3) إثبات عضوية gin_trgm_ops في امتداد pg_trgm عبر pg_depend، وأنه GIN
  --    operator class، مع أخذ مخططه من pg_opclass.opcnamespace.
  select namespace.nspname
    into v_trgm_opclass_schema
  from pg_opclass as opclass
  join pg_namespace as namespace on namespace.oid = opclass.opcnamespace
  join pg_am as access_method on access_method.oid = opclass.opcmethod
  join pg_depend as dependency
    on dependency.classid = 'pg_opclass'::regclass
   and dependency.objid = opclass.oid
   and dependency.refclassid = 'pg_extension'::regclass
   and dependency.deptype = 'e'
  join pg_extension as extension on extension.oid = dependency.refobjid
  where extension.extname = 'pg_trgm'
    and opclass.opcname = 'gin_trgm_ops'
    and access_method.amname = 'gin'
  limit 1;

  if v_trgm_opclass_schema is null then
    raise exception 'تعذر إثبات أن gin_trgm_ops عضو في امتداد pg_trgm (pg_depend) وكـ GIN operator class. أوقف الترحيل.'
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

  -- 5) إنشاء الفهارس الثلاثة، مع تأهيل operator class بمخططه المكتشف.
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
      v_trgm_opclass_schema
    );
  end loop;

  -- 6) فهرس B-tree لبادئة اسم المستخدم (حروف لاتينية صغيرة وفق قيد الجدول).
  execute
    'create index if not exists profiles_username_prefix_search_idx on public.profiles using btree (username text_pattern_ops, id) where is_deactivated = false';
end $$;

-- 7) التحقق البعدي من الكتالوجات مباشرة.
do $$
declare
  v_expected constant text[] := array[
    'profiles_username_trgm_search_idx',
    'profiles_full_name_trgm_search_idx',
    'profiles_display_name_trgm_search_idx'
  ];
  v_index_name text;
  v_expected_column text;
  v_is_valid boolean;
  v_is_ready boolean;
  v_table_oid oid;
  v_key_count integer;
  v_access_method text;
  v_predicate text;
  v_normalized_predicate text;
  v_columns text[];
  v_opclass_names text[];
  v_opclass_schemas text[];
  v_trgm_opclass_schema text;
begin
  -- 7.1 مخطط operator class كما هو مثبَت في pg_depend لامتداد pg_trgm.
  select namespace.nspname
    into v_trgm_opclass_schema
  from pg_opclass as opclass
  join pg_namespace as namespace on namespace.oid = opclass.opcnamespace
  join pg_am as access_method on access_method.oid = opclass.opcmethod
  join pg_depend as dependency
    on dependency.classid = 'pg_opclass'::regclass
   and dependency.objid = opclass.oid
   and dependency.refclassid = 'pg_extension'::regclass
   and dependency.deptype = 'e'
  join pg_extension as extension on extension.oid = dependency.refobjid
  where extension.extname = 'pg_trgm'
    and opclass.opcname = 'gin_trgm_ops'
    and access_method.amname = 'gin'
  limit 1;

  if v_trgm_opclass_schema is null then
    raise exception 'تعذر إثبات مخطط gin_trgm_ops من pg_depend/pg_opclass. أوقف الترحيل.'
      using errcode = '42704';
  end if;

  foreach v_index_name in array v_expected || array['profiles_username_prefix_search_idx']
  loop
    v_expected_column := case v_index_name
      when 'profiles_username_trgm_search_idx' then 'username'
      when 'profiles_full_name_trgm_search_idx' then 'full_name'
      when 'profiles_display_name_trgm_search_idx' then 'display_name'
      else 'username'
    end;

    select
      index.indisvalid,
      index.indisready,
      index.indrelid,
      index.indnkeyatts,
      access_method.amname,
      case when index.indpred is null then null
           else pg_get_expr(index.indpred, index.indrelid)
      end,
      (
        select array_agg(attribute.attname order by key.ord)
        from generate_subscripts(index.indkey::smallint[], 1) as key(ord)
        join pg_attribute as attribute
          on attribute.attrelid = index.indrelid
         and attribute.attnum = (index.indkey::smallint[])[key.ord]
        where key.ord <= index.indnkeyatts
      ),
      (
        select array_agg(opclass.opcname order by key.ord)
        from generate_subscripts(index.indclass::oid[], 1) as key(ord)
        join pg_opclass as opclass on opclass.oid = (index.indclass::oid[])[key.ord]
        where key.ord <= index.indnkeyatts
      ),
      (
        select array_agg(namespace.nspname order by key.ord)
        from generate_subscripts(index.indclass::oid[], 1) as key(ord)
        join pg_opclass as opclass on opclass.oid = (index.indclass::oid[])[key.ord]
        join pg_namespace as namespace on namespace.oid = opclass.opcnamespace
        where key.ord <= index.indnkeyatts
      )
    into
      v_is_valid,
      v_is_ready,
      v_table_oid,
      v_key_count,
      v_access_method,
      v_predicate,
      v_columns,
      v_opclass_names,
      v_opclass_schemas
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    join pg_index as index on index.indexrelid = class.oid
    join pg_am as access_method on access_method.oid = class.relam
    where namespace.nspname = 'public'
      and class.relname = v_index_name
      and class.relkind = 'i';

    if v_table_oid is null then
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
    if v_predicate is null then
      raise exception 'الفهرس % بلا شرط WHERE، والمطلوب is_deactivated = false.', v_index_name
        using errcode = '42809';
    end if;

    v_normalized_predicate := regexp_replace(
      regexp_replace(lower(v_predicate), '[[:space:]]+', '', 'g'),
      '[()]', '', 'g'
    );

    if v_normalized_predicate not in ('is_deactivated=false', 'false=is_deactivated') then
      raise exception 'شرط الفهرس % ليس is_deactivated = false (الشرط الفعلي: %).', v_index_name, v_predicate
        using errcode = '42809';
    end if;

    if v_index_name = 'profiles_username_prefix_search_idx' then
      -- 7.2 فهرس البادئة: B-tree على (username, id) بالترتيب.
      if v_access_method <> 'btree' or v_key_count <> 2 then
        raise exception 'فهرس البادئة % ليس B-tree بمعاملين.', v_index_name
          using errcode = '42809';
      end if;
      if v_columns is distinct from array['username', 'id'] then
        raise exception 'أعمدة فهرس البادئة % يجب أن تكون (username, id) بالترتيب، والفعلي: %.', v_index_name, coalesce(array_to_string(v_columns, ','), 'null')
          using errcode = '42809';
      end if;
      if v_opclass_names is null or v_opclass_names[1] is distinct from 'text_pattern_ops' then
        raise exception 'فهرس البادئة % لا يستخدم text_pattern_ops على العمود الأول (الفعلي: %).', v_index_name, coalesce(array_to_string(v_opclass_names, ','), 'null')
          using errcode = '42809';
      end if;
    else
      -- 7.3 فهارس GIN: عمود واحد بالضبط هو العمود المحدد، وoperator class
      --     هو gin_trgm_ops في مخططه المكتشف.
      if v_access_method <> 'gin' or v_key_count <> 1 then
        raise exception 'الفهرس % ليس GIN بعمود واحد.', v_index_name
          using errcode = '42809';
      end if;
      if v_columns is distinct from array[v_expected_column] then
        raise exception 'عمود الفهرس % يجب أن يكون % فقط، والفعلي: %.', v_index_name, v_expected_column, coalesce(array_to_string(v_columns, ','), 'null')
          using errcode = '42809';
      end if;
      if v_opclass_names is null or v_opclass_names[1] is distinct from 'gin_trgm_ops' then
        raise exception 'الفهرس % لا يستخدم gin_trgm_ops (الفعلي: %).', v_index_name, coalesce(array_to_string(v_opclass_names, ','), 'null')
          using errcode = '42809';
      end if;
      if v_opclass_schemas is null or v_opclass_schemas[1] is distinct from v_trgm_opclass_schema then
        raise exception 'الفهرس % يستخدم gin_trgm_ops من مخطط غير مخطط امتداد pg_trgm (%).', v_index_name, v_trgm_opclass_schema
          using errcode = '42809';
      end if;
    end if;
  end loop;
end $$;

commit;
