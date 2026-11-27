# تأسيس نظام الإشعارات — الجرد والمصالحة

الفرع: `feat/notifications-foundation-audit` — الأساس: `main` عند `8e47a13`.

## معرّف مشروع Supabase (مُتحقَّق من إعدادات المستودع)

المعرّف الصحيح هو **`auqqqwfjxrxizlmeweka`** (بـ`eka` في النهاية)، كما في:

- `artifacts/aani-social/.env.example` و`.env.local`: `VITE_SUPABASE_URL=https://auqqqwfjxrxizlmeweka.supabase.co`
- `artifacts/aani-social/src/lib/supabase.ts` (الاحتياط العام لنفس العنوان)

المعرّف `auqqqwfjxrxizlmewika` في تقرير سابق كان **خطأ مطبعي**، ولم يُستخدم في أي اتصال.

## حدود التحقق في هذه المرحلة

- محاولة القراءة فقط على المشروع الصحيح رفضها Supabase Management API بالرسالة الحرفية
  «Supabase Management API did not accept its key.»
  لذلك العمود «في القاعدة» أدناه **غير متحقق**، ولا يُبنى عليه أي استنتاج.
  المطلوب مفتاح Management API جديد من الشريط فوق حقل الرسالة ثم إعادة الاستعلامات في نهاية الملف.
- **لم يُطبَّق أي ترحيل** ولم يُعدَّل أي شيء في Supabase.


## جدول المقارنة

| العنصر | في المستودع | في القاعدة | الفرق | الإجراء الآمن |
|---|---|---|---|---|
| `public.notifications` | `fresh_schema_cloudflare_r2.sql` (الجدول + RLS + السياسات) وترحيلات 20261025…20261230 | غير متحقق | — | لا تغيير في هذه المرحلة |
| منع الرسائل/المكالمات من الإشعارات العامة | `20261228000000` (إسقاط trigger الرسائل) و`20261229000000` (حذف السجلات + trigger حارس) | غير متحقق | — | يبقى كما هو؛ الاختبار الجديد يستدعيه ويؤكد وجوده |
| `public.profiles.fcm_token` | `20261227000000` (عمود + منح محدود) | غير متحقق | — | يبقى للتوافق؛ `device_tokens` هو المسار الجديد |
| `public.device_tokens` | غير موجود | غير متحقق | جديد | ترحيل forward-only `20270312000000_device_tokens.sql` |
| `public.notification_outbox` | غير موجود | غير متحقق | جديد | ترحيل forward-only `20270312000001_notification_outbox.sql` |
| تسجيل أحداث Push للرسائل/المكالمات | غير موجود (الويبهوك الحالي في `api-server`) | غير متحقق | جديد | ترحيل forward-only `20270312000002_notification_push_outbox_triggers.sql` |
| `supabase_migrations.schema_migrations` | آخر ملف محلي قبل الفرع `20270310000000` | غير متحقق | غير معروف | لم يُضف أي سجل وهمي، ولم تُعاد أي ترحيل قديم |

## قواعد المصالحة المتَّبعة

1. لا سجلات وهمية في `schema_migrations`.
2. لا يُعتبر أي ترحيل مطبقاً إلا بإثبات آثاره (الجدول/السياسة/الدالة/الـtrigger).
3. لا إعادة تطبيق عمياء لترحيل قديم، ولا إعادة ضبط للمخطط، ولا إعادة إنشاء الجداول.
4. لا حذف أو استبدال أي trigger أو function عاملة. حارس 20261229 يُترك ويعمل،
   و`aani_notify_on_message_insert` لم يُعَد إنشاؤه لأنه أُسقط سابقاً في 20261228/20261229.
5. كل التصحيح إلى الأمام فقط، ومكتوب ليكون آمناً عند إعادة التنفيذ
   (`if not exists`، `create or replace`، `drop policy if exists`، `on conflict do nothing`).

## استعلامات التحقق المطلوبة عند توفر مفتاح Management API

```sql
-- وجود الجداول التي تتوقعها الترحيلات
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('notifications', 'device_tokens', 'notification_outbox',
                     'message_conversation_settings', 'user_blocks');

-- الأعمدة الفعلية لـnotifications وprofiles.fcm_token
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'notifications';

-- الـtriggers الفعلية على الرسائل والإشعارات
select event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('messages', 'notifications');

-- هل ما زال الرسائل/المكالمات ممنوعة من الإشعارات العامة؟
select count(*) from public.notifications
where lower(type) in ('message', 'new_message', 'chat_message', 'call', 'incoming_call', 'missed_call');

-- سجل الترحيلات
select max(version), count(*) from supabase_migrations.schema_migrations;
```


## قواعد الملكية والتفضيلات (المراجعة الثانية)

**ملكية رمز الجهاز:**

- قيد فريد نشط على `(provider, token)` وعليه `(provider, installation_id)` على مستوى **جميع المستخدمين**، لا داخل المستخدم.
- `aani_register_device_token` تُلغي في خطوة واحدة (داخل المعاملة) كل صف نشط يحمل الرمز نفسه أو التثبيت نفسه لأي مستخدم — بما فيهم المستخدم الحالي — ثم تُدرج صفاً جديداً. عند تسابق تسجيلين، يفوز أحدهما ويُعاد الآخر بعد إلغاء الفائز، فيبقى صف نشط واحد دائماً.
- الانتقال إلى حساب جديد على الجهاز نفسه يُلغي ارتباط الحساب السابق بـ`revoked_at` ولا يحذف سجله.
- المستخدم لا يقدر على قراءة/تحديث/حذف/إدراج صفوف غيره (سياسات RLS)، ولا على إلغاء رمز غيره عبر الدالة.
- إعادة تسجيل الرمز نفسه أو تدويره لا تُنشئ ملكية نشطة ثانية.

**ملكية قفل outbox:**

- `aani_complete_notification_outbox` ترفض `p_worker` الفارغ (42501)، ولا تُنهي إلا مهمة `status = 'processing'` و`locked_by = p_worker` تماماً.
- مهمة بلا قفل، أو بقفل عامل آخر، أو مهمة أُعيد حجزها بعد انتهاء القفل: لا ينهيها العامل القديم.
- لا إنهاء مزدوج للمهمة نفسها، ويبقى Backoff و`provider_message_id`.

**تفضيلات الإشعارات (مفاتيح التطبيق الحقيقية):**

| الحدث | مفتاح التفضيل |
|---|---|
| الرسائل الخاصة | `messages` |
| المكالمات | `messages` (لا يوجد مفتاح `calls` مستقل) |
| إعجاب/تعليق/رد/إشارة/إعادة نشر | `interactions` |
| متابعة/طلب متابعة | `followers` |
| تفاعل قصة/رد قصة/إشارة قصة | `stories` |

- تعطيل الفئة يمنع Push الحدث فقط، ولا يمنع إنشاء سجل الإشعار في `public.notifications`.
- لا Push لفعل المستخدم على نفسه، والنوع غير المعروف يبقى يُرسل (لا تغيير للسلوك الحالي).
- الرسائل والمكالمات لا تدخل `public.notifications` أبداً (حارس 20261229 باقٍ).
