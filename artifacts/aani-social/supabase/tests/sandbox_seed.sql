-- =====================================================================
-- بيانات اختبار Sandbox المالي — ثابتة ومستقلة (لا علاقة لها بالإنتاج).
-- تُطبَّق بعد schema.sql والترحيل المالي على قاعدة اختبار محلية مؤقتة.
--
-- هوية UUID ثابتة (مطابقة لمتغيرات myapp.* في sandbox_isolation.test.sql):
--   userA    = 00000000-0000-0000-0000-0000000000a1
--   userB    = 00000000-0000-0000-0000-0000000000a2
--   userC    = 00000000-0000-0000-0000-0000000000a3
--   founder  = 00000000-0000-0000-0000-0000000000a4
--   gift     = 00000000-0000-0000-0000-0000000000b1
--   package  = 00000000-0000-0000-0000-0000000000c1 (top_up)
--   sub_pkg  = 00000000-0000-0000-0000-0000000000d1 (subscription)
--   promo_pkg= 00000000-0000-0000-0000-0000000000e1 (promotion, post)
--   postA    = 00000000-0000-0000-0000-0000000000f1 (يملكه userA)
--   postB    = 00000000-0000-0000-0000-0000000000f2 (يملكه userB)
-- =====================================================================

-- 1) المستخدمون (أربعة على الأقل). trigger إنشاء الملف الشخصي ينشئ profiles.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'usera@test.local', '{"username":"usera","full_name":"User A","gender":"male","city":"Test City"}'::jsonb, now()),
  ('00000000-0000-0000-0000-0000000000a2', 'userb@test.local', '{"username":"userb","full_name":"User B","gender":"female","city":"Test City"}'::jsonb, now()),
  ('00000000-0000-0000-0000-0000000000a3', 'userc@test.local', '{"username":"userc","full_name":"User C","gender":"male","city":"Test City"}'::jsonb, now()),
  ('00000000-0000-0000-0000-0000000000a4', 'founder@test.local', '{"username":"founder","full_name":"Founder","gender":"male","city":"Test City"}'::jsonb, now());

-- 2) المؤسس في قائمة السماح (خادم فقط).
insert into sandbox.founders (user_id)
values ('00000000-0000-0000-0000-0000000000a4')
on conflict (user_id) do nothing;

-- 3) هدية اختبار فعّالة بسعر ثابت.
insert into public.gifts (id, name, price, popularity_points, is_active)
values ('00000000-0000-0000-0000-0000000000b1', 'Test Gift', 100, 0, true)
on conflict (id) do nothing;

-- 4) تثبيت UUID حزم الكتالوج التي أنشأها الترحيل تلقائياً.
update sandbox.top_up_packages set id = '00000000-0000-0000-0000-0000000000c1'
  where name = 'باقة صغيرة';
update sandbox.subscription_packages set id = '00000000-0000-0000-0000-0000000000d1'
  where name = 'اشتراك أسبوعي';
update sandbox.promotion_packages set id = '00000000-0000-0000-0000-0000000000e1'
  where name = 'ترويج منشور - أسبوع' and target_type = 'post';

-- 5) منشورات اختبار: واحد يملكه userA وآخر يملكه userB (مستخدم آخر).
insert into public.posts (id, user_id, content, type, destination, visibility)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Post owned by userA', 'text', 'feed', 'public'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a2', 'Post owned by userB', 'text', 'feed', 'public');

-- 6) التحقق من جاهزية البيانات (يفشل مبكراً إن ناقص شيء).
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.profiles
   where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4');
  if v_count <> 4 then
    raise exception 'seed: expected 4 profiles, got %', v_count;
  end if;

  select count(*) into v_count from sandbox.founders where user_id = '00000000-0000-0000-0000-0000000000a4';
  if v_count <> 1 then
    raise exception 'seed: founder not present';
  end if;

  select count(*) into v_count from sandbox.top_up_packages where id = '00000000-0000-0000-0000-0000000000c1';
  if v_count <> 1 then
    raise exception 'seed: top_up package id not fixed';
  end if;

  select count(*) into v_count from sandbox.subscription_packages where id = '00000000-0000-0000-0000-0000000000d1';
  if v_count <> 1 then
    raise exception 'seed: subscription package id not fixed';
  end if;

  select count(*) into v_count from sandbox.promotion_packages where id = '00000000-0000-0000-0000-0000000000e1' and target_type = 'post';
  if v_count <> 1 then
    raise exception 'seed: promotion package id not fixed';
  end if;
end $$;