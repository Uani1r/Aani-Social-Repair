-- =====================================================================
-- إصلاح سياسة قراءة هدايا الملف الشخصي (gift_transactions) لزائر الملف.
--
-- المشكلة التي يعالجها هذا الترحيل:
--   السياسة السابقة (20270408000000) كانت:
--       using (recipient_id = auth.uid() or sender_id = auth.uid())
--   فتقتصر القراءة على المرسل والمستلم فقط، ولا يستطيع زائر الملف قراءة
--   الهدايا المستلمة الظاهرة للعموم. (النسخة الأقدم 20270406000000 كانت
--   using (true) وهي أسوأ: تقرأ كل الصفوف لكل مستخدم.)
--
-- القاعدة الجديدة (مصدر واحد للحقيقة):
--   * المستلم (صاحب الملف) يقرأ هداياه المستلمة دائماً.
--   * الزائر المسجّل يقرأ الهدايا المستلمة إذا سمح إعداد خصوصية صاحب الملف:
--       - صاحب حساب غير خاص: متاح لكل مستخدم مسجّل.
--       - صاحب حساب خاص: متاح لصاحب الحساب ولمتابعه المعتمد فقط
--         (صف في public.follows: follower_id = المشاهد، following_id = المستلم).
--   * الحظر (public.user_blocks) يمنع القراءة في الاتجاهين، عبر حارس
--     restrictive منفصل يُنشأ فقط عند وجود الدالة aani_is_user_blocked
--     (الموجودة في الإنتاج، وقد لا توجد في قاعدة مبنية من schema.sql وحده).
--
-- لا نستخدم using (true)، ولا ننحصر القراءة في المرسل/المستلم.
-- لا نعدّل جدولاً ولا بيانات ولا صلاحيات أعمدة.
-- لا نلمس قفل التزامن في aani_send_gift (20270408000000).
--
-- آمن للتكرار: الدالة تُستبدل، والسياسات تُحذف ثم تُنشأ.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1) دالة مساعدة واحدة للقراءة (الخصوصية فقط؛ الحظر في حارس منفصل).
--    SECURITY DEFINER لأنها تقرأ profiles.is_private و follows بغض النظر عن
--    RLS الخاص بهما. search_path = '' مع تأهيل كامل للأسماء.
--    لا تُعيد true إلا عن المشاهد نفسه (p_viewer_id = auth.uid()).
-- ---------------------------------------------------------------------
create or replace function public.aani_can_read_received_gifts(
  p_recipient_id uuid,
  p_viewer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as owner
    where owner.id = p_recipient_id
      and (
        -- (أ) المستلم: يقرأ هداياه المستلمة دائماً.
        (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and p_recipient_id = p_viewer_id
        )
        -- (ب) زائر مسجّل: حساب غير خاص، أو حساب خاص بشرط متابعة معتمدة.
        or (
          p_viewer_id is not null
          and p_viewer_id = auth.uid()
          and (
            not owner.is_private
            or exists (
              select 1
              from public.follows as accepted
              where accepted.follower_id = p_viewer_id
                and accepted.following_id = p_recipient_id
            )
          )
        )
      )
  );
$$;

revoke all on function public.aani_can_read_received_gifts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.aani_can_read_received_gifts(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2) سياسة القراءة: تحذف أي نسخة سابقة (using(true) أو المرسل/المستلم فقط)
--    ثم تُنشأ بالشرط الجديد.
-- ---------------------------------------------------------------------
alter table public.gift_transactions enable row level security;

drop policy if exists aani_gift_transactions_select_received on public.gift_transactions;
create policy aani_gift_transactions_select_received on public.gift_transactions
  for select to authenticated
  using (public.aani_can_read_received_gifts(recipient_id, (select auth.uid())));

-- ---------------------------------------------------------------------
-- 3) حارس الحظر (restrictive) يُجمع بـ AND مع السياسة أعلاه.
--    يُنشأ فقط إذا كانت الدالة aani_is_user_blocked موجودة (الإنتاج)، لأن
--    قاعدة مبنية من schema.sql وحده قد لا تحتوي user_blocks/الدالة، وسياسة
--    تشير إلى دالة مفقودة تُفشل الترحيل.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'aani_is_user_blocked'
  ) then
    raise warning
      'الدالة aani_is_user_blocked غائبة: تم تخطي حارس الحظر على gift_transactions. طبّق 20261115000000/20270204000000 ثم أعد تشغيل هذا الترحيل.';
    return;
  end if;

  execute 'drop policy if exists aani_gift_transactions_block_guard on public.gift_transactions';
  execute $policy$
    create policy aani_gift_transactions_block_guard on public.gift_transactions
      as restrictive for select to authenticated
      using (not public.aani_is_user_blocked((select auth.uid()), recipient_id))
  $policy$;
end $$;

commit;