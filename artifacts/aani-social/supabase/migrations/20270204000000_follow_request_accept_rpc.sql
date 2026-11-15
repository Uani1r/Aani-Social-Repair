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
-- لا يعدّل: جداول، بيانات، سياسات القراءة للمنشورات، القصص، الإشعارات،
-- أو أي ميزة أخرى. الملف السابق 20270203000000 يبقى مرجع حماية القراءة،
-- ويعتمد الآن على صفوف follows التي لا تُنشأ إلا بموافقة.
--
-- آمن للتكرار. لا يُنفَّذ تلقائياً من التطبيق.
begin;

-- ---------------------------------------------------------------------
-- 0) التحقق من المتطلبات المسبقة قبل أي تغيير
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.follows') is null then
    raise exception 'public.follows غير موجود — لا يمكن تطبيق هذا الترحيل';
  end if;

  if to_regclass('public.follow_requests') is null then
    raise exception 'public.follow_requests غير موجود — طبّق 20261108000000 أولاً';
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

  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_is_user_blocked'
  ) then
    raise exception 'الدالة public.aani_is_user_blocked مفقودة — طبّق 20261115000000 أولاً';
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
