# Aani Social

نسخة ويب عربية مستقلة لتطبيق Aani الاجتماعي، مع منشورات وقصص ورسائل ومساعد محادثة.

## Run & Operate

- `bash scripts/dev-local.sh` — مسار التشغيل الوحيد أثناء التطوير (API على 8080 وواجهة Aani Social على 5000، تثبيت واحد للحزم ويوقف الخوادم القديمة تلقائياً).
- `pnpm --filter @workspace/aani-social run typecheck` — فحص TypeScript للواجهة.
- `pnpm --filter @workspace/aani-social run typecheck:edge` — فحص دوال Supabase.
- `pnpm --filter @workspace/aani-social run test:edge` — اختبارات HTTP محلية بمحاكاة الشبكة.
- `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/aani-social run build` — بناء الإنتاج.

المتغيرات المطلوبة للواجهة: `VITE_SUPABASE_URL` ومفتاح واجهة عام
`VITE_SUPABASE_PUBLISHABLE_KEY` أو `VITE_SUPABASE_ANON_KEY`. يعمل التخزين على
`aani-media` افتراضيًا، ويمكن تغييره عبر `VITE_SUPABASE_STORAGE_BUCKET`.

## Stack & Architecture

- React وVite وTypeScript داخل مساحة عمل pnpm.
- Supabase Auth وPostgres وStorage وRealtime عبر عميل المتصفح مباشرة.
- Gemini عبر Supabase Edge Function؛ لا يصل مفتاح Gemini إلى المتصفح.
- لا تستخدم واجهة Aani قاعدة Postgres التجريبية أو خادم API المبدئي في مساحة العمل.

## قواعد مهمة

- لا تنقل التطبيق إلى نظام مصادقة أو قاعدة بيانات أخرى؛ الاتصال المباشر بـSupabase جزء من المصدر.
- لا تُشغّل ترحيل قاعدة البيانات تلقائيًا. راجع الجداول وسياسات RLS للمشروع المستهدف أولًا؛ ترحيل الميزات مرفق لكنه لم يُطبّق.
- سر Gemini و`ALLOWED_ORIGINS` يضبطان في أسرار Supabase Edge Functions.
- ملف النشر `fix.js` واللقطة النصية التي احتوت اعتمادًا مضمّنًا استُبعدا ولم يُشغّلا؛ أكد المستخدم إلغاء الاعتماد المكشوف. لا تستعدهما من المصدر القديم.
- عند استخدام مشروع قائم، تحقق من اسم حاوية الوسائط؛ استخدم `VITE_SUPABASE_STORAGE_BUCKET=media` إذا كانت الحاوية الموجودة اسمها `media`.
- لا تُسجّل دخولًا أو تغييرات حيّة دون إعدادات Supabase الصحيحة وموافقة المالك على تغييرات قاعدة البيانات.

## نقاط مرجعية

- `artifacts/aani-social/src/App.tsx` — المسارات والواجهات وعمليات التطبيق.
- `artifacts/aani-social/src/lib/supabase.ts` — إعداد عميل Supabase وحاوية التخزين.
- `artifacts/aani-social/supabase/functions/_shared/gemini.ts` — عقد المساعد والتحقق من الطلب.
- `artifacts/aani-social/supabase/migrations/20261025000000_social_features.sql` — ترحيل اختياري غير مطبّق.
- `artifacts/aani-social/docs/SETUP_AR.md` — الإعداد والنشر والتحقق.
