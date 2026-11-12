# فحص سريع: لماذا لا يظهر الريل بعد نجاح النشر؟

الغرض: مقارنة **ما يُحفظ فعلياً** في `public.posts` و`public.media_assets` مع **ما يبحث عنه كود العرض**
(`usePosts.ts` ← تبويب الريلز، و`ProfileReelsPlayer.tsx` ← ريلز الملف الشخصي).

شغّل الاستعلامات التالية في **Supabase → SQL Editor** (SQL Editor يعمل بدور `postgres` فيتجاوز RLS،
لذلك ما يظهر هنا هو البيانات الحقيقية بغض النظر عن السياسات).

## 1) آخر المنشورات (الحقول التي يقرأها تبويب الريلز)

```sql
select id,
       created_at,
       user_id,
       type,
       destination,
       visibility,
       left(coalesce(media_url, media_urls[1]), 120) as media_url,
       media_asset_id
from public.posts
order by created_at desc
limit 5;
```

المطلوب في صف الريل: `type = 'reel'` (أو `destination = 'reels'`)، و`media_url` غير فارغ.

## 2) استعلام الريلز نفسه (نفس شرط `usePosts`)

```sql
select id, type, destination, created_at
from public.posts
where type = 'reel' or destination = 'reels'
order by created_at desc
limit 10;
```

إذا ظهر الريل هنا ولم يظهر في التطبيق → المشكلة في قراءة التطبيق (RLS/GRANT/كاش)، لا في الحفظ.

## 3) سجلات الوسائط والمسارات (المعالجة FFmpeg)

```sql
select id, user_id, status, processing_status, original_path, video_url, poster_url, error_message, created_at
from public.media_assets
order by created_at desc
limit 5;
```

## 4) تأكيد أن الـ Bucket عام (روابط `getPublicUrl` تعمل فقط مع bucket عام)

```sql
select id, name, public from storage.buckets;
```

يجب أن يوجد `aani-media` (أو اسم `VITE_SUPABASE_STORAGE_BUCKET`) وقيمة `public = true`.

## 5) سياسات RLS على جدول posts

```sql
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'posts';
```

يجب أن توجد سياسة `SELECT` لدور `authenticated` تسمح بالقراءة
(مثل `user_id = auth.uid() or visibility = 'public'`).

## 6) صلاحيات الأعمدة لدور authenticated

```sql
select grantee, column_name
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'posts' and grantee = 'authenticated'
order by column_name;
```

يجب أن تحتوي على: `type`, `destination`, `media_url`, `media_urls`, `media_asset_id`,
`visibility`, `created_at`, `post_metadata`.

## 7) ما يطبعه التطبيق الآن (بعد هذا التحديث)

- عند النشر: `[reels] صف المنشور المحفوظ` مع قيم `type/destination/media_url` المقروءة من قاعدة البيانات.
- إن كان `destination` مختلفاً عن المطلوب: `[reels] destination المحفوظ لا يطابق المطلوب`.
- إن كان `media_url` فارغاً: `[reels] media_url فارغ في الصف المحفوظ`.
- إن مُنعت القراءة (RLS): `[reels] المنشور محفوظ لكن قراءته من posts أعادت لا شيء` + رسالة على الشاشة.
- عند فشل جلب الريلز: `[reels] فشل استعلام الريلز` مع `code/message/details/hint`،
  وتظهر الرسالة نفسها أعلى شاشة الريلز مع زر «إعادة المحاولة».
