# مطابقة ترحيلات المستودع مع سجل Supabase

## الحدود التي تحكم هذا التقرير

- **سجل Supabase لم يُقرأ.** محاولة `GET /v1/projects/auqqqwfjxrxizlmeweka/database/migrations`
  أعادت: «Supabase Management API did not accept its key». لذلك **لا يوجد جدول مطابقة كامل**
  لـ 135 ملفاً محلياً مقابل 51 سجلاً، ولا يمكن الجزم بأي ملف «مطبَّق» أو «غير مطبَّق» بلا هذا السجل.
- **لم يُنفَّذ أي SQL** على قاعدة البيانات في هذه الجولة، ولم يُعدَّل
  `supabase_migrations.schema_migrations`، ولم يُستخدم `db push`.
- **وجود جدول أو دالة ليس دليلاً على تطبيق ملف كامل**؛ لذلك لا يُعلن أي ملف مطبَّقاً بالكامل
  إلا بنتيجة استعلامات التحقق أدناه على القاعدة نفسها.

## أرقام مؤكدة

| البند | القيمة | المصدر |
|---|---|---|
| ملفات الترحيل المحلية قبل هذه الجولة | **135** | `list_files` على `supabase/migrations` |
| سجلات سجل Supabase | **51** | تقرير المستخدم، لم يُتحقق منه من الـAPI |
| ملفات تصحيحية جديدة في هذه الجولة | **5** | انظر أدناه |
| مطابقات مؤكدة برقم النسخة | **2 فقط** | من تاريخ هذه المحادثة |

### المطابقتان المؤكدتان

| الملف المحلي | نسخة سجل Supabase | الحالة |
|---|---|---|
| `20261124214847_profile_highlights_anon_rpc_acl_hardening.sql` (PR #104، أُعيد تسميته في `origin/main` برقم السجل نفسه) | `20261124214847` | مطبَّق في القاعدة، والفرق في رقم النسخة فقط |
| `20270225000000_harden_story_audience_and_likes.sql` | `20261124222528` | مطبَّق فعلياً ومسجّل؛ **لا يُعاد تطبيقه ولا تُنشأ نسخة مكررة منه** |

بقية **133** ملفاً محلياً و**49** سجلاً: **غير معروفة الحالة** حتى يُقرأ السجل.

## إصلاح أسماء جداول البلاغات

قاعدة البيانات تحتوي `public.reports` ولا تحتوي `public.post_reports` (كما في تقرير المستخدم،
ومدعوم محلياً في `20261027000001_post_reports.sql` و`schema.sql`).

- أعمدة `reports`: `post_id` / `reporter_id` / `reported_user_id` / `reason` / `status`
  — وهي نفس ما يرسله التطبيق (`post_id`, `reporter_id`, `reason`).
- سياساتها ومنحها قائمة (`aani_reports_select_own`, `aani_reports_insert_own`,
  `aani_reports_delete_own`, `aani_reports_update_own`، و`grant select, insert, update, delete`).
- التصحيح في `FeedPostCard.tsx` و`ReelSlide.tsx`: `from('post_reports')` → `from('reports')`.
  لا جدول جديد ولا تغيير في الأعمدة أو الـRLS.

## الترحيلات التصحيحية المضافة (آمنة لإعادة التطبيق)

كلها بنسخ **>`20261124222528`** (آخر نسخة معروفة في السجل) ولا تصطدم بأي ملف محلي:

| الملف | يعيد | الضمانة |
|---|---|---|
| `20261124230000_story_reports_reconcile.sql` | جدول `story_reports` + فهرسه + RLS + سياسة الإدراج | `create table if not exists` + `drop policy if exists` |
| `20261124230100_story_archive_rpc_reconcile.sql` | `aani_get_my_story_archive(integer, integer)` | `create or replace` + منح `authenticated` فقط |
| `20261124230200_unblock_user_rpc_reconcile.sql` | `aani_unblock_user(uuid)` | `create or replace` + `security definer` + يطابق `blocked_user_id` **أو** `blocked_id` (أو كليهما) بحسب الأعمدة الموجودة + يرفض الصفوف المتناقضة ويتحقق من عدم بقاء صف |
| `20261124230300_mark_all_notifications_as_read_reconcile.sql` | `mark_all_notifications_as_read()` | `create or replace` + `security invoker` |
| `20261124230400_random_trending_sounds_reconcile.sql` | `random_trending_sounds(integer)` | `create or replace` + `security invoker` (RLS على `sounds`) + volatile بلا `stable` (لأن `random()`) |

## إلغاء الحظر حين يوجد العمودان معاً

قاعدة الإنتاج تحتوي `blocked_user_id` و`blocked_id` في `public.user_blocks`، لكن وجود الأول
لا يعني أنه مملوء: الصفوف المكتوبة قبل `20270204000000` تحمل `blocked_user_id = NULL` وقيمة
`blocked_id` وحدها. الحذف على `blocked_user_id` وحده يطابق صفراً، فتبقى العلاقة القديمة قائمة
بلا إمكانية إلغائها: `aani_is_user_blocked` (يقرأ `blocked_user_id`) يراها غير موجودة، بينما
نسخة `aani_can_view_story` المنشورة تقرأ `blocked_id` وتواصل حجب القصص — وإعادة المحاولة لا
تُصلح شيئاً.

لذلك `aani_unblock_user`:

- يبني شرط الحذف من الأعمدة الموجودة فعلاً (`information_schema.columns`): عند وجودهما
  `(blocked_user_id = $2 or blocked_id = $2)`، وعند وجود واحد فقط العمود نفسه.
- يحصر الحذف في `blocker_id = المستدعي` دائماً.
- يتوقف بـ`23514` إن وُجد صف متناقض (أحد العمودين للمستهدف والآخر لقيمة غير فارغة مختلفة)
  بدل حذف علاقة مستخدم آخر.
- يعيد العدّ بعد الحذف ويرفع `42501` إن بقي صف — بدل إبلاغ الواجهة بنجاح كاذب (RLS، أو
  الصلاحيات، أو صف أُعيد إنشاؤه).

الصلاحيات المحلية: `grant select, insert, delete on public.user_blocks to authenticated`
(`20270204000000`:222)، والسياسة الوحيدة للقراءة (`aani_user_blocks_select_own`)، والدالة
`security definer` بمالك `postgres` فلا تمر بالـRLS — وفحص البقايا أعلاه هو الضمانة.

## تعريف `random_trending_sounds` موحَّد في الملفات الثلاثة

أُزيل `stable` من `20261124230400_random_trending_sounds_reconcile.sql`، ومن
`supabase/schema.sql`، ومن `20270112000000_random_trending_sounds.sql`؛ الوظيفة volatile
لأن `order by random()` يجب أن يُقيَّم في كل استدعاء. بقيت `security invoker` و
`set search_path = public, pg_temp` والمنح كما هي في الملفات الثلاثة.

## ما لم يُنفَّذ بعد (وبصراحة)

- **البند 3** `20261130000000_repost_share_live_counters.sql` (161 سطراً)، و**البند 4**
  `20261203000000_consume_view_once_messages.sql` (119)، و**البند 5**
  `20261205000000_message_reactions_reports_replies.sql` (241)، و**البند 6**
  `20261209000000_message_requests.sql` (301)، و**البند 8** `aani_block_user`: لم تُكتب
  ترحيلاتها في هذه الجولة؛ تحتاج قراءة كاملة للمخطط الحالي وتوقيعات الدوال قبل الكتابة.
- **البند 11 (انتهاء الرسائل)**: لم يُكتب الترحيل التوافقي. `message_conversation_settings`
  الموجود فيه `user_id, other_user_id, is_muted, updated_at`، والترحيلات القديمة تفترض
  `user_a, user_b, expiration_seconds` — إضافة الأعمدة وتوحيد الطرفين و`ON CONFLICT`
  و`messages.expires_at` و`message_global_settings` تحتاج مراجعة أعمدة حقيقية أولاً.
- `manual_global_message_expiration_repair.sql` لم يُستخدم، ولم يُعدَّل.

## استعلامات تحقق (تُنفَّذ قبل وبعد كل ترحيل)

```sql
-- الحالة الفعلية للأعمدة والجداول
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('reports','story_reports','message_conversation_settings',
                     'message_global_settings','messages','notifications','user_blocks',
                     'sounds','messages')
order by table_name, ordinal_position;

-- توقيعات الدوال المطلوبة
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('aani_get_my_story_archive','aani_unblock_user',
                    'mark_all_notifications_as_read','random_trending_sounds',
                    'aani_can_view_story');

-- الصلاحيات (يجب ألا يظهر anon على دوال authenticated)
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('aani_get_my_story_archive','aani_unblock_user',
                       'mark_all_notifications_as_read','random_trending_sounds');

-- السياسات
select tablename, policyname, cmd, roles
from pg_policies where schemaname = 'public'
  and tablename in ('story_reports','reports','notifications','sounds');
```

## ترتيب العمل المقترح للمطابقة

1. إدخال Management API key صالح، ثم قراءة `/v1/projects/auqqqwfjxrxizlmeweka/database/migrations`.
2. بناء جدول 135 × 51 بمطابقة الاسم ثم النسخة، وتمييز: مطبَّق، غير مطبَّق، مستبدل.
3. تسجيل الملفات المؤجلة في جدول `supabase_migrations.schema_migrations` عبر
   `migration repair --status applied <version>` فقط للملفات التي **تُثبت** استعلامات التحقق
   أن آثارها موجودة فعلاً، ولا يُكتب في الجدول يدوياً.
4. تطبيق الترحيلات التصحيحية الخمسة أعلاه بالترتيب الزمني بعد مراجعة نتائج التحقق.
5. إكمال البنود 3، 4، 5، 6، 8، 11 بعد قراءة المخطط الحقيقي.
6. لا `db push` قبل انتهاء 1–5.
