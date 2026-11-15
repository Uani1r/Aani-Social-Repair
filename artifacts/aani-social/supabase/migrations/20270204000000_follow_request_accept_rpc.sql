-- ترحيل: قبول طلب المتابعة عبر دالة مصرّح بها، ومنع متابعة الحساب الخاص بلا موافقة.
--
-- المشكلة (من مراجعة المصدر، بلا وصول للقاعدة الحيّة):
--   1) تعريف سياسة الإدخال على public.follows في schema.sql (سطر 419-422) وفي
--      fresh_schema_cloudflare_r2.sql (سطر 662-664) هو:
--        with check (follower_id = auth.uid() and follower_id <> following_id)
--      بلا أي شرط على profiles.is_private. وschema.sql يُعاد تشغيله كاملاً بحسب
--      توثيق المشروع («Safe to re-run»)، فهو آخر من يعيد تعريف السياسة باسمها
--      نفسه "Users can follow as themselves" — أي أن القاعدة الحيّة قد تحمل هذا
--      التعريف المتساهل، فيستطيع أي مستخدم إدراج صف follows لحساب خاص مباشرة
--      دون موافقة صاحبه، ويتجاوز بذلك حماية قراءة منشوراته.
--   2) تعريف 20261108000000 (سطر 258-287) أكثر صرامة، لكنه يسمح لفرع المتابِع
--      بالإدراج متى وُجد صف في follow_requests فقط، والصف يعني «طلب قيد
--      الانتظار» لا «موافقة» — فهو أيضاً يسمح بمتابعة حساب خاص قبل القبول.
--   3) قبول الطلب في FollowRequestsSection.tsx (سطر 257-266) كان يُدرج صف
--      follows بهوية صاحب الحساب (following_id = currentUserId)، وهذا يخالف
--      شرط follower_id = auth.uid() في سياسة الإدخال، فيفشل القبول بـ42501
--      عند تفعيل السياسة الصارمة.
--
-- الحل:
--   * دالة واحدة public.aani_respond_to_follow_request(requester, accept):
--     SECURITY DEFINER و search_path = '' ، تتحقق أن الطلب موجود فعلاً وأن
--     المستدعي هو صاحب الطلب (recipient_id)، ثم تُدرج صف follows وتحذف الطلب
--     في معاملة واحدة. لا تُنشئ صفاً بلا طلب مطابق، ولا تقبل معرّفات مستخدمين آخرين.
--   * سياسة إدخال صارمة على follows: المتابِع يُدرج لنفسه فقط وإلى حساب غير خاص
--     فقط؛ وصاحب الحساب الخاص يُدرج فقط عند وجود طلب مطابق (أي عند القبول).
--   * إعادة إنشاء الحارس restrictive aani_follows_private_guard بنفس القاعدة،
--     بلا اختصار «وجود طلب» الذي كان يسمح بالمتابعة قبل الموافقة.
--
-- لا يغيّر سلوك ميزة أخرى: سياسات قراءة المنشورات، القصص، الإشعارات، أو أي
-- جدول آخر تبقى كما هي. التعديل الوحيد على بنية جدول هو توافق أعمدة
-- public.user_blocks (إضافة blocked_user_id ونقل البيانات ومزامنتها)، ولا
-- يحذف صفاً ولا يغيّر مفتاحاً أساسياً قائماً. الملف السابق 20270203000000
-- يبقى مرجع حماية القراءة، ويعتمد الآن على صفوف follows التي لا تُنشأ إلا بموافقة.
--
-- توافق مع قاعدة الإنتاج (لا مع قاعدة جديدة فقط):
--   * public.user_blocks في الإنتاج أُنشئ بعمود blocked_id وبمفتاح أساسي
--     (blocker_id, blocked_id) — راجع APPLY_MANUALLY_story_views_likes.sql
--     سطر 7-13. `create table if not exists` لا يضيف أعمدة، فكان الفهرس على
--     blocked_user_id يفشل هناك. صار الترتيب: توافق الأعمدة أولاً، ثم الفهارس.
--     يُضاف blocked_user_id، تُنقل إليه كل الصفوف، ويُزامَن العمودان بمشغّل
--     BEFORE حتى تعمل الكتابة بأي من الاسمين دون المساس بالمفتاح الأساسي.
--   * public.follow_requests غير موجود في الإنتاج؛ يُنشأ هنا. وإن وُجد بمخطط
--     ناقص، يُضاف created_at ويُوقف الترحيل برسالة واضحة إن غاب عمودا الطلب.
--   * مشغّلات إشعار الطلب تُنشأ فقط إذا كان public.notifications يحوي كل
--     الأعمدة التي تكتبها؛ وإلا تُتخطى بتحذير بدل إسقاط كل إدخال طلب.
--
-- آمن للتكرار. لا يُنفَّذ تلقائياً من التطبيق.
begin;

-- ---------------------------------------------------------------------
-- 0) المتطلبات المسبقة، وتهيئة الأساس إن غاب
--
-- سبب الاختلاف مع القاعدة الحيّة: schema.sql (الملف الذي يُعاد تشغيله كاملاً
-- لبناء القاعدة) لا يحتوي follow_requests ولا user_blocks ولا
-- aani_is_user_blocked — كلها في 20261108000000 و20261115000000 فقط. فقاعدة
-- بُنيت من schema.sql لا تحتوي أيّاً منها، ولذلك لا توجد دالة قبول الطلب ولا
-- سياسة إدخال صارمة على follows. تُنشأ هنا بتعريفاتها الأصلية بدل إفشال
-- الترحيل، بلا حذف أي شيء وبلا تغيير تعريف موجود.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.follows') is null or to_regclass('public.profiles') is null then
    raise exception 'public.follows أو public.profiles غير موجود — لا يمكن تطبيق هذا الترحيل';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_private'
  ) then
    raise exception 'العمود profiles.is_private مفقود — طبّق 20261108000000 أولاً';
  end if;
end $$;

-- user_blocks + aani_is_user_blocked (تعريف 20261115000000)
--
-- توافق مع قاعدة الإنتاج: الإنتاج أنشأ الجدول بعمود اسمه blocked_id
-- (APPLY_MANUALLY_story_views_likes.sql سطر 7-13) بمفتاح أساسي
-- (blocker_id, blocked_id). و`create table if not exists` لا يضيف أعمدة،
-- فكان إنشاء الفهرس على blocked_user_id يفشل هناك. لذلك الترتيب الآن:
--   1) إنشاء الجدول بالشكل القياسي إن غاب.
--   2) معالجة التوافق: إضافة blocked_user_id ونقل البيانات من blocked_id.
--   3) مزامنة العمودين بمشغّل حتى تعمل الكتابة بأي من الاسمين.
--   4) الفهارس (بعد ضمان وجود الأعمدة).
--   5) RLS والصلاحيات.
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_user_id),
  constraint aani_user_blocks_not_self check (blocker_id <> blocked_user_id)
);

-- ---------------------------------------------------------------------
-- 0أ) توافق الأعمدة: blocked_id (الإنتاج) → blocked_user_id (القياسي)
--     لا صف يُفقد، ولا تكرار، ولا مساس بالمفتاح الأساسي القائم.
-- ---------------------------------------------------------------------
do $$
declare
  has_blocked_user_id boolean;
  has_blocked_id boolean;
  null_rows bigint;
  duplicate_pairs bigint;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_blocks' and column_name = 'blocked_user_id'
  ) into has_blocked_user_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_blocks' and column_name = 'blocked_id'
  ) into has_blocked_id;

  if not has_blocked_user_id and not has_blocked_id then
    raise exception 'public.user_blocks لا يحتوي blocked_user_id ولا blocked_id — راجع مخطط الجدول قبل التطبيق';
  end if;

  if not has_blocked_user_id then
    -- عمود بلا NOT NULL أولاً، حتى لا يفشل الإضافة على صفوف قائمة.
    -- لا نضيف مفتاحاً أجنبياً هنا: blocked_id يحمل أصلاً FK بـON DELETE CASCADE،
    -- فحذف الملف الشخصي يحذف الصف كاملاً قبل أن يهمّ العمود الجديد.
    execute 'alter table public.user_blocks add column blocked_user_id uuid';

    -- نقل كل الصفوف: القيمة مصدرها عمود فريد داخل (blocker_id)، فلا تكرار.
    execute 'update public.user_blocks set blocked_user_id = blocked_id where blocked_user_id is null';
  else
    -- عمود موجود مسبقاً (ترحيل جزئي سابق): أكمل ما بقي فارغاً من blocked_id.
    if has_blocked_id then
      execute 'update public.user_blocks set blocked_user_id = blocked_id where blocked_user_id is null';
    end if;
  end if;

  -- لا صف بلا قيمة بعد النقل (وإلا فُقدت علاقة حظر بصمت).
  execute 'select count(*) from public.user_blocks where blocked_user_id is null' into null_rows;
  if null_rows > 0 then
    raise exception 'public.user_blocks: % صفاً بلا blocked_user_id بعد النقل — أوقف الترحيل وراجع البيانات يدوياً', null_rows;
  end if;

  -- لا تكرار لـ(blocker_id, blocked_user_id): الفهرس الفريد أدناه يفشل بصمت غامض بدونه.
  execute $q$
    select count(*) from (
      select 1 from public.user_blocks group by blocker_id, blocked_user_id having count(*) > 1
    ) as duplicates
  $q$ into duplicate_pairs;
  if duplicate_pairs > 0 then
    raise exception 'public.user_blocks: % زوجاً مكرراً (blocker_id, blocked_user_id) — أوقف الترحيل وعالج التكرار يدوياً', duplicate_pairs;
  end if;

  -- الآن يمكن فرض NOT NULL على العمود القياسي.
  execute 'alter table public.user_blocks alter column blocked_user_id set not null';

  if has_blocked_id then
    raise warning 'public.user_blocks يحتوي العمودين blocked_id و blocked_user_id: تم نقل البيانات ومزامنتها بمشغّل. لا تُعِد تطبيق 20270129000000 أو 20270130000000 بعدهما (يرفضان وجود العمودين معاً).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 0أ-2) مزامنة العمودين عند الكتابة
--     الكتابة القياسية تستخدم blocked_user_id (aani_block_user في
--     20261115000000)، والإنتاج يفرض NOT NULL على blocked_id عبر المفتاح
--     الأساسي. مشغّل BEFORE يملأ الآخر قبل فحص القيود، فتعمل الكتابة بأي اسم
--     ولا يحدث تعارض بين العمودين. blocked_user_id هو المرجع عند الاختلاف.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_blocks' and column_name = 'blocked_id'
  ) then
    -- لا عمود قديم: لا حاجة لمزامنة.
    return;
  end if;

  execute $fn$
    create or replace function public.aani_user_blocks_sync_blocked_columns()
    returns trigger
    language plpgsql
    set search_path = ''
    as $body$
    begin
      if tg_op = 'INSERT' then
        -- أي من الاسمين يكفي عند الإدراج: يُملأ الآخر قبل فحص NOT NULL والمفتاح.
        new.blocked_user_id := coalesce(new.blocked_user_id, new.blocked_id);
        new.blocked_id := new.blocked_user_id;
      elsif new.blocked_user_id is distinct from old.blocked_user_id then
        -- العمود القياسي تغيّر: هو المرجع.
        new.blocked_id := new.blocked_user_id;
      elsif new.blocked_id is distinct from old.blocked_id then
        -- عميل قديم يكتب blocked_id: انقل التغيير إلى القياسي.
        new.blocked_user_id := new.blocked_id;
      end if;
      return new;
    end;
    $body$;
  $fn$;

  execute 'revoke all on function public.aani_user_blocks_sync_blocked_columns() from public, anon, authenticated';

  execute 'drop trigger if exists aani_user_blocks_sync_blocked_columns_trg on public.user_blocks';
  execute $trg$
    create trigger aani_user_blocks_sync_blocked_columns_trg
      before insert or update on public.user_blocks
      for each row execute function public.aani_user_blocks_sync_blocked_columns()
  $trg$;
end $$;

-- فهرس فريد يخدم `on conflict (blocker_id, blocked_user_id)` في aani_block_user.
-- على قاعدة الإنتاج المفتاح الأساسي هو (blocker_id, blocked_id)، فلا يوجد قيد
-- فريد على الاسم القياسي بدونه، ويفشل الإدراج برسالة "no unique constraint".
create unique index if not exists aani_user_blocks_blocker_blocked_user_uidx
  on public.user_blocks (blocker_id, blocked_user_id);

-- فهرس البحث — بعد ضمان وجود blocked_user_id (سبب فشل التطبيق سابقاً).
create index if not exists aani_user_blocks_blocked_user_idx
  on public.user_blocks (blocked_user_id, blocker_id);

alter table public.user_blocks enable row level security;
grant select, insert, delete on public.user_blocks to authenticated;

create or replace function public.aani_is_user_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and auth.uid() in (p_user_a, p_user_b)
    and exists (
      select 1
      from public.user_blocks as blocked
      where (blocked.blocker_id = p_user_a and blocked.blocked_user_id = p_user_b)
         or (blocked.blocker_id = p_user_b and blocked.blocked_user_id = p_user_a)
    ),
    false
  );
$$;
revoke all on function public.aani_is_user_blocked(uuid, uuid) from public;
grant execute on function public.aani_is_user_blocked(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 0ب) تهيئة public.follow_requests إن كانت غائبة
--
-- سبب الاختلاف مع القاعدة الحيّة: جدول follow_requests يُنشأ في
-- 20261108000000 فقط، وهو غير موجود إطلاقاً في schema.sql ولا في
-- fresh_schema_cloudflare_r2.sql. وبما أن schema.sql هو الملف الذي يُعاد
-- تشغيله كاملاً لبناء القاعدة، فقاعدة بُنيت منه لا تحتوي follow_requests،
-- وكل ما يعتمد عليه (سياسة إدخال follows، حارس الحجب، إشعار الطلب، ودالة
-- القبول) غير موجود أو غير مفعّل. لذلك يُنشأ هنا بشكل مطابق لتعريف
-- 20261108000000، بلا حذف أي شيء، وقبل أي استخدام له.
-- ---------------------------------------------------------------------
create table if not exists public.follow_requests (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (requester_id, recipient_id),
  constraint aani_follow_requests_not_self check (requester_id <> recipient_id)
);

-- توافق: إن كان الجدول موجوداً بمخطط ناقص (نسخة قديمة/جزئية)، `create table
-- if not exists` لا يضيف شيئاً. نضيف created_at لأنه آمن (له افتراضي)، ونوقف
-- الترحيل برسالة واضحة إن غاب عمودا الطلب نفسه — لا يمكن اختراع بياناتهما.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'follow_requests' and column_name = 'created_at'
  ) then
    execute 'alter table public.follow_requests add column created_at timestamptz not null default now()';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'follow_requests' and column_name = 'requester_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'follow_requests' and column_name = 'recipient_id'
  ) then
    raise exception 'public.follow_requests يفتقد requester_id أو recipient_id — راجع المخطط يدوياً قبل التطبيق';
  end if;
end $$;

create index if not exists aani_follow_requests_recipient_created_idx
  on public.follow_requests (recipient_id, created_at desc);

alter table public.follow_requests enable row level security;
grant select, insert, delete on public.follow_requests to authenticated;

drop policy if exists aani_follow_requests_select_participant on public.follow_requests;
create policy aani_follow_requests_select_participant on public.follow_requests
  for select to authenticated
  using (
    requester_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );

drop policy if exists aani_follow_requests_insert_private on public.follow_requests;
create policy aani_follow_requests_insert_private on public.follow_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and requester_id <> recipient_id
    and exists (
      select 1 from public.profiles as recipient
      where recipient.id = recipient_id and recipient.is_private
    )
    and not exists (
      select 1 from public.follows as accepted
      where accepted.follower_id = requester_id
        and accepted.following_id = recipient_id
    )
  );

drop policy if exists aani_follow_requests_delete_participant on public.follow_requests;
create policy aani_follow_requests_delete_participant on public.follow_requests
  for delete to authenticated
  using (
    requester_id = (select auth.uid())
    or recipient_id = (select auth.uid())
  );

-- حارس الحجب على الطلبات (تعريفه في 20261115000000) — يُعاد دفاعياً.
drop policy if exists aani_follow_requests_block_guard on public.follow_requests;
create policy aani_follow_requests_block_guard on public.follow_requests
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(requester_id, recipient_id));

-- إشعار صاحب الحساب عند وصول الطلب: لا يُنشأ إلا إذا كان جدول notifications
-- موجوداً ويحوي كل الأعمدة التي تكتبها الدالة. مشغّل يكتب عموداً مفقوداً يفشل
-- عند كل إدخال طلب، فيُسقط إدراج follow_requests كله (المعاملة تُرجع)، لذلك
-- الفحص هنا شرط لإنشاء المشغّل لا تحسيناً.
do $$
declare
  notifications_ready boolean := false;
  required_columns text[] := array['user_id', 'actor_id', 'type', 'content', 'reference_id', 'is_read', 'created_at'];
  missing_columns text;
begin
  if to_regclass('public.notifications') is not null then
    select string_agg(required.column_name, ', ' order by required.column_name)
    into missing_columns
    from unnest(required_columns) as required(column_name)
    where not exists (
      select 1 from information_schema.columns as col
      where col.table_schema = 'public'
        and col.table_name = 'notifications'
        and col.column_name = required.column_name
    );

    notifications_ready := missing_columns is null;

    if not notifications_ready then
      raise warning 'public.notifications يفتقد الأعمدة (%): تم تخطي مشغّلي إشعار طلب المتابعة. الإشعارات غير مفعّلة، وطلبات المتابعة تعمل.',
        missing_columns;
    end if;
  end if;

  if notifications_ready then
    create or replace function public.aani_notify_follow_request()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $fn$
    begin
      insert into public.notifications (user_id, actor_id, type, content, reference_id, is_read, created_at)
      values (
        new.recipient_id,
        new.requester_id,
        'follow_request',
        'أرسل طلب متابعة',
        new.requester_id,
        false,
        new.created_at
      );
      return new;
    end;
    $fn$;

    revoke all on function public.aani_notify_follow_request() from public, anon, authenticated;

    drop trigger if exists aani_follow_request_notification_trg on public.follow_requests;
    create trigger aani_follow_request_notification_trg
    after insert on public.follow_requests
    for each row execute function public.aani_notify_follow_request();

    create or replace function public.aani_resolve_follow_request_notification()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $fn$
    begin
      update public.notifications
      set is_read = true
      where user_id = old.recipient_id
        and actor_id = old.requester_id
        and type = 'follow_request'
        and reference_id = old.requester_id
        and is_read = false;
      return old;
    end;
    $fn$;

    revoke all on function public.aani_resolve_follow_request_notification() from public, anon, authenticated;

    drop trigger if exists aani_follow_request_resolved_notification_trg on public.follow_requests;
    create trigger aani_follow_request_resolved_notification_trg
    after delete on public.follow_requests
    for each row execute function public.aani_resolve_follow_request_notification();
  end if;

  -- بثّ التغييرات للواجهة (قائمة الطلبات الحيّة) — عضو واحد فقط في المنشور.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'follow_requests'
     ) then
    execute 'alter publication supabase_realtime add table public.follow_requests';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 0ج) تأكيد وجود الجدول بعد التهيئة
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.follow_requests') is null then
    raise exception 'public.follow_requests غير موجود بعد التهيئة — راجع صلاحيات المخطط';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) الدالة المصرّح بها للرد على طلب متابعة
--    * المستدعي يجب أن يكون صاحب الطلب (recipient_id = auth.uid()).
--    * الطلب يجب أن يكون موجوداً؛ لا إنشاء متابعة من فراغ.
--    * الحظر يمنع القبول والرفض معاً.
--    * الإدراج ثم الحذف داخل نفس المعاملة: إما قبول كامل أو لا شيء.
--    * SECURITY DEFINER لأن صف follows لصاحب حساب خاص لا يمكن أن يُنشئه
--      المستدعي بصلاحياته (سياسة الإدخال تمنع ذلك عمداً). المالك لا يخضع
--      لـRLS (لا يوجد FORCE ROW LEVEL SECURITY)، والدالة تتحقق من كل شرط بنفسها.
-- ---------------------------------------------------------------------
create or replace function public.aani_respond_to_follow_request(
  p_requester_id uuid,
  p_accept boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  v_exists boolean;
begin
  if actor_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_requester_id is null or p_requester_id = actor_id then
    raise exception 'Invalid follow request' using errcode = '22023';
  end if;

  select exists (
    select 1
    from public.follow_requests as request
    where request.requester_id = p_requester_id
      and request.recipient_id = actor_id
  )
  into v_exists;

  -- الرفض لا يحتاج شرطاً: حذف طلب غير موجود عملية آمنة.
  if not coalesce(p_accept, false) then
    delete from public.follow_requests
    where requester_id = p_requester_id
      and recipient_id = actor_id;

    return false;
  end if;

  -- القبول يتطلب طلباً مطابقاً موجّهاً إلى المستدعي نفسه.
  if not v_exists then
    raise exception 'No pending follow request from this user' using errcode = '22023';
  end if;

  if public.aani_is_user_blocked(p_requester_id, actor_id) then
    raise exception 'A block exists between these accounts' using errcode = '42501';
  end if;

  -- الإدراج قبل الحذف: يبقى الطلب موجوداً حتى تكتمل المتابعة، فلو كانت
  -- الدالة تُنفَّذ بصلاحيات تخضع لـRLS يظل شرط «وجود طلب» محققاً.
  insert into public.follows (follower_id, following_id)
  values (p_requester_id, actor_id)
  on conflict (follower_id, following_id) do nothing;

  delete from public.follow_requests
  where requester_id = p_requester_id
    and recipient_id = actor_id;

  return true;
end;
$$;

revoke all on function public.aani_respond_to_follow_request(uuid, boolean) from public, anon;
grant execute on function public.aani_respond_to_follow_request(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 2) سياسة الإدخال: لا متابعة لحساب خاص إلا بعد قبول الطلب
--    الفرع الأول (المتابِع لنفسه): الحساب الهدف غير خاص فقط.
--    الفرع الثاني (صاحب الحساب): قبول طلب مطابق من المتابِع.
--    لا يوجد اختصار «طلب قيد الانتظار» في فرع المتابِع — الطلب ليس موافقة.
-- ---------------------------------------------------------------------
alter table public.follows enable row level security;

drop policy if exists "Users can follow as themselves" on public.follows;
create policy "Users can follow as themselves"
  on public.follows for insert to authenticated
  with check (
    follower_id <> following_id
    and (
      (
        follower_id = (select auth.uid())
        and exists (
          select 1
          from public.profiles as target
          where target.id = following_id
            and not target.is_private
        )
      )
      or (
        following_id = (select auth.uid())
        and exists (
          select 1
          from public.follow_requests as request
          where request.requester_id = follower_id
            and request.recipient_id = following_id
        )
      )
    )
  );

-- ---------------------------------------------------------------------
-- 3) حارس restrictive بنفس القاعدة: يبقى فعالاً حتى لو عاد تعريف متساهل
--    للسياسة المتساهلة (مثل إعادة تشغيل schema.sql).
-- ---------------------------------------------------------------------
drop policy if exists aani_follows_private_guard on public.follows;
create policy aani_follows_private_guard on public.follows
  as restrictive for insert to authenticated
  with check (
    follower_id <> following_id
    and (
      (
        follower_id = (select auth.uid())
        and exists (
          select 1
          from public.profiles as target
          where target.id = following_id
            and not target.is_private
        )
      )
      or (
        following_id = (select auth.uid())
        and exists (
          select 1
          from public.follow_requests as request
          where request.requester_id = follower_id
            and request.recipient_id = following_id
        )
      )
    )
  );

-- حارس الحجب (تعريفه في 20261115000000) يُعاد إنشاؤه دفاعياً بنفس الشكل.
drop policy if exists aani_follows_block_guard on public.follows;
create policy aani_follows_block_guard on public.follows
  as restrictive for insert to authenticated
  with check (not public.aani_is_user_blocked(follower_id, following_id));

-- ---------------------------------------------------------------------
-- 4) تحقق داخل الترحيل: لا سياسة إدخال متساهلة أخرى توسّع الصلاحية
-- ---------------------------------------------------------------------
do $$
declare
  extra_policies text;
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'follows'
      and policyname = 'Users can follow as themselves'
      and permissive = 'PERMISSIVE'
      and cmd = 'INSERT'
  ) then
    raise exception 'سياسة الإدخال "Users can follow as themselves" غير مفعّلة على public.follows';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'follows'
      and policyname = 'aani_follows_private_guard'
      and permissive = 'RESTRICTIVE'
      and cmd = 'INSERT'
  ) then
    raise exception 'الحارس aani_follows_private_guard غير مفعّل كسياسة restrictive على public.follows';
  end if;

  select string_agg(policy.policyname, ', ' order by policy.policyname)
  into extra_policies
  from pg_policies as policy
  where policy.schemaname = 'public'
    and policy.tablename = 'follows'
    and policy.cmd in ('INSERT', 'ALL')
    and policy.permissive = 'PERMISSIVE'
    and policy.policyname <> 'Users can follow as themselves';

  if extra_policies is not null then
    raise exception
      'توجد سياسات إدخال متساهلة إضافية على public.follows توسّع الصلاحية: %. راجعها وأضفها إلى قائمة الحذف في هذا الترحيل قبل تطبيقه.',
      extra_policies;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد التطبيق (شغّلها في SQL Editor — ليست جزءاً من الترحيل)
-- =====================================================================
-- 0) توافق user_blocks: العمودان، لا صف بلا قيمة، لا تكرار، والفهرس موجود
--    select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'user_blocks' order by column_name;
--    -- المتوقع أن يظهر blocked_user_id دائماً، و blocked_id فقط على قاعدة الإنتاج القديمة
--
--    select count(*) as rows_total,
--           count(*) filter (where blocked_user_id is null) as missing,
--           count(distinct (blocker_id, blocked_user_id)) as distinct_pairs
--    from public.user_blocks;
--    -- المتوقع: missing = 0، و distinct_pairs = rows_total
--
--    select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'user_blocks' order by indexname;
--    -- المتوقع: aani_user_blocks_blocked_user_idx و aani_user_blocks_blocker_blocked_user_uidx
--
--    -- العمودان متزامنان (المتوقع: صفر صفوف)
--    select count(*) from public.user_blocks
--    where blocked_id is not null and blocked_id <> blocked_user_id;
--
-- 1) سياسات follows: سياستان متساهلتان (SELECT و INSERT) + حارسان restrictive
--    select policyname, permissive, cmd, qual, with_check
--    from pg_policies
--    where schemaname = 'public' and tablename = 'follows'
--    order by permissive, cmd, policyname;
--
-- 2) الدالة: definer، search_path مغلق، ومنح لـauthenticated فقط
--    select p.proname, p.prosecdef, p.proconfig, p.proacl
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'aani_respond_to_follow_request';
--
-- 3) صفوف متابعة لحسابات خاصة بلا طلب ولا موافقة (تدقيق تاريخي — لا يحذف شيئاً)
--    select f.follower_id, f.following_id, f.created_at
--    from public.follows as f
--    join public.profiles as owner on owner.id = f.following_id
--    where owner.is_private
--    order by f.created_at desc
--    limit 50;
--    -- هذه صفوف أُنشئت قبل الترحيل؛ القرار بشأنها لك (حذف أو إبقاء).
--
-- 4) اختبار بصري للحالات الأربع:
--    A حساب خاص، B غريب، C طالب، D صاحب حساب عام
--    -- B يتابع A مباشرة: يجب أن يفشل (42501 / row-level security)
--    insert into public.follows (follower_id, following_id) values ('<B>', '<A>');
--    -- C يرسل طلباً ثم A يقبل:
--    select public.aani_respond_to_follow_request('<C>', true);  -- true
--    select count(*) from public.follows where follower_id = '<C>' and following_id = '<A>'; -- 1
--    select count(*) from public.follow_requests where requester_id = '<C>'; -- 0
--    -- B يتابع D (عام) مباشرة: يجب أن ينجح
--    insert into public.follows (follower_id, following_id) values ('<B>', '<D>');
--    -- B يستدعي الدالة بمعرّف طلب ليس له: يجب أن يفشل
--    select public.aani_respond_to_follow_request('<C>', true);  -- exception 22023
--
-- 5) الحظر يعمل بالعمود القياسي بعد المزامنة (المتوقع: صف واحد ثم صفر)
--    select public.aani_block_user('<B>');
--    select count(*) from public.user_blocks where blocker_id = auth.uid() and blocked_user_id = '<B>';
--    select public.aani_unblock_user('<B>');
