# إكمال التسجيل وسجل أسماء المستخدمين

مرجع سريع لما أُسِّس في ترحيل `20270314000000_profile_onboarding_and_username_registry.sql`، وما يلزم قبل تطبيقه، وما يبقى على الإدارة مستقبلاً.

## 1) القواعد النافذة لاسم المستخدم

| القاعدة | القيمة |
| --- | --- |
| الحد الأدنى | محرف واحد (كان 3) |
| الحد الأعلى | 32 محرفاً |
| المحارف | `a-z` و`0-9` و`_` و`.` — بلا مسافات |
| حالة الأحرف | تُخزَّن lowercase دائماً، والفريد على `lower(username)` |
| المسافة الطرفية | تُحذف بالتطبيع (`' a '` → `a`)، والداخلية (`a b`) مرفوضة |

مقبولة: `a`، `7`، `ab`، `12`، `123`، أرقام فقط، حروف فقط، مختلط، 32 محرفاً.
مرفوضة: `a b`، `user-name`، `user@name`، `مستخدم`، وفوق 32.

مصدر واحد في الواجهة: `src/lib/usernameRules.ts`. وفي قاعدة البيانات: `profiles_username_format_check` + `aani_normalize_username` + حارس `profiles.username`.

## 2) إكمال التسجيل

- `profiles.onboarding_completed_at` هو الفيصل. حساب Google الجديد يبدأ فارغاً → واجهة الإكمال وحدها (`src/pages/OnboardingPage.tsx`).
- الحفظ يمر بدالة واحدة: `aani_complete_onboarding(username, full_name, birth_date, gender, terms_version)`.
  تسجّل: الاسم الكامل، `birth_date`، الجنس، وقت الموافقة `terms_accepted_at`، إصدارها `terms_version`، ووقت الإكمال.
- الموافقة إلزامية: بلا `terms_version` ترفض الدالة بـ`22023`. والعميل لا يكتب أعمدة الموافقة أبداً (حارس `aani_profiles_onboarding_guard` + سحب منح الأعمدة).
- الحسابات القائمة عند تطبيق الترحيل تُهيَّأ مرة واحدة (`aani_schema_markers`) فلا يُفرض عليها إعادة تسجيل. إعادة تطبيق الترحيل لا تُكمل حساباً جديداً.
- البوابة في `src/lib/authGate.ts`: لا تطبيق قبل تحميل الملف، و`missing`/`failed` ليستا اكتمالاً، وغير المكتمل يرى الإكمال فقط حتى لو كان العنوان `/feed`.
- قبل تطبيق الترحيل تكون `aani_my_onboarding_state()` غير موجودة (`42883`)، فتُعامل الحسابات القائمة كاملة ولا يتعطّل أحد.

## 3) سجل الأسماء

`public.username_registry`:

| العمود | المعنى |
| --- | --- |
| `username` | الاسم المطبَّع (مفتاح أساسي) |
| `state` | `available` / `reserved` / `blocked` / `claimed` |
| `user_id` | المالك عند `claimed` فقط (قيد `username_registry_claim_shape`) |
| `reason` | سبب الحجز أو المنع أو المطالبة |
| `reserved_until` | نهاية الحجز المؤقت (`NULL` = حتى قرار إداري) |
| `actor_id`, `actor_kind` | من غيّر الحالة: `system` / `user` / `admin` |

`public.username_registry_audit`: صف لكل انتقال (مطالبة، إتاحة، حجز، منع) مع الحالة السابقة واللاحقة والحساب والسبب والوقت. الإضافة والقراءة لـ`service_role` فقط؛ لا تعديل ولا حذف.

## 4) الصلاحيات والدوال

| الكائن | الوصول |
| --- | --- |
| `username_registry`, `username_registry_audit` | RLS + `revoke all` من `public, anon, authenticated`؛ `service_role` وحدها |
| `aani_username_status(text)` | `authenticated` — تُعيد `available/reserved/blocked/claimed/self/invalid` |
| `aani_claim_username(text)` | `authenticated` — مطالبة ذرية، ترفض المحجوز/الممنوع/المأخوذ |
| `aani_complete_onboarding(...)` | `authenticated` — إغلاق الإكمال وتسجيل الموافقة |
| `aani_my_onboarding_state()` | `authenticated` — صف صاحبه وحده |
| `aani_normalize_username(text)` | تنقية الاسم، بلا مطالبة |

لا تُشتق الإدارة من `user_metadata` ولا `app_metadata`. لا سياسة على الجدولين تمنح `authenticated` شيئاً.

## 5) ما يبقى على الإدارة (لم يُنفَّذ هنا)

- تطبيق الترحيل يدوياً في Supabase بعد المراجعة.
- دالة Edge إدارية محمية (أو أداة بـ`service_role`) لتغيير `state` و`reason` و`reserved_until` و`user_id`، وكل تغيير منها يجب أن يكتب صفاً في `username_registry_audit` بـ`actor_kind='admin'` و`actor_id` للإدارة.
- لوحة إدارة تعرض السجل والتدقيق وتتيح الحجز والمنع والإتاحة.
- قرار سياسة حول متجر اسم محجوز/ممنوع لمستخدم يحمله أصلاً: الحارس لا يمنع إعادة حفظ الاسم نفسه، وإجباره على تغييره قرار إداري (أداة مستقبلية).

## 6) التحقق المتاح

- `artifacts/aani-social/src/lib/usernameRules.test.ts` و`usernameAvailability.test.ts` و`profileCompletion.test.ts` و`onboarding.test.ts` و`authGate.test.ts` و`usernameRegistryGuard.test.ts`.
- `artifacts/aani-social/supabase/tests/username_registry_onboarding.test.sql` على قاعدة CI مؤقتة (job `Username registry and onboarding SQL`): البنية، القيد، التطبيع، الرفض، التفرد، السباق، المحجوز والممنوع، عدم التجاوز من REST، الموافقة، التدقيق، التهيئة مرة واحدة، وتحرير الاسم عند حذف الحساب.
