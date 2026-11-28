-- إكمال التسجيل بعد Google + سجل أسماء المستخدمين + أساس الإدارة المركزية.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة،
-- وإعادة تطبيقه آمنة (idempotent) عدا التهيئة الأولى التي تُنفَّذ مرة واحدة
-- وتُسجَّل في public.aani_schema_markers.
--
-- القواعد:
-- 1) اسم المستخدم: من محرف واحد إلى 32 (كان ثلاثة على الأقل)، بأحرف صغيرة،
--    والمحارف المعتمدة نفسها: a-z 0-9 _ . بلا مسافات. القيد في قاعدة البيانات
--    هو الفيصل، والواجهة والخادم يتبعانه لا العكس. lower(username) فريد، فلا
--    يُنشئ اختلاف حالة الأحرف اسماً ثانياً.
-- 2) اكتمال التسجيل: عمود موثوق onboarding_completed_at، ووقت الموافقة
--    terms_accepted_at مع إصدار الشروط terms_version. الحساب الجديد من Google
--    يبدأ غير مكتمل، والحسابات القائمة عند تطبيق هذا الترحيل تُهيَّأ مرة واحدة
--    فلا يُفرض عليها إعادة تسجيل.
-- 3) سجل أسماء المستخدمين: username_registry بحالات available/reserved/
--    blocked/claimed. لا وصول مباشر لـanon أو authenticated (RLS + سحب كل
--    الصلاحيات)، والقراءة عبر aani_username_status، والمطالبة عبر
--    aani_claim_username وaani_complete_onboarding.
-- 4) الحجز والمنع لا يُتجاوزان: مشغّل BEFORE على profiles.username يرفض
--    المحجوز والممنوع والمأخوذ لأي كتابة (واجهة أو REST أو دالة)، والمطالبة
--    ذرية عبر قيد فريد، فلا يستطيع مستخدمان أخذ الاسم نفسه.
-- 5) الإدارة المستقبلية: كل تغيير إداري يُسجَّل في username_registry_audit
--    بهوية الجهة (actor_id/actor_kind) والسبب ووقت التغيير. لا حساب إداري
--    ولا لوحة في هذا الترحيل: التغييرات الإدارية تمر عبر service_role أو دالة
--    Edge محمية، ولا تُشتق من user_metadata أبداً.

begin;

-- =====================================================================
-- 1) أعمدة اكتمال التسجيل والموافقة
-- =====================================================================
alter table public.profiles add column if not exists onboarding_completed_at timestamptz;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;

comment on column public.profiles.onboarding_completed_at is
  'وقت اكتمال التسجيل — يُضبط من aani_complete_onboarding وحده. تفريغه يعني حساباً غير مكتمل.';
comment on column public.profiles.terms_accepted_at is
  'وقت الموافقة على الشروط وسياسة الخصوصية — يُضبط من aani_complete_onboarding وحده.';
comment on column public.profiles.terms_version is
  'إصدار الشروط الذي وُوفق عليه — يتغيّر عند نشر شروط جديدة.';

-- =====================================================================
-- 1ب) تطبيع الأسماء الحالية قبل إضافة القيود (بلا فقد بيانات)
--     الاسم غير المطابق يُنقّى إلى المحارف المعتمدة، وإذا فرغ يُشتق من
--     معرّف الحساب، وإذا صادم اسماً قائماً يُلحق به جزء من المعرّف.
--     لا يُحذف صف ولا يُعاد تسمية حساب إلى اسم آخر موجود.
-- =====================================================================
do $$
declare
  profile_row record;
  clean_name text;
begin
  for profile_row in
    select id, username
    from public.profiles
    where username is null
       or username !~ '^[a-z0-9_.]{1,32}$'
       or username <> lower(username)
  loop
    clean_name := left(regexp_replace(lower(coalesce(profile_row.username, '')), '[^a-z0-9_.]', '', 'g'), 32);
    if clean_name = '' then
      clean_name := left(replace(profile_row.id::text, '-', ''), 32);
    end if;

    if exists (
      select 1 from public.profiles as other
      where other.id <> profile_row.id
        and other.username = clean_name
    ) then
      clean_name := left(clean_name, 20) || '_' || substr(replace(profile_row.id::text, '-', ''), 1, 8);
    end if;

    update public.profiles set username = clean_name where id = profile_row.id;
  end loop;
end $$;

-- لا تُضاف القيود قبل التحقق: فشل الآن أوضح من فشل ALTER TABLE لاحقاً.
do $$
declare
  offenders integer;
begin
  select count(*) into offenders
  from public.profiles
  where username is null
     or username !~ '^[a-z0-9_.]{1,32}$'
     or username <> lower(username);

  if offenders > 0 then
    raise exception 'ASSERT: % profiles still hold a username outside ^[a-z0-9_.]{1,32}$', offenders
      using errcode = '23514';
  end if;
end $$;

-- =====================================================================
-- 2) قيد اسم المستخدم الجديد + التفرد بلا حساسية لحالة الأحرف
--     الحد الأدنى محرف واحد: a و7 وab و12 و123 وأرقام فقط وحروف فقط ومختلط.
-- =====================================================================
alter table public.profiles drop constraint if exists profiles_username_format_check;
alter table public.profiles
  add constraint profiles_username_format_check
  check (username = lower(username) and username ~ '^[a-z0-9_.]{1,32}$');

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

comment on constraint profiles_username_format_check on public.profiles is
  'اسم المستخدم: 1–32 محرفاً من a-z 0-9 _ . بأحرف صغيرة، بلا مسافات (كان 3 على الأقل).';

-- =====================================================================
-- 3) سجل أسماء المستخدمين + سجل التدقيق
-- =====================================================================
create table if not exists public.username_registry (
  username text primary key,
  state text not null default 'available',
  user_id uuid references auth.users (id) on delete set null,
  reason text,
  actor_id uuid,
  actor_kind text not null default 'system',
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_registry_username_format
    check (username = lower(username) and username ~ '^[a-z0-9_.]{1,32}$'),
  constraint username_registry_state_check
    check (state in ('available', 'reserved', 'blocked', 'claimed')),
  constraint username_registry_actor_kind_check
    check (actor_kind in ('system', 'user', 'admin')),
  constraint username_registry_claim_shape
    check (
      (state = 'claimed' and user_id is not null)
      or (state <> 'claimed' and user_id is null)
    )
);

comment on table public.username_registry is
  'حالة كل اسم مستخدم: available متاح، reserved محجوز للإدارة (قد ينتهي)، blocked ممنوع، claimed مملوك لحساب. لا وصول مباشر لغير service_role.';
comment on column public.username_registry.reserved_until is
  'تاريخ انتهاء الحجز المؤقت — NULL يعني حجزاً دائماً حتى قرار إداري.';
comment on column public.username_registry.actor_kind is
  'من غيّر الحالة: system (مشغّل/تهيئة)، user (المالك)، admin (إدارة مستقبلية عبر خدمة موثوقة).';

create unique index if not exists username_registry_one_claim_per_user_idx
  on public.username_registry (user_id) where state = 'claimed';
create index if not exists username_registry_state_idx
  on public.username_registry (state);

create table if not exists public.username_registry_audit (
  id bigint generated always as identity primary key,
  username text not null,
  previous_state text,
  new_state text not null,
  previous_user_id uuid,
  new_user_id uuid,
  reason text,
  actor_id uuid,
  actor_kind text not null default 'system',
  created_at timestamptz not null default now(),
  constraint username_registry_audit_state_check
    check (new_state in ('available', 'reserved', 'blocked', 'claimed')),
  constraint username_registry_audit_actor_kind_check
    check (actor_kind in ('system', 'user', 'admin'))
);

create index if not exists username_registry_audit_username_idx
  on public.username_registry_audit (username, created_at desc);

comment on table public.username_registry_audit is
  'سجل تدقيق لكتابي فقط: كل مطالبة/حجز/منع/إتاحة مع من فعلها ومتى ولماذا. لا يعدّله أو يحذفه أي دور عميل.';

-- =====================================================================
-- 4) الصلاحيات: لا وصول مباشر لـanon أو authenticated على السجلين
--     القراءة عبر الدالة، والتغيير عبر service_role أو دالة Edge محمية.
-- =====================================================================
alter table public.username_registry enable row level security;
alter table public.username_registry_audit enable row level security;

revoke all on table public.username_registry from public, anon, authenticated;
revoke all on table public.username_registry_audit from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.username_registry to service_role';
    -- سجل التدقيق: إضافة وقراءة فقط، لا تعديل ولا حذف.
    execute 'grant select, insert on table public.username_registry_audit to service_role';
  end if;
end $$;

drop policy if exists aani_username_registry_service_role on public.username_registry;
create policy aani_username_registry_service_role on public.username_registry
  for all to service_role
  using (true)
  with check (true);

drop policy if exists aani_username_registry_audit_service_role on public.username_registry_audit;
create policy aani_username_registry_audit_service_role on public.username_registry_audit
  for all to service_role
  using (true)
  with check (true);

-- لا تُمنح أعمدة السماح/الوقت للتحديث المباشر من العميل.
revoke update (onboarding_completed_at, terms_accepted_at, terms_version)
  on table public.profiles from authenticated;

-- =====================================================================
-- 5) الدوال
-- =====================================================================

-- 5أ) تطبيع اسم المستخدم: بلا @، بلا فراغات، بأحرف صغيرة، أو NULL إذا كان
--     خارج الصيغة المعتمدة (1–32 من a-z 0-9 _ .).
create or replace function public.aani_normalize_username(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when candidate.value ~ '^[a-z0-9_.]{1,32}$' then candidate.value
    else null
  end
  from (
    select lower(btrim(regexp_replace(btrim(coalesce(p_value, '')), '^@+', ''))) as value
  ) as candidate;
$$;

revoke all on function public.aani_normalize_username(text) from public, anon;
grant execute on function public.aani_normalize_username(text) to authenticated, service_role;

-- 5ب) حالة الاسم كما يراها المستدعي:
--     available / reserved / blocked / claimed / self / invalid.
--     لا تكشف هوية مالك الاسم، ولا تُقرأ إلا بهوية جلسة.
create or replace function public.aani_username_status(p_username text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate text := public.aani_normalize_username(p_username);
  registry public.username_registry%rowtype;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if candidate is null then
    return 'invalid';
  end if;

  select * into registry from public.username_registry where username = candidate;
  if found then
    if registry.state = 'blocked' then
      return 'blocked';
    end if;
    if registry.state = 'reserved'
       and (registry.reserved_until is null or registry.reserved_until > now()) then
      return 'reserved';
    end if;
    if registry.state = 'claimed' then
      return case
        when registry.user_id is not distinct from caller then 'self'
        else 'claimed'
      end;
    end if;
  end if;

  -- اسم موجود في الملفات بلا سجل (قبل التهيئة أو صف طارئ): مأخوذ لغيره.
  if exists (
    select 1 from public.profiles where username = candidate and id <> caller
  ) then
    return 'claimed';
  end if;

  return 'available';
end;
$$;

revoke all on function public.aani_username_status(text) from public, anon;
grant execute on function public.aani_username_status(text) to authenticated;

-- 5ج) المطالبة الذرية بالاسم باسم المستخدم الحالي.
--     ترتيب الفحص: منع → حجز (غير منتهٍ) → مأخوذ من غيره → المصادم الحقيقي.
--     القيد الفريد على lower(username) يحسم التزامن: مطالبتان متزامنتان
--     لنفس الاسم إحداهما تفشل بـ23505، فلا اسم مزدوج.
create or replace function public.aani_claim_username(p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate text := public.aani_normalize_username(p_username);
  registry public.username_registry%rowtype;
  has_profile boolean := false;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if candidate is null then
    raise exception 'invalid_username' using errcode = '22023';
  end if;

  -- قفل السجل إن وُجد: يمنع حجزين متزامنين لنفس الاسم.
  select * into registry from public.username_registry where username = candidate for update;
  if found then
    if registry.state = 'blocked' then
      raise exception 'username blocked' using errcode = '42501';
    end if;
    if registry.state = 'reserved'
       and (registry.reserved_until is null or registry.reserved_until > now()) then
      raise exception 'username reserved' using errcode = '42501';
    end if;
    if registry.state = 'claimed'
       and registry.user_id is not null
       and registry.user_id <> caller then
      raise exception 'username already claimed' using errcode = '23505';
    end if;
  end if;

  if exists (
    select 1 from public.profiles where username = candidate and id <> caller
  ) then
    raise exception 'username already claimed' using errcode = '23505';
  end if;

  select true into has_profile from public.profiles where id = caller;
  if has_profile is not true then
    raise exception 'profile row missing' using errcode = 'P0002';
  end if;

  update public.profiles set username = candidate where id = caller;
  return candidate;
end;
$$;

revoke all on function public.aani_claim_username(text) from public, anon;
grant execute on function public.aani_claim_username(text) to authenticated;

-- 5د) إكمال التسجيل: الدالة الوحيدة التي تغلق التسجيل وتثبت الموافقة.
--     تتحقق من الحقول، تنشئ الملف إن غاب، تطالب بالاسم، ثم تسجّل الاسم
--     الكامل وتاريخ الميلاد والجنس والموافقة ووقتها وحالة الإكمال.
create or replace function public.aani_complete_onboarding(
  p_username text,
  p_full_name text,
  p_birth_date date,
  p_gender text,
  p_terms_version text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate text := public.aani_normalize_username(p_username);
  clean_full_name text := btrim(coalesce(p_full_name, ''));
  accepted_version text := btrim(coalesce(p_terms_version, ''));
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if candidate is null then
    raise exception 'invalid_username' using errcode = '22023';
  end if;
  if clean_full_name = '' or char_length(clean_full_name) > 120 then
    raise exception 'invalid_full_name' using errcode = '22023';
  end if;
  if p_gender is null or p_gender not in ('male', 'female') then
    raise exception 'invalid_gender' using errcode = '22023';
  end if;
  if p_birth_date is null or p_birth_date > current_date or p_birth_date < date '1900-01-01' then
    raise exception 'invalid_birth_date' using errcode = '22023';
  end if;

  -- الموافقة إلزامية: لا اكتمال بلا إصدار شروط صريح.
  if accepted_version = '' then
    raise exception 'terms_required' using errcode = '22023';
  end if;

  -- ملف غائب (حساب بلا صف): يُنشأ الآن، فلا يعلق الإكمال.
  begin
    insert into public.profiles (id, username, full_name)
    values (caller, candidate, left(clean_full_name, 120))
    on conflict (id) do nothing;
  exception
    when unique_violation then
      raise exception 'username already claimed' using errcode = '23505';
  end;

  perform public.aani_claim_username(candidate);

  update public.profiles
  set full_name = left(clean_full_name, 120),
      birth_date = p_birth_date,
      gender = p_gender,
      terms_accepted_at = coalesce(terms_accepted_at, now()),
      terms_version = accepted_version,
      onboarding_completed_at = coalesce(onboarding_completed_at, now()),
      updated_at = now()
  where id = caller;

  return candidate;
end;
$$;

revoke all on function public.aani_complete_onboarding(text, text, date, text, text) from public, anon;
grant execute on function public.aani_complete_onboarding(text, text, date, text, text) to authenticated;

-- 5هـ) حالة إكمال التسجيل لصاحب الحساب وحده (لا معرّف خارجي).
create or replace function public.aani_my_onboarding_state()
returns table (
  onboarding_completed_at timestamptz,
  terms_accepted_at timestamptz,
  terms_version text,
  username text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    profile.onboarding_completed_at,
    profile.terms_accepted_at,
    profile.terms_version,
    profile.username
  from public.profiles as profile
  where profile.id = auth.uid();
$$;

revoke all on function public.aani_my_onboarding_state() from public, anon;
grant execute on function public.aani_my_onboarding_state() to authenticated;

-- =====================================================================
-- 6) مشغّلات profiles: حارس الاسم، مزامنة السجل، وحارس أعمدة الموافقة
-- =====================================================================

-- 6أ) الحارس: كل كتابة على username تُطبَّع وتُفحص ضد السجل، فالحجز والمنع
--     لا يُتجاوزان بتحديث REST مباشر. الاسم نفسه لصاحبه لا يُفحص من جديد.
create or replace function public.aani_profiles_username_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text := public.aani_normalize_username(new.username);
  registry public.username_registry%rowtype;
begin
  if new.username is null then
    return new;
  end if;

  if candidate is null then
    raise exception 'invalid_username' using errcode = '22023';
  end if;

  new.username := candidate;

  -- إعادة حفظ الاسم نفسه: لا مطالبة جديدة، فلا يُقفل الملف بسبب حجز لاحق.
  if tg_op = 'UPDATE' and old.username is not distinct from new.username then
    return new;
  end if;

  select * into registry from public.username_registry where username = candidate;
  if found then
    if registry.state = 'blocked' then
      raise exception 'username blocked' using errcode = '42501';
    end if;
    if registry.state = 'reserved'
       and (registry.reserved_until is null or registry.reserved_until > now()) then
      raise exception 'username reserved' using errcode = '42501';
    end if;
    if registry.state = 'claimed'
       and registry.user_id is not null
       and registry.user_id <> new.id then
      raise exception 'username already claimed' using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

-- 6ب) المزامنة: الاسم المطالَب به يُسجّل مملوكاً، والاسم السابق يعود متاحاً،
--     وكل انتقال يُسجَّل في التدقيق (مطالبة/إتاحة).
create or replace function public.aani_profiles_username_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_name text;
begin
  -- حذف الحساب: اسمه يعود متاحاً، فلا يبقى سجل مملوك لحساب غير موجود،
  -- ولا يفشل حذف الحساب على قيد username_registry_claim_shape.
  if tg_op = 'DELETE' then
    update public.username_registry
    set state = 'available', user_id = null, reserved_until = null, updated_at = now()
    where username = public.aani_normalize_username(old.username)
      and state = 'claimed'
      and user_id = old.id;
    if found then
      insert into public.username_registry_audit
        (username, previous_state, new_state, previous_user_id, actor_id, actor_kind, reason)
      values
        (public.aani_normalize_username(old.username), 'claimed', 'available', old.id, null, 'system', 'username released by account deletion');
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    previous_name := public.aani_normalize_username(old.username);
  end if;

  if previous_name is not null and previous_name <> new.username then
    update public.username_registry
    set state = 'available', user_id = null, reserved_until = null, updated_at = now()
    where username = previous_name and state = 'claimed' and user_id = new.id;
    if found then
      insert into public.username_registry_audit
        (username, previous_state, new_state, previous_user_id, actor_id, actor_kind, reason)
      values
        (previous_name, 'claimed', 'available', new.id, new.id, 'system', 'username released by rename');
    end if;
  end if;

  insert into public.username_registry (username, state, user_id, actor_id, actor_kind, reason)
  values (new.username, 'claimed', new.id, new.id, 'system', 'username claimed')
  on conflict (username) do update
    set state = 'claimed',
        user_id = excluded.user_id,
        reserved_until = null,
        updated_at = now();

  insert into public.username_registry_audit
    (username, previous_state, new_state, new_user_id, actor_id, actor_kind, reason)
  select new.username, null, 'claimed', new.id, new.id, 'system', 'username claimed'
  where not exists (
    select 1 from public.username_registry_audit as audit
    where audit.username = new.username
      and audit.new_state = 'claimed'
      and audit.new_user_id = new.id
  );

  return null;
end;
$$;

-- 6ج) حارس الموافقة: العميل لا يضبط وقت الموافقة ولا حالة الإكمال ولا
--     إصدارها مباشرة، حتى لو ملك منح التحديث على العمود.
create or replace function public.aani_profiles_onboarding_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.onboarding_completed_at is distinct from old.onboarding_completed_at then
      raise exception 'onboarding_completed_at changes only through aani_complete_onboarding'
        using errcode = '42501';
    end if;
    if new.terms_accepted_at is distinct from old.terms_accepted_at
       or new.terms_version is distinct from old.terms_version then
      raise exception 'the consent record changes only through aani_complete_onboarding'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists aani_profiles_username_guard_trg on public.profiles;
create trigger aani_profiles_username_guard_trg
  before insert or update of username on public.profiles
  for each row execute function public.aani_profiles_username_guard();

drop trigger if exists aani_profiles_username_sync_trg on public.profiles;
create trigger aani_profiles_username_sync_trg
  after insert or update of username on public.profiles
  for each row execute function public.aani_profiles_username_sync();

-- حذف الحساب يُعيد اسمه متاحاً (وإلا بقي سجل مملوك لحساب محذوف).
drop trigger if exists aani_profiles_username_delete_trg on public.profiles;
create trigger aani_profiles_username_delete_trg
  after delete on public.profiles
  for each row execute function public.aani_profiles_username_sync();

drop trigger if exists aani_profiles_onboarding_guard_trg on public.profiles;
create trigger aani_profiles_onboarding_guard_trg
  before update on public.profiles
  for each row execute function public.aani_profiles_onboarding_guard();

-- =====================================================================
-- 7) مشغّل إنشاء الحساب: الحد الأدنى محرف واحد (لا ثلاثة)
--     الإكمال يبدأ فارغاً دائماً: الاسم البديل ليس دليل اكتمال.
-- =====================================================================
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_full_name text;
  requested_gender text;
  requested_city text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''),
    '[^a-z0-9_.]',
    '',
    'g'
  ));
  -- البديل من المعرّف فقط عند غياب أي محرف صالح: لا استبدال لاسم من محرف واحد.
  if requested_username = '' then
    requested_username := replace(new.id::text, '-', '');
  end if;

  requested_full_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Member'
  );

  requested_gender := coalesce(new.raw_user_meta_data ->> 'gender', 'male');
  if requested_gender not in ('male', 'female') then
    requested_gender := 'male';
  end if;

  requested_city := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')), '');

  insert into public.profiles (id, username, full_name, gender, city, location)
  values (
    new.id,
    left(requested_username, 32),
    left(requested_full_name, 120),
    requested_gender,
    requested_city,
    requested_city
  )
  on conflict (id) do update set
    gender = excluded.gender,
    city = coalesce(excluded.city, public.profiles.city),
    location = coalesce(excluded.location, public.profiles.location);

  return new;
end;
$$;

-- =====================================================================
-- 8) التهيئة مرة واحدة: سجل الأسماء الحالية + إعفاء الحسابات القائمة
--     علامة في aani_schema_markers تمنع تكرار التهيئة عند إعادة التطبيق،
--     فلا تُغلق حسابات جديدة غير مكتملة بسبب ترحيل أُعيد تشغيله.
-- =====================================================================
create table if not exists public.aani_schema_markers (
  marker text primary key,
  applied_at timestamptz not null default now()
);

alter table public.aani_schema_markers enable row level security;
revoke all on table public.aani_schema_markers from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.aani_schema_markers to service_role';
  end if;
end $$;

do $$
declare
  marker_key constant text := 'username_registry_onboarding_backfill_v1';
  registered integer := 0;
  grandfathered integer := 0;
begin
  if exists (select 1 from public.aani_schema_markers where marker = marker_key) then
    raise notice 'backfill skipped: % already applied', marker_key;
    return;
  end if;

  -- الأسماء الحالية تُسجَّل مملوكة لأصحابها: لا تُحجز ولا تُعاد تسمية.
  insert into public.username_registry (username, state, user_id, actor_kind, reason)
  select distinct on (lower(profile.username))
         lower(profile.username), 'claimed', profile.id, 'system', 'backfill of existing username'
  from public.profiles as profile
  where profile.username ~ '^[a-z0-9_.]{1,32}$'
  order by lower(profile.username), profile.created_at nulls last, profile.id
  on conflict (username) do nothing;
  get diagnostics registered = row_count;

  -- الحسابات القائمة عند هذا الترحيل مكتملة: لا يُفرض عليها إعادة تسجيل.
  -- الاسم البديل وحده ليس دليلاً، والدليل هو وجود الحساب قبل الترحيل.
  update public.profiles
  set onboarding_completed_at = coalesce(created_at, now())
  where onboarding_completed_at is null;
  get diagnostics grandfathered = row_count;

  insert into public.aani_schema_markers (marker) values (marker_key);

  raise notice 'backfill: % usernames registered, % existing profiles grandfathered',
    registered, grandfathered;
end $$;

notify pgrst, 'reload schema';

commit;
