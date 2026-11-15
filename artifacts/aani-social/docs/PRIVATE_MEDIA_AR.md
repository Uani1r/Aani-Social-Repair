# خصوصية الحساب الخاص — ما هو محمي فعلاً وما لا يزال مكشوفاً

هذا الملف يوثّق حدود الحماية بدقة، ولا يدّعي اكتمالاً غير قائم.

## 1) محمي على مستوى قاعدة البيانات

| البيانات | الآلية |
|---|---|
| منشورات `visibility = 'private'` | سياسة SELECT على `posts` عبر `aani_can_read_post` |
| منشورات الحساب الخاص | نفس الدالة: المالك أو متابع معتمد (صف في `follows`) |
| الحجب | `aani_posts_block_guard` + حرّاس `20270205000000` (restrictive) |
| تعليقات وإعجابات وتفاعلات المنشور | `aani_can_view_post_comments` + `aani_can_comment_on_post` |
| أعداد التفاعل (RPC) | `aani_post_interaction_rows` تفلتر الخصوصية، و`EXECUTE` مسحوب من `anon` |
| إعادة النشر والمشاركة | حرّاس restrictive على `reposts` و`post_shares` |
| قوائم المتابعين/المتابَعين | `aani_follows_private_read_guard` restrictive |
| قصص الحساب الخاص | `aani_can_view_story` (قائم من قبل) + `aani_stories_followers_guard` |
| أبرز القصص | `aani_can_view_profile_highlight` (قائم من قبل) |
| متابعة حساب خاص بلا موافقة | سياسة إدخال `follows` + `aani_respond_to_follow_request` |
| تفضيلات الحساب (`notification_settings`, `appearance_preference`, `language_preference`, `hd_uploads`, `data_saver`, `font_preference`, `fcm_token`) | سحب منح الأعمدة + `aani_my_preferences()` للمالك |
| `city`, `location`, `birth_date` | سحب منح الأعمدة + `aani_public_profile()` تُعيدها فارغة عند إطفاء `show_city` / `show_birth_date` |

## 2) غير محمي بالكامل — بصراحة

### أ) ملفات ImageKit

كل رفع المنشورات والقصص والريلز والمحادثات يذهب إلى ImageKit مباشرة
(`src/lib/storyUpload.ts`)، والرابط المخزَّن في `posts.media_url` /
`stories.media_url` رابط **عام** بصيغة `https://ik.imagekit.io/<id>/<path>`.

- **إخفاء المنشور في قاعدة البيانات لا يحمي الملف.** من يعرف الرابط المباشر
  (أو حصل عليه قبل أن يصبح الحساب خاصاً، أو من ذاكرة التخزين المؤقت للمتصفح،
  أو من CDN) يستطيع فتحه.
- ما أُضيف في هذا الفرع: مسار `/api/media/imagekit-sign` الذي يتحقق من الجلسة
  ومن `aani_can_read_media_object` ثم يُعيد رابطاً موقّعاً، والعميل يستخدمه
  عند تفعيل `VITE_IMAGEKIT_SIGNED_URLS=true` (`src/lib/mediaAccess.ts`).
- **لكن التوقيع لا يمنع الرابط العادي ما لم تُضبط الملفات على Restricted
  access في ImageKit** (أو تُرفع بـ `isPrivateFile: true`). راجع الخطوة 3.
- الملفات المرفوعة **قبل** التفعيل تبقى عامة؛ لا يمكن سحبها إلا بإعادة رفعها
  أو بتغيير إعداد الحساب إلى Restricted (وقد يؤثر على كل الملفات).

### ب) bucket `aani-media` في Supabase Storage

- **القاعدة الحيّة لا تحتوي bucket باسم `aani-media`**: كل الرفع الحالي يذهب
  إلى ImageKit. فملف التحويل اليدوي لا يفعل شيئاً هناك ويقول ذلك صراحةً.
- إن أُنشئ الـbucket لاحقاً من `schema.sql` (سطر 510–514) فسيكون عاماً، وفي
  bucket عام تُخدم الملفات من `/storage/v1/object/public/...` **بلا RLS**،
  فالسياسة `aani_media_objects_read_guard` (restrictive، في `20270206000000`)
  تحمي مسار Storage API فقط.
- الحماية الكاملة بالرابط المباشر تحتاج تحويل الـbucket إلى private:
  `supabase/APPLY_MANUALLY_20270206000000_media_bucket_private.sql` — يفحص
  وجوده أولاً ويُعلن النتيجة. **لم يُنفَّذ** لأنه يُبطل كل الروابط المخزّنة.
- عميل هذا الفرع يوقّع مسارات التخزين تلقائياً ويسقط إلى الرابط العام عند
  تعذّر التوقيع، فيمكن التحويل بعد نشر هذا العميل.

### ج) نسخ المتصفح وذاكرة CDN

أي وسائط عُرضت قبل أن يصبح الحساب خاصاً قد تبقى في كاش المتصفح أو CDN.
لا تتحكم قاعدة البيانات في ذلك.

## 3) خطوات تفعيل الحماية الكاملة لوسائط ImageKit

1. في ImageKit: **Settings → Security → Restrict unsigned URLs** للصور
   والفيديو (أو ارفع كل ملف جديد بـ `isPrivateFile: true`). بعدها لا يُخدم أي
   ملف بلا توقيع.
2. أضف `VITE_IMAGEKIT_SIGNED_URLS=true` إلى بيئة الواجهة.
3. تأكد أن `/api/media/imagekit-sign` منشور على الخادم (يحتاج
   `IMAGEKIT_URL_ENDPOINT` و`IMAGEKIT_PRIVATE_KEY` و`SUPABASE_*` للمشرف).
4. **اختبر الصحة فعلياً، لا وجود الرابط**: طلب التوقيع قد ينجح ويُنتج رابطاً
   مرفوضاً إن كانت الصيغة خاطئة. الاختبار الحقيقي:
   - رابط ملف قصة لحساب خاص **بلا** توقيع → 401.
   - الرابط الذي يُعيده `/api/media/imagekit-sign` بحساب متابع معتمد → 200.
   - نفس الرابط بعد تعديل `ik-t` إلى قيمة ماضية → 401.
   - نفس الرابط بعد تغيير حرف في المسار → 401 (التوقيع يغطي المسار).

### صيغة التوقيع المستخدمة

```
{urlEndpoint}/{relativePath}?ik-t={expire}&ik-s={signature}
signature = HMAC-SHA1(privateKey, relativePath + expire)  // hex صغير
relativePath = مسار الملف بعد حذف الـendpoint، مع بادئة التحويلات مثل tr:w-400/
```

مأخوذة من توثيق ImageKit الرسمي (Basic security features → How to generate
signed URLs). المسار يُرمَّز percent-encoding قبل التوقيع، والـendpoint قد
يحمل معرّف الحساب فيُحذف كاملاً قبل الحساب.

## 4) اختلاف القاعدة الحيّة عن الترحيلات — مسار التهيئة

سجل `supabase_migrations.schema_migrations` في القاعدة الحيّة لا يحتوي هذه
الترحيلات، ولا توجد فيها `follow_requests` ولا `user_blocks` ولا
`aani_is_user_blocked` ولا bucket `aani-media`. السبب المرجّح:

- القاعدة بُنيت من `schema.sql` / `fresh_schema_cloudflare_r2.sql` (سكربتات
  كاملة «Safe to re-run») لا من سلسلة `supabase/migrations`، وتلك السكربتات
  **لا تحتوي** `follow_requests` ولا `user_blocks` ولا `aani_is_user_blocked`
  ولا إنشاء bucket الوسائط.
- لذلك لا يجوز افتراض تطبيق أي ترحيل قديم، ولا إعادة تطبيقه عشوائياً.

**مسار التهيئة المتوافق (بدون SQL مني):**

1. شغّل استعلامات الفحص في نهاية هذا الملف على القاعدة الحيّة لتحديد ما هو
   موجود فعلاً (جداول، دوال، bucket، منح أعمدة).
2. طبّق فقط الترحيلات الناقصة بالترتيب: `20270203000000` ← `20270204000000`
   ← `20270205000000` ← `20270206000000`. كلها `if not exists` /
   `create or replace` / `drop policy if exists`، وتتحقق من متطلباتها وتُفشل
   نفسها برسالة واضحة إن غاب شيء.
3. `20270204000000` يُنشئ `follow_requests` و`user_blocks` و`aani_is_user_blocked`
   إن غابت، فلا حاجة لتطبيق `20261108000000`/`20261115000000` كاملة.
4. إن لم يكن bucket `aani-media` موجوداً، فالوسائط كلها على ImageKit ولا حاجة
   لسياسة Storage (تُتخطى بتحذير). أنشئ الـbucket فقط إن أردت مسار التخزين.

**استعلامات الفحص (قراءة فقط):**

```sql
select version from supabase_migrations.schema_migrations order by version;
select to_regclass('public.follow_requests'), to_regclass('public.user_blocks');
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname in
  ('aani_is_user_blocked','aani_can_read_post','aani_respond_to_follow_request',
   'aani_can_read_media_object','aani_my_preferences','aani_public_profile');
select id, public from storage.buckets where id = 'aani-media';
select column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and grantee = 'authenticated' and privilege_type = 'SELECT'
order by column_name;
-- منح service_role التي يحتاجها خادم الإشعارات (fcm_token, notification_settings)
select column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and grantee = 'service_role' and privilege_type = 'SELECT'
order by column_name;
```

## 5) ما تحتاجه service_role (ولا يُسحب)

`api-server/src/lib/supabaseAdmin.ts` يقرأ `fcm_token` و`notification_settings`
من `profiles` بمفتاح `service_role` لإرسال إشعارات الدفع. ترحيل
`20270206000000` يسحب منح الأعمدة من كل الأدوار المتصلة، ثم **يُعيد منح هذين
العمودين لـ`service_role` صراحةً** حتى لا يعتمد على منح جدول مسحوب. لا يُمنح
أي عمود آخر له، ولا يُمنح `anon` أو `authenticated` أي منهما.

