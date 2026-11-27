-- تأسيس جهاز المستخدم: public.device_tokens
--
-- جدول واحد يدعم عدة أجهزة لكل مستخدم على المنصات الثلاث (web/android/ios)
-- ومزوّدي الإشعارات (fcm اليوم، وapns/pushkit لاحقاً دون إعادة تصميم):
--   * user_id -> public.profiles(id) ON DELETE CASCADE.
--   * provider + token فريدان على مستوى جميع المستخدمين ما دام الرمز غير
--     ملغى: لا يملك رمز FCM الواحد حسابان نشطان.
--   * provider + installation_id فريدان على مستوى جميع المستخدمين ما دام
--     التثبيت غير ملغى: الانتقال إلى حساب آخر على الجهاز نفسه يُلغي
--     ارتباط الحساب السابق (revoked_at) قبل تسجيل الحساب الجديد.
--   * revoked_at يُملأ عند تسجيل الخروج أو إلغاء صلاحية الجهاز أو نقل الملكية،
--     ولا يُحذف سجل الجهاز القديم.
--   * revoked_at يُملأ عند تسجيل الخروج أو إلغاء صلاحية الجهاز، ولا يُحذف الصف.
--   * وجود الصف لا يعني أن الجهاز يستقبل الآن: الإرسال يفحص revoked_at
--     وlast_seen_at في مرحلة الإرسال.
--
-- الصلاحيات: RLS مفعّلة، والمستخدم يقرأ ويكتب صفوفه فقط عبر سياسات
-- user_id = auth.uid()، والدوال SECURITY DEFINER محصورة بـauthenticated.
--
-- لم يُطبَّق هذا الترحيل على أي مشروع Supabase. يُطبَّق يدوياً بعد المراجعة.

begin;

create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  platform text not null check (platform in ('web', 'android', 'ios')),
  provider text not null default 'fcm' check (provider in ('fcm', 'apns', 'pushkit')),
  token text not null check (length(btrim(token)) between 1 and 4096),
  installation_id text,
  device_name text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- رمز واحد نشط على مستوى جميع المستخدمين لكل (مزوّد، رمز): لا تملك نفس
-- رمز FCM حسابان نشطان في الوقت نفسه.
drop index if exists public.device_tokens_user_provider_token_key;
create unique index if not exists device_tokens_active_token_key
  on public.device_tokens (provider, token)
  where revoked_at is null;

-- تثبيت واحد نشط على مستوى جميع المستخدمين لكل (مزوّد، installation_id):
-- الانتقال إلى حساب آخر على الجهاز نفسه يُلغي ارتباط الحساب السابق أولاً.
drop index if exists public.device_tokens_user_provider_installation_key;
create unique index if not exists device_tokens_active_installation_key
  on public.device_tokens (provider, installation_id)
  where installation_id is not null and revoked_at is null;

create index if not exists device_tokens_user_active_idx
  on public.device_tokens (user_id, last_seen_at desc)
  where revoked_at is null;

create or replace function public.aani_touch_device_token_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists aani_touch_device_token_updated_at on public.device_tokens;
create trigger aani_touch_device_token_updated_at
before update on public.device_tokens
for each row execute function public.aani_touch_device_token_updated_at();

alter table public.device_tokens enable row level security;
revoke all on table public.device_tokens from public, anon;
grant select, insert, update, delete on table public.device_tokens to authenticated;
grant select, insert, update, delete on table public.device_tokens to service_role;

drop policy if exists "Users read own device tokens" on public.device_tokens;
create policy "Users read own device tokens"
  on public.device_tokens for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users register own device tokens" on public.device_tokens;
create policy "Users register own device tokens"
  on public.device_tokens for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users update own device tokens" on public.device_tokens;
create policy "Users update own device tokens"
  on public.device_tokens for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users revoke own device tokens" on public.device_tokens;
create policy "Users revoke own device tokens"
  on public.device_tokens for delete to authenticated
  using (user_id = (select auth.uid()));

-- تسجيل رمز جهاز أو تدويره: يُلغي رمز التثبيت نفسه عند تغيّره، ثم يُسجّل
-- الرمز الجديد (أو يحدّث صفّه). لا يمسّ صفوف مستخدم آخر.
create or replace function public.aani_register_device_token(
  p_platform text,
  p_token text,
  p_provider text default 'fcm',
  p_installation_id text default null,
  p_device_name text default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.device_tokens
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_platform text := lower(btrim(coalesce(p_platform, '')));
  v_provider text := lower(btrim(coalesce(p_provider, 'fcm')));
  v_token text := btrim(coalesce(p_token, ''));
  v_installation text := nullif(btrim(coalesce(p_installation_id, '')), '');
  v_device_name text := nullif(btrim(coalesce(p_device_name, '')), '');
  v_attempt integer;
  v_row public.device_tokens;
begin
  if v_user is null then
    raise exception 'aani_register_device_token: authentication required' using errcode = '42501';
  end if;
  if v_platform not in ('web', 'android', 'ios') then
    raise exception 'aani_register_device_token: unsupported platform %', v_platform using errcode = '22023';
  end if;
  if v_provider not in ('fcm', 'apns', 'pushkit') then
    raise exception 'aani_register_device_token: unsupported provider %', v_provider using errcode = '22023';
  end if;
  if v_token = '' or length(v_token) > 4096 then
    raise exception 'aani_register_device_token: invalid token' using errcode = '22023';
  end if;

  -- النقل والتدوير خطوة واحدة ذرية: كل صف نشط يحمل الرمز نفسه أو التثبيت
  -- نفسه (لأي مستخدم، بما فيهم المستخدم الحالي) يُلغى قبل الإدراج، فلا تبقى
  -- ملكيتان نشطتان. السجل القديم يبقى محفوظاً بـrevoked_at ولا يُحذف.
  -- عند تسابق تسجيلين متزامنين، يفوز أحدهما ويُعاد الآخر بعد إلغاء الفائز،
  -- فيبقى صف نشط واحد دائماً.
  for v_attempt in 1..2 loop
    update public.device_tokens t
    set revoked_at = now(), updated_at = now()
    where t.provider = v_provider
      and t.revoked_at is null
      and (
        t.token = v_token
        or (v_installation is not null and t.installation_id = v_installation)
      );

    begin
      insert into public.device_tokens (
        user_id, platform, provider, token, installation_id, device_name, metadata, last_seen_at
      ) values (
        v_user, v_platform, v_provider, v_token, v_installation, v_device_name,
        coalesce(p_metadata, '{}'::jsonb), now()
      )
      returning * into v_row;

      return v_row;
    exception
      when unique_violation then
        if v_attempt = 2 then
          raise;
        end if;
    end;
  end loop;

  raise exception 'aani_register_device_token: could not register the device token' using errcode = '40001';
end
$$;

revoke all on function public.aani_register_device_token(text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.aani_register_device_token(text, text, text, text, text, jsonb) to authenticated, service_role;

-- إلغاء رمز جهاز عند تسجيل الخروج أو تعطيل الصلاحية: علامة revoked_at فقط،
-- والصف يبقى للسجل. لا يمسّ رموز مستخدم آخر.
create or replace function public.aani_revoke_device_token(
  p_token text default null,
  p_installation_id text default null,
  p_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_count integer := 0;
begin
  if v_user is null then
    raise exception 'aani_revoke_device_token: authentication required' using errcode = '42501';
  end if;

  update public.device_tokens t
  set revoked_at = now(), updated_at = now()
  where t.user_id = v_user
    and t.revoked_at is null
    and (
      (p_id is not null and t.id = p_id)
      or (p_token is not null and btrim(p_token) <> '' and t.token = btrim(p_token))
      or (p_installation_id is not null and btrim(p_installation_id) <> '' and t.installation_id = btrim(p_installation_id))
    );
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.aani_revoke_device_token(text, text, uuid) from public, anon;
grant execute on function public.aani_revoke_device_token(text, text, uuid) to authenticated, service_role;

revoke all on function public.aani_touch_device_token_updated_at() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
